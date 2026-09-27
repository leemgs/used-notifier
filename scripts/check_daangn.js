'use strict';

/**
 * 메인 실행 스크립트 (GitHub Actions 에서 주기적으로 실행).
 *
 * 1) config/watches.json 의 각 감시 항목(watch)을 읽는다.
 * 2) 당근마켓에서 키워드로 검색하고 지역으로 필터링한다.
 * 3) state/seen.json 과 비교하여 "신규" 매물만 골라낸다.
 * 4) 신규 매물이 있으면 지정 이메일로 알림을 보낸다.
 * 5) state/seen.json 을 갱신한다 (워크플로가 커밋).
 *
 * 환경변수:
 *   DRY_RUN=true  이면 이메일을 실제로 보내지 않고 콘솔에만 출력한다.
 */

const fs = require('fs');
const path = require('path');
const { sendNewItemsEmail } = require('./mailer');
const { createIssue, reportEmailFailure } = require('./github');
const { SOURCES, watchSites } = require('./sources');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'config', 'watches.json');
const STATE_PATH = path.join(ROOT, 'state', 'seen.json');

// 감시 항목당 상태에 보관하는 최대 매물 ID 개수 (파일 비대화 방지, 안전 상한)
const MAX_SEEN_PER_WATCH = 3000;
// 마지막으로 본 지 이 일수를 넘긴 매물 기록은 삭제한다. 이 기간 안에 매물이 계속
// 노출되면 last-seen 날짜가 갱신되어 만료되지 않으므로 재알림이 생기지 않는다.
// (예전 500개 개수 제한은 매물이 많을 때 아직 판매 중인 매물을 밀어내 재알림을 유발했다.)
const SEEN_RETENTION_DAYS = Number(process.env.SEEN_RETENTION_DAYS) > 0
  ? Number(process.env.SEEN_RETENTION_DAYS)
  : 30;

// 한국 시간(Asia/Seoul, UTC+9·DST 없음) 기준 오늘 날짜 'YYYY-MM-DD'.
function kstDay(ms = Date.now()) {
  return new Date(ms + 9 * 3600000).toISOString().slice(0, 10);
}

// 두 'YYYY-MM-DD' 사이의 일수 차(b - a). 파싱 불가하면 Infinity(=매우 오래됨).
function daysBetweenDays(a, b) {
  const da = Date.parse(`${a}T00:00:00Z`);
  const db = Date.parse(`${b}T00:00:00Z`);
  if (!Number.isFinite(da) || !Number.isFinite(db)) return Infinity;
  return Math.round((db - da) / 86400000);
}

// 상태 항목을 {id: 'YYYY-MM-DD'} 맵으로 정규화한다.
//  - 구버전 배열([id,...]) → 각 id 를 오늘 날짜로 승격(마이그레이션 시 대량 재알림 방지)
//  - 객체 → 문자열 날짜 값만 얕은 복사
function normalizeSeen(entry, today) {
  const map = {};
  if (Array.isArray(entry)) {
    for (const id of entry) if (id != null) map[String(id)] = today;
  } else if (entry && typeof entry === 'object') {
    for (const k of Object.keys(entry)) if (typeof entry[k] === 'string') map[k] = entry[k];
  }
  return map;
}

// 보존 기간이 지난 기록을 삭제하고, 안전 상한을 초과하면 오래된 기록부터 제거한다.
// 실제로 무언가 삭제되면 true 를 반환한다.
function pruneSeen(map, today, retentionDays = SEEN_RETENTION_DAYS, maxCount = MAX_SEEN_PER_WATCH) {
  let changed = false;
  for (const k of Object.keys(map)) {
    if (daysBetweenDays(map[k], today) > retentionDays) {
      delete map[k];
      changed = true;
    }
  }
  const keys = Object.keys(map);
  if (maxCount && keys.length > maxCount) {
    keys.sort((a, b) => (map[a] < map[b] ? -1 : map[a] > map[b] ? 1 : 0)); // 오래된 날짜 먼저
    for (const k of keys.slice(0, keys.length - maxCount)) {
      delete map[k];
      changed = true;
    }
  }
  return changed;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function watchId(watch, index) {
  return watch.id || `${watch.keyword}__${watch.location}__${index}`;
}

// 이메일 값을 정규화한다. 문자열/쉼표(세미콜론/공백)구분/배열을 모두 허용.
function splitEmails(value) {
  if (!value) return [];
  const arr = Array.isArray(value) ? value : String(value).split(/[,;\s]+/);
  const seen = new Set();
  const out = [];
  for (const raw of arr) {
    const e = String(raw).trim();
    if (e && !seen.has(e.toLowerCase())) {
      seen.add(e.toLowerCase());
      out.push(e);
    }
  }
  return out;
}

// watch.email 을 우선 사용하고, 없으면 defaultEmail 로 폴백해 수신자 배열을 만든다.
function resolveRecipients(watchEmail, defaultEmail) {
  const primary = splitEmails(watchEmail);
  return primary.length ? primary : splitEmails(defaultEmail);
}

// 동시 실행 개수를 제한하며 비동기 작업을 처리한다(입력 순서대로 결과 반환).
// 검색은 네트워크 대기가 대부분이라 병렬로 돌리면 전체 실행 시간이 크게 준다.
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const size = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: size }, async () => {
    while (next < items.length) {
      const cur = next++;
      results[cur] = await fn(items[cur], cur);
    }
  });
  await Promise.all(workers);
  return results;
}

async function main() {
  const dryRun = process.env.DRY_RUN === 'true';
  const config = readJson(CONFIG_PATH, null);

  if (!config || !Array.isArray(config.watches) || config.watches.length === 0) {
    console.log('감시 항목이 없습니다. config/watches.json 을 확인하세요.');
    return;
  }

  // 알림 채널 on/off (config 에서 명시적으로 false 로 꺼야 비활성)
  const wantEmail = config.sendEmail !== false;
  const wantIssue = config.createIssues !== false;

  const state = readJson(STATE_PATH, {});
  let stateChanged = false;
  let totalNew = 0;
  const errors = [];
  // 이메일 발송 실패를 GitHub 이슈로 기록했는지 여부(실행당 1회만 시도해 중복 방지).
  let emailFailureReported = false;

  // 처리할 (감시항목 × 사이트) 작업 목록을 원래 순서대로 만든다.
  const tasks = [];
  for (let i = 0; i < config.watches.length; i++) {
    const watch = config.watches[i];
    if (watch.enabled === false) continue;

    const id = watchId(watch, i);
    const to = resolveRecipients(watch.email, config.defaultEmail);
    const chatMessage =
      watch.chatMessage || config.defaultChatMessage || '안녕하세요. 제가 구매 가능할까요?';

    if (!watch.keyword) {
      console.warn(`[${id}] keyword 가 없어 건너뜁니다.`);
      continue;
    }
    if (!to.length) {
      console.warn(`[${id}] 수신 이메일(email)이 없어 건너뜁니다.`);
      continue;
    }

    const hasMaxPrice =
      Object.prototype.hasOwnProperty.call(watch, 'maxPrice') && watch.maxPrice !== '' && watch.maxPrice != null;
    const priceNote = hasMaxPrice
      ? Number(watch.maxPrice) === 0
        ? ` 희망가='무료(당근 나눔, 중고나라·번개장터 0원)'`
        : ` 희망가='≤${Number(watch.maxPrice).toLocaleString('ko-KR')}원'`
      : '';

    for (const siteKey of watchSites(watch)) {
      const source = SOURCES[siteKey];
      if (!source) continue;
      tasks.push({ watch, id, to, chatMessage, priceNote, siteKey, source });
    }
  }

  // 검색(네트워크 대기)은 동시 실행 개수를 제한해 병렬로 수행한다(전체 실행 시간 단축).
  // 알림 발송·상태 갱신 같은 부작용은 아래에서 원래 순서대로 순차 처리한다.
  const concurrency = Number(process.env.SEARCH_CONCURRENCY) > 0 ? Number(process.env.SEARCH_CONCURRENCY) : 4;
  await mapLimit(tasks, concurrency, async (t) => {
    try {
      t.found = await t.source.search(t.watch);
    } catch (err) {
      t.error = err;
    }
  });

  // 알림/상태 처리(순차): 검색 결과를 원래 순서대로 확인해 신규 매물을 알린다.
  for (const t of tasks) {
    const { watch, id, to, chatMessage, priceNote, siteKey, source } = t;
    // 상태는 (감시항목 × 사이트) 별로 분리. 당근은 과거 flat 키(state[id])를 폴백으로 읽는다.
    const stateKey = `${id}::${siteKey}`;
    const legacy = siteKey === 'daangn' ? state[id] : undefined;

    console.log(
      `\n▶ [${source.name}] 키워드='${watch.keyword}' 지역='${watch.location || '(전체)'}'${priceNote} → ${to.join(', ')}`
    );

    if (t.error) {
      console.error(`  ✖ 검색 실패: ${t.error.message}`);
      errors.push(`${id}/${siteKey}: ${t.error.message}`);
      continue;
    }
    const found = t.found;

    console.log(`  조건 일치 매물: ${found.length}건`);

    // 상태를 {id: 마지막으로 알린 날짜(KST)} 맵으로 다룬다. "매일 1회 리마인더":
    // 같은 매물이라도 하루(한국 시간 기준)에 한 번만 알린다. 계속 노출되는 매물은
    // 매일 한 번씩 다시 알림받고(리마인더), 같은 날 여러 번 실행돼도 중복 알림은 없다.
    // 판매되어 사라지면 보존기간 이후 기록이 삭제된다.
    const today = kstDay();
    const prevRaw = state[stateKey] != null ? state[stateKey] : legacy;
    const seenMap = normalizeSeen(prevRaw, today);
    let changed = Array.isArray(prevRaw); // 구버전(배열) → 객체 마이그레이션도 변경으로 간주

    // 오늘 아직 알리지 않은 매물(기록 날짜가 오늘이 아님)만 알린다.
    // 구버전 배열에서 마이그레이션된 항목은 오늘 날짜로 승격되어 첫날 중복 알림을 막는다.
    const newItems = found.filter((it) => it.id != null && seenMap[it.id] !== today);

    // 상태 맵을 정리(만료·상한)하고, 변경이 있으면 저장 대상으로 표시하는 헬퍼.
    const persist = () => {
      if (pruneSeen(seenMap, today)) changed = true;
      if (changed) {
        state[stateKey] = seenMap;
        stateChanged = true;
      }
    };

    if (newItems.length === 0) {
      console.log('  신규 매물 없음.');
      persist();
      continue;
    }

    console.log(`  ✨ 신규 매물 ${newItems.length}건 발견`);
    totalNew += newItems.length;

    if (dryRun) {
      newItems.forEach((it) =>
        console.log(`    - ${it.title} | ${it.price} | ${it.region} | ${it.url}`)
      );
      // DRY_RUN 에서는 알림/상태갱신을 하지 않는다.
      continue;
    }

    // 두 채널(이슈/이메일)을 각각 시도한다. 하나라도 성공하면 "알림함"으로 간주.
    let notified = false;

    if (wantIssue) {
      try {
        const issue = await createIssue({ watch, items: newItems, chatMessage, source });
        console.log(`  🐙 GitHub 이슈 등록 완료 → #${issue.number} ${issue.html_url}`);
        notified = true;
      } catch (err) {
        console.error(`  ✖ 이슈 등록 실패: ${err.message}`);
        errors.push(`${id}/${siteKey} 이슈: ${err.message}`);
      }
    }

    if (wantEmail) {
      try {
        await sendNewItemsEmail({ to, watch, items: newItems, chatMessage, source });
        console.log(`  ✉ 이메일 발송 완료 → ${to.join(', ')}`);
        notified = true;
      } catch (err) {
        console.error(`  ✖ 이메일 발송 실패: ${err.message}`);
        errors.push(`${id}/${siteKey} 이메일: ${err.message}`);
        // 이메일 실패 사실을 GitHub 이슈로 남긴다(실행당 1회, 열린 이슈 있으면 생략).
        if (!emailFailureReported) {
          emailFailureReported = true; // 재시도 루프에서 중복 호출 방지
          try {
            const fi = await reportEmailFailure({ to, watch, source, error: err });
            if (fi.deduped) {
              console.warn(`  ℹ 이메일 실패 이슈가 이미 열려 있습니다 → #${fi.number} ${fi.html_url}`);
            } else {
              console.warn(`  🐙 이메일 실패를 이슈로 등록했습니다 → #${fi.number} ${fi.html_url}`);
            }
          } catch (reportErr) {
            console.error(`  ✖ 실패 이슈 등록도 실패: ${reportErr.message}`);
            errors.push(`${id}/${siteKey} 실패이슈: ${reportErr.message}`);
          }
        }
      }
    }

    if (!notified) {
      // 모든 알림 채널이 실패하면 신규 매물은 기록하지 않아 다음 실행 때 재시도한다.
      // (이미 본 매물의 날짜 갱신/만료 정리는 반영해도 안전하다.)
      console.warn('  ⚠ 알림 실패로 상태를 갱신하지 않습니다(다음 실행에 재시도).');
      persist();
      continue;
    }

    // 알림 성공: 신규 매물을 오늘 날짜로 기록한다.
    for (const it of newItems) if (it.id != null) seenMap[it.id] = today;
    changed = true;
    persist();
  }

  // DRY_RUN 에서는 상태 파일을 절대 변경하지 않는다(부작용 없음).
  if (stateChanged && !dryRun) {
    writeJson(STATE_PATH, state);
    console.log(`\n상태 저장됨: ${path.relative(ROOT, STATE_PATH)}`);
  }

  console.log(`\n완료. 신규 매물 총 ${totalNew}건.`);

  if (errors.length > 0) {
    console.error(`\n오류 ${errors.length}건 발생:`);
    errors.forEach((e) => console.error(`  - ${e}`));
    process.exitCode = 1;
  }
}

// 직접 실행할 때만 점검을 수행한다(테스트에서 헬퍼만 require 할 수 있도록).
if (require.main === module) {
  main().catch((err) => {
    console.error('예기치 못한 오류:', err);
    process.exit(1);
  });
}

module.exports = { kstDay, daysBetweenDays, normalizeSeen, pruneSeen };

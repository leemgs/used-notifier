'use strict';

/**
 * 감시 목록(config/watches.json) 웹 관리자.
 * 서버 없이 브라우저에서 GitHub Contents API 로 직접 읽고 커밋한다.
 */

const CONFIG_PATH = 'config/watches.json';
const LS_TOKEN = 'cma_token';
const LS_REPO = 'cma_repo';
const LS_BRANCH = 'cma_branch';
// 저장소를 Pages URL(owner.github.io/repo)에서 유추 → 레포 이름변경에도 안전.
const DEFAULT_REPO = (function () {
  try {
    const host = location.hostname;
    const seg = location.pathname.split('/').filter(Boolean)[0];
    if (host.endsWith('github.io') && seg) return host.split('.')[0] + '/' + seg;
  } catch (_) {}
  return 'leemgs/used-notifier';
})();
const DEFAULT_BRANCH = 'main';

// 사이트(소스) 메타
const SITE_META = { daangn: '🥕 당근마켓', joongna: '🟢 중고나라', bunjang: '⚡ 번개장터' };
const ALL_SITES = ['daangn', 'joongna', 'bunjang'];
// watch.sites 정규화 (미지정 → 전체)
function watchSitesOf(w) {
  const s = Array.isArray(w && w.sites) ? w.sites.filter((k) => SITE_META[k]) : [];
  return s.length ? s : ALL_SITES.slice();
}

// ------- 상태 -------
let data = null; // watches.json 전체 객체
let fileSha = null; // 커밋 시 필요한 현재 파일 sha
let currentPage = 1;

// ------- DOM -------
const $ = (id) => document.getElementById(id);
const tokenEl = $('token');
const repoEl = $('repo');
const branchEl = $('branch');
const connStatus = $('conn-status');
const saveStatus = $('save-status');
const tbody = $('watch-tbody');
const searchEl = $('watch-search');
const pageSizeEl = $('page-size');
const paginationEl = $('watch-pagination');

// 지역 선택 드롭다운(시/도 → 시/군/구)
const regionPicker = createRegionPicker($('f-sido'), $('f-sigungu'), $('f-dong'));

// ------- 이메일 다중 수신 처리 -------
// 문자열/쉼표(세미콜론/공백)구분/배열 입력을 정규화된 배열로 변환.
function parseEmails(value) {
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
// 배열/문자열을 입력창·표에 보여줄 쉼표구분 문자열로.
function formatEmails(value) {
  return parseEmails(value).join(', ');
}
// 저장용: 여러 개면 배열, 1개면 문자열, 없으면 undefined.
function emailsToStore(value) {
  const list = parseEmails(value);
  if (list.length === 0) return undefined;
  return list.length === 1 ? list[0] : list;
}

// ------- 희망 금액(maxPrice) 처리 -------
// 입력 문자열에서 숫자만 뽑아 정수(원)로. 없으면 undefined.
function parseMaxPrice(value) {
  if (value == null) return undefined;
  const digits = String(value).replace(/[^\d]/g, '');
  if (!digits) return undefined;
  const n = parseInt(digits, 10);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}
// 표시용: 100000 → "100,000원 이하", 0 → "무료만", 없으면 "-"
function formatMaxPrice(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return '';
  return n === 0 ? '무료만 (나눔/0원)' : n.toLocaleString('ko-KR') + '원 이하';
}

// ------- 초기화: 저장된 값 복원 -------
tokenEl.value = localStorage.getItem(LS_TOKEN) || '';
repoEl.value = localStorage.getItem(LS_REPO) || DEFAULT_REPO;
branchEl.value = localStorage.getItem(LS_BRANCH) || DEFAULT_BRANCH;

// ------- UTF-8 안전 base64 -------
function utf8ToB64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin);
}
function b64ToUtf8(b64) {
  const bin = atob(String(b64).replace(/\s/g, ''));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

// ------- GitHub API -------
function apiBase() {
  return `https://api.github.com/repos/${repoEl.value.trim()}/contents/${CONFIG_PATH}`;
}
function authHeaders() {
  return {
    Authorization: `Bearer ${tokenEl.value.trim()}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

async function loadFile() {
  const branch = branchEl.value.trim() || DEFAULT_BRANCH;
  const res = await fetch(`${apiBase()}?ref=${encodeURIComponent(branch)}`, {
    headers: authHeaders(),
  });
  if (res.status === 404) {
    // 파일이 아직 없으면 빈 구조로 시작
    fileSha = null;
    return {
      $schema: './watches.schema.json',
      defaultEmail: '',
      defaultChatMessage: '안녕하세요. 제가 구매 가능할까요?',
      watches: [],
    };
  }
  if (!res.ok) throw new Error(await errMsg(res));
  const json = await res.json();
  fileSha = json.sha;
  const parsed = JSON.parse(b64ToUtf8(json.content));
  if (!Array.isArray(parsed.watches)) parsed.watches = [];
  return parsed;
}

async function saveFile(message) {
  const branch = branchEl.value.trim() || DEFAULT_BRANCH;
  const body = {
    message,
    content: utf8ToB64(JSON.stringify(data, null, 2) + '\n'),
    branch,
  };
  if (fileSha) body.sha = fileSha;
  const res = await fetch(apiBase(), {
    method: 'PUT',
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await errMsg(res));
  const json = await res.json();
  fileSha = json.content.sha; // 다음 저장을 위해 sha 갱신
}

async function errMsg(res) {
  let detail = '';
  try {
    const j = await res.json();
    detail = j.message || '';
  } catch (_) {}
  if (res.status === 401) return '인증 실패(401): 토큰이 올바른지 확인하세요.';
  if (res.status === 403) return '권한 없음(403): 토큰에 Contents 쓰기 권한이 있는지 확인하세요.';
  if (res.status === 404) return '저장소/경로를 찾을 수 없음(404): owner/repo 와 브랜치를 확인하세요.';
  if (res.status === 409) return '충돌(409): 파일이 그 사이 변경되었습니다. 다시 불러온 뒤 저장하세요.';
  return `오류 ${res.status}: ${detail}`;
}

// ------- 렌더링 -------
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
  }[c]));
}

function searchableText(w) {
  return [
    w.keyword,
    w.location,
    formatMaxPrice(w.maxPrice),
    formatEmails(w.email),
    w.chatMessage,
    ...watchSitesOf(w).map((key) => SITE_META[key]),
  ].join(' ').toLocaleLowerCase('ko-KR');
}

function renderPagination(pageCount) {
  paginationEl.innerHTML = '';
  paginationEl.classList.toggle('hidden', pageCount <= 1);
  if (pageCount <= 1) return;

  const addButton = (label, page, disabled, current) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'page-button' + (current ? ' current' : '');
    button.textContent = label;
    button.disabled = disabled;
    button.dataset.page = page;
    if (current) button.setAttribute('aria-current', 'page');
    paginationEl.appendChild(button);
  };

  addButton('‹ 이전', currentPage - 1, currentPage === 1, false);
  for (let page = 1; page <= pageCount; page += 1) {
    addButton(String(page), page, false, page === currentPage);
  }
  addButton('다음 ›', currentPage + 1, currentPage === pageCount, false);
}

function render() {
  $('defaults-card').classList.remove('hidden');
  $('list-card').classList.remove('hidden');
  $('save-card').classList.remove('hidden');

  $('default-email').value = formatEmails(data.defaultEmail);
  $('default-msg').value = data.defaultChatMessage || '';
  $('opt-email').checked = data.sendEmail !== false;
  $('opt-issue').checked = data.createIssues !== false;

  const watches = data.watches;
  const query = searchEl.value.trim().toLocaleLowerCase('ko-KR');
  const filtered = watches
    .map((watch, index) => ({ watch, index }))
    .filter(({ watch }) => !query || searchableText(watch).includes(query));
  const pageSize = Number(pageSizeEl.value) || 10;
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  currentPage = Math.min(Math.max(currentPage, 1), pageCount);
  const pageItems = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  $('count').textContent = watches.length;
  tbody.innerHTML = '';

  pageItems.forEach(({ watch: w, index: i }) => {
    const tr = document.createElement('tr');
    const emails = parseEmails(w.email);
    const emailCell = emails.length
      ? emails.map((e) => `<span class="email-chip">${esc(e)}</span>`).join('') +
        (emails.length > 1 ? `<span class="email-count">${emails.length}명</span>` : '')
      : '<span class="muted-hint">(기본값)</span>';
    tr.innerHTML = `
      <td><input type="checkbox" data-toggle="${i}" ${w.enabled === false ? '' : 'checked'}></td>
      <td><b>${esc(w.keyword)}</b></td>
      <td>${watchSitesOf(w).map((k) => `<span class="chip site-chip site-${k}">${esc(SITE_META[k])}</span>`).join('')}</td>
      <td>${esc(w.location)}</td>
      <td class="muted-cell">${w.maxPrice !== undefined ? esc(formatMaxPrice(w.maxPrice)) : '-'}</td>
      <td class="email-cell">${emailCell}</td>
      <td class="muted-cell">${esc(w.chatMessage || '(기본값)')}</td>
      <td class="actions">
        <button type="button" class="mini" data-edit="${i}">수정</button>
        <button type="button" class="mini danger" data-del="${i}">삭제</button>
      </td>`;
    tbody.appendChild(tr);
  });

  $('empty-note').classList.toggle('hidden', watches.length > 0);
  $('no-results-note').classList.toggle('hidden', watches.length === 0 || filtered.length > 0);
  renderPagination(pageCount);
}

searchEl.addEventListener('input', () => {
  currentPage = 1;
  render();
});
pageSizeEl.addEventListener('change', () => {
  currentPage = 1;
  render();
});
paginationEl.addEventListener('click', (e) => {
  const page = Number(e.target.dataset.page);
  if (!page || e.target.disabled) return;
  currentPage = page;
  render();
  $('list-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
});

// ------- 이벤트: 연결/불러오기 -------
$('conn-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!tokenEl.value.trim()) return setStatus(connStatus, '토큰을 입력하세요.', 'err');
  localStorage.setItem(LS_TOKEN, tokenEl.value.trim());
  localStorage.setItem(LS_REPO, repoEl.value.trim());
  localStorage.setItem(LS_BRANCH, branchEl.value.trim());
  setStatus(connStatus, '불러오는 중...', '');
  try {
    data = await loadFile();
    render();
    setStatus(connStatus, `✅ 불러오기 완료 (${data.watches.length}개 항목)`, 'ok');
  } catch (err) {
    setStatus(connStatus, '✖ ' + err.message, 'err');
  }
});

$('clear-token-btn').addEventListener('click', () => {
  localStorage.removeItem(LS_TOKEN);
  tokenEl.value = '';
  setStatus(connStatus, '토큰을 이 브라우저에서 삭제했습니다.', 'ok');
});

// ------- 이벤트: 목록 조작(수정/삭제/토글) -------
tbody.addEventListener('click', (e) => {
  const editI = e.target.getAttribute('data-edit');
  const delI = e.target.getAttribute('data-del');
  if (editI !== null && editI !== undefined && e.target.dataset.edit) openEdit(+editI);
  if (delI !== null && delI !== undefined && e.target.dataset.del) {
    const i = +delI;
    if (confirm(`'${data.watches[i].keyword}' 항목을 삭제할까요?`)) {
      data.watches.splice(i, 1);
      render();
    }
  }
});
tbody.addEventListener('change', (e) => {
  const t = e.target.getAttribute('data-toggle');
  if (t !== null) data.watches[+t].enabled = e.target.checked;
});

// ------- 이벤트: 기본값 입력 반영 -------
$('default-email').addEventListener('input', (e) => (data.defaultEmail = emailsToStore(e.target.value) || ''));
$('default-msg').addEventListener('input', (e) => (data.defaultChatMessage = e.target.value.trim()));
$('opt-email').addEventListener('change', (e) => (data.sendEmail = e.target.checked));
$('opt-issue').addEventListener('change', (e) => (data.createIssues = e.target.checked));

// ------- 이벤트: 추가/수정 폼 -------
function slugId(keyword, location) {
  const base = `${keyword}-${location}`.toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, '-').replace(/^-+|-+$/g, '');
  return base || 'watch';
}

function openEdit(index) {
  const isNew = index < 0;
  $('edit-card').classList.remove('hidden');
  $('edit-title').textContent = isNew ? '항목 추가' : '항목 수정';
  $('edit-index').value = index;
  const w = isNew ? {} : data.watches[index];
  $('f-keyword').value = w.keyword || '';
  const sel = watchSitesOf(w);
  document.querySelectorAll('input[name="f-site"]').forEach((el) => {
    el.checked = sel.includes(el.value);
  });
  regionPicker.setValue(w.location || '');
  $('f-maxprice').value = w.maxPrice !== undefined ? Number(w.maxPrice).toLocaleString('ko-KR') : '';
  $('f-free-share').checked = Number(w.maxPrice) === 0 && w.maxPrice !== undefined;
  $('f-maxprice').disabled = $('f-free-share').checked;
  $('f-email').value = formatEmails(w.email);
  $('f-msg').value = w.chatMessage || '';
  $('f-enabled').checked = w.enabled !== false;
  $('edit-card').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

$('add-btn').addEventListener('click', () => openEdit(-1));
$('edit-cancel').addEventListener('click', () => $('edit-card').classList.add('hidden'));

// 희망 금액 입력 시 천단위 콤마 자동 표시
$('f-maxprice').addEventListener('input', (e) => {
  const n = parseMaxPrice(e.target.value);
  e.target.value = n ? n.toLocaleString('ko-KR') : e.target.value.replace(/[^\d]/g, '');
  $('f-free-share').checked = e.target.value === '0';
  e.target.disabled = $('f-free-share').checked;
});

$('f-free-share').addEventListener('change', (e) => {
  if (e.target.checked) $('f-maxprice').value = '0';
  else if ($('f-maxprice').value === '0') $('f-maxprice').value = '';
  $('f-maxprice').disabled = e.target.checked;
});

$('edit-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const index = +$('edit-index').value;
  const keyword = $('f-keyword').value.trim();
  const location = regionPicker.getValue();
  const entry = {
    id: slugId(keyword, location),
    keyword,
    location,
    sites: (function () {
      const chosen = Array.from(document.querySelectorAll('input[name="f-site"]:checked')).map((el) => el.value);
      // 전체(또는 미선택)면 생략 → 기본 전체. 일부만 선택 시 명시.
      return chosen.length && chosen.length < ALL_SITES.length ? chosen : undefined;
    })(),
    maxPrice: $('f-free-share').checked ? 0 : parseMaxPrice($('f-maxprice').value),
    email: emailsToStore($('f-email').value),
    chatMessage: $('f-msg').value.trim() || undefined,
    enabled: $('f-enabled').checked,
  };
  // undefined 필드 제거
  Object.keys(entry).forEach((k) => entry[k] === undefined && delete entry[k]);

  if (index < 0) data.watches.push(entry);
  else data.watches[index] = entry;

  $('edit-card').classList.add('hidden');
  render();
});

// ------- 이벤트: 저장(커밋) -------
$('save-btn').addEventListener('click', async () => {
  if (!data) return;
  setStatus(saveStatus, '저장 중...', '');
  try {
    await saveFile('chore: 웹 관리자에서 감시 목록 업데이트');
    setStatus(saveStatus, '✅ GitHub에 저장 완료! 다음 실행부터 반영됩니다.', 'ok');
  } catch (err) {
    setStatus(saveStatus, '✖ ' + err.message, 'err');
  }
});

function setStatus(el, msg, kind) {
  el.textContent = msg;
  el.className = 'status' + (kind ? ' ' + kind : '');
}

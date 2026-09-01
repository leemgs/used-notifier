'use strict';

/**
 * 신규 매물을 GitHub 이슈로 등록하는 모듈.
 *
 * GitHub Actions 에서 자동 제공되는 환경변수를 사용한다.
 *   GITHUB_TOKEN       워크플로 토큰 (issues: write 권한 필요)
 *   GITHUB_REPOSITORY  "owner/repo" 형식
 *   GITHUB_API_URL     (선택) 기본값 https://api.github.com
 */

const { chatHelperLink } = require('./links');

const ISSUE_LABEL = '당근마켓-알림';
// 이메일(Gmail SMTP) 발송 실패를 기록하는 이슈에 붙이는 라벨.
const EMAIL_FAILURE_LABEL = '이메일-발송실패';

/**
 * 감시 항목별 신규 매물들을 하나의 이슈로 등록.
 * @param {object} params
 * @param {object} params.watch        {keyword, location}
 * @param {Array}  params.items        신규 매물 배열
 * @param {string} params.chatMessage  채팅 인사말
 * @param {object} [params.source]     {name, issueLabel} 소스(사이트) 정보
 * @returns {Promise<{number:number, html_url:string}>}
 */
async function createIssue({ watch, items, chatMessage, source }) {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!token || !repo) {
    throw new Error('GITHUB_TOKEN / GITHUB_REPOSITORY 환경변수가 필요합니다.');
  }
  const apiUrl = process.env.GITHUB_API_URL || 'https://api.github.com';

  const siteName = (source && source.name) || '당근마켓';
  const siteKey = source && source.key;
  const label = (source && source.issueLabel) || ISSUE_LABEL;

  const today = new Date().toISOString().slice(0, 10);
  const title = `[${siteName} 신규] '${watch.keyword}' (${watch.location || '전체'}) ${items.length}건 · ${today}`;
  const body = buildIssueBody(watch, items, chatMessage, siteName, siteKey);

  const res = await fetch(`${apiUrl}/repos/${repo}/issues`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ title, body, labels: [label] }),
  });

  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.json()).message || '';
    } catch (_) {}
    throw new Error(`이슈 생성 실패: HTTP ${res.status} ${detail}`);
  }
  const json = await res.json();
  return { number: json.number, html_url: json.html_url };
}

function buildIssueBody(watch, items, chatMessage, siteName, siteKey) {
  const message = chatMessage || '안녕하세요. 제가 구매 가능할까요?';
  const site = siteName || '당근마켓';
  const lines = [
    `**사이트:** \`${site}\` · **키워드:** \`${watch.keyword}\` · **지역:** \`${watch.location || '전체'}\`${watch.maxAgeDays == null ? '' : ` · **등록일:** 최근 \`${watch.maxAgeDays}일\` 이내`}`,
    '',
    `${site}에 조건에 맞는 신규 매물 **${items.length}건**이 올라왔습니다.`,
    '',
  ];

  items.forEach((it, i) => {
    lines.push(`### ${i + 1}. ${it.title || '(제목 없음)'}`);
    if (it.price) lines.push(`- 가격: ${it.price}`);
    if (it.region) lines.push(`- 지역: ${it.region}`);
    if (it.publishedAt) lines.push(`- 등록일: ${new Date(it.publishedAt).toLocaleString('ko-KR')}`);
    lines.push(`- ${site} 매물 보기: ${it.url}`);
    lines.push(`- 💬 빠른 채팅: ${chatHelperLink(it, message, siteKey)}`);
    lines.push('');
  });

  lines.push('---');
  lines.push(`> 미리 준비된 인사말: "${message}"`);
  lines.push('> "빠른 채팅" 링크에서 인사말을 복사한 뒤 매물의 "채팅하기"에 붙여넣으세요.');
  lines.push('> 확인/거래 완료 후 이 이슈를 닫으면 됩니다.');
  return lines.join('\n');
}

/**
 * 이메일 주소를 일부만 노출하도록 마스킹 (공개 저장소 이슈 대비).
 * 예: leemgs@gmail.com → le***@gmail.com
 */
function maskEmail(value) {
  const s = String(value || '');
  const at = s.indexOf('@');
  if (at < 1) return s ? '***' : '';
  const name = s.slice(0, at);
  const domain = s.slice(at);
  const shown = name.slice(0, Math.min(2, name.length));
  return `${shown}${'*'.repeat(Math.max(1, name.length - shown.length))}${domain}`;
}

/**
 * 특정 라벨이 붙은 "열린" 이슈가 이미 있는지 조회 (중복 생성 방지용).
 * @returns {Promise<{number:number, html_url:string}|null>}
 */
async function findOpenIssueByLabel(apiUrl, repo, token, label) {
  const url = `${apiUrl}/repos/${repo}/issues?state=open&labels=${encodeURIComponent(label)}&per_page=1`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!res.ok) return null;
  const arr = await res.json();
  return Array.isArray(arr) && arr.length
    ? { number: arr[0].number, html_url: arr[0].html_url }
    : null;
}

/**
 * 이메일(Gmail SMTP) 발송 실패를 GitHub 이슈로 등록한다.
 * 워크플로가 ~3분마다 반복 실행되므로, 같은 라벨의 열린 이슈가 이미 있으면
 * 중복 생성하지 않고 기존 이슈 정보를 반환한다(deduped=true).
 *
 * @param {object} params
 * @param {string|string[]} params.to     수신 예정 이메일 (마스킹되어 기록됨)
 * @param {object} params.watch           {keyword, location}
 * @param {object} [params.source]        {name} 소스(사이트) 정보
 * @param {Error|string} params.error     발생한 오류
 * @returns {Promise<{number:number, html_url:string, deduped?:boolean}>}
 */
async function reportEmailFailure({ to, watch, source, error }) {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!token || !repo) {
    throw new Error('GITHUB_TOKEN / GITHUB_REPOSITORY 환경변수가 필요합니다.');
  }
  const apiUrl = process.env.GITHUB_API_URL || 'https://api.github.com';

  // 이미 열린 실패 이슈가 있으면 새로 만들지 않는다(3분 주기 중복 방지).
  const existing = await findOpenIssueByLabel(apiUrl, repo, token, EMAIL_FAILURE_LABEL);
  if (existing) return { ...existing, deduped: true };

  const recipients = (Array.isArray(to) ? to : [to]).filter(Boolean).map(maskEmail);
  const siteName = (source && source.name) || '알림';
  const message = (error && error.message) || String(error || '(원인 불명)');
  const title = '⚠️ 이메일(Gmail SMTP) 발송 실패';
  const body = buildEmailFailureBody({ recipients, watch, siteName, message });

  const res = await fetch(`${apiUrl}/repos/${repo}/issues`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ title, body, labels: [EMAIL_FAILURE_LABEL] }),
  });

  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.json()).message || '';
    } catch (_) {}
    throw new Error(`실패 이슈 생성 실패: HTTP ${res.status} ${detail}`);
  }
  const json = await res.json();
  return { number: json.number, html_url: json.html_url };
}

function buildEmailFailureBody({ recipients, watch, siteName, message }) {
  const when = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
  const truncated = message.length > 1500 ? `${message.slice(0, 1500)} …(생략)` : message;
  const lines = [
    'GitHub Actions 자동 알림이 **Gmail SMTP 이메일 발송에 실패**했습니다.',
    '',
    `- **발생 시각:** ${when} (KST)`,
    `- **영향받은 감시 항목:** \`${(watch && watch.keyword) || '(알 수 없음)'}\` (\`${(watch && watch.location) || '전체'}\`) · 사이트 \`${siteName}\``,
    `- **수신 예정:** ${recipients.length ? recipients.join(', ') : '(없음)'}`,
    '',
    '**오류 메시지**',
    '```',
    truncated,
    '```',
    '',
    '### 확인할 점',
    '- 저장소 **Settings → Secrets and variables → Actions → Secrets** 에 `GMAIL_APP_PASSWORD` 가 등록되어 있고, 값이 올바른 **16자리 앱 비밀번호**인가요? (변수명이 정확히 `GMAIL_APP_PASSWORD` 여야 합니다.)',
    '- `GMAIL_USER`(발신 Gmail 주소)가 올바른가요?',
    '- 발신 계정에 **2단계 인증**이 켜져 있고 앱 비밀번호가 유효한가요? (Gmail 비밀번호를 바꾸면 앱 비밀번호를 다시 발급해야 합니다.)',
    '- `Invalid login` / `535` 오류라면 대부분 앱 비밀번호가 틀렸거나 만료된 경우입니다.',
    '',
    '> ℹ️ 이 이슈는 이메일 발송이 다시 성공해도 **자동으로 닫히지 않습니다.** 원인을 해결한 뒤 직접 닫아주세요.',
    '> 이 이슈가 **열려 있는 동안에는** 같은 실패 이슈가 중복 생성되지 않습니다.',
  ];
  return lines.join('\n');
}

module.exports = { createIssue, reportEmailFailure };

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

module.exports = { createIssue };

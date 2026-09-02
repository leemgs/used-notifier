'use strict';

/**
 * Google(Gmail) SMTP 를 이용한 이메일 발송 모듈.
 *
 * 필요한 환경변수 (GitHub Actions Secrets 로 주입):
 *   GMAIL_USER          발신 Gmail 주소 (예: myname@gmail.com)
 *   GMAIL_APP_PASSWORD  Gmail 앱 비밀번호 (2단계 인증 후 발급한 16자리)
 *   MAIL_FROM_NAME      (선택) 발신자 표시 이름. 기본값 "당근마켓 알림"
 */

const nodemailer = require('nodemailer');
const { chatHelperLink } = require('./links');
const { themeFor } = require('./theme');
const { describeMaxAge } = require('./daangn');

const DASHBOARD_URL = 'https://leemgs.github.io/used-notifier/';

function createTransport() {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) {
    throw new Error(
      'GMAIL_USER / GMAIL_APP_PASSWORD 환경변수가 설정되지 않았습니다. ' +
        'GitHub 저장소 Settings > Secrets 에 등록하세요.'
    );
  }
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass },
  });
}

/**
 * 새 매물 목록을 HTML 이메일로 발송.
 * @param {object} params
 * @param {string|string[]} params.to   수신 이메일 (1개 문자열 또는 여러 개 배열)
 * @param {object} params.watch         {keyword, location}
 * @param {Array}  params.items         새로 발견된 매물 배열
 * @param {string} [params.chatMessage] 채팅 도우미에 미리 채울 인사말
 * @param {object} [params.source]      소스(사이트) 정보 {key, name} — 테마/링크 문구 결정
 * @param {string} [params.siteName]    (구버전 호환) 소스 이름. source 미지정 시 사용.
 */
async function sendNewItemsEmail({ to, watch, items, chatMessage, source, siteName }) {
  const transporter = createTransport();
  const theme = themeFor(source && source.key);
  const site = (source && source.name) || siteName || theme.name;
  const fromName = process.env.MAIL_FROM_NAME || '중고 알리미';
  const from = `"${fromName}" <${process.env.GMAIL_USER}>`;
  const message = chatMessage || '안녕하세요. 제가 구매 가능할까요?';

  const subject = `[${site} 알림] '${watch.keyword}' (${watch.location || '전체'}) 신규 매물 ${items.length}건`;

  await transporter.sendMail({
    from,
    to,
    subject,
    text: buildText(watch, items, message, site, theme),
    html: buildHtml(watch, items, message, site, theme),
  });
}

function buildText(watch, items, message, site, theme) {
  const ageText = describeMaxAge(watch);
  const ageCondition = ageText ? ` / ${ageText} 등록` : '';
  const lines = [
    `${site}에 '${watch.keyword}' 키워드 / '${watch.location || '전체'}' 지역${ageCondition} 조건의 신규 매물이 올라왔습니다.`,
    '',
  ];
  items.forEach((it, i) => {
    lines.push(`${i + 1}. ${it.title || '(제목 없음)'}`);
    if (it.price) lines.push(`   가격: ${it.price}`);
    if (it.region) lines.push(`   지역: ${it.region}`);
    if (it.publishedAt) lines.push(`   등록일: ${new Date(it.publishedAt).toLocaleString('ko-KR')}`);
    lines.push(`   ${site} 매물: ${it.url}`);
    lines.push(`   빠른 채팅: ${chatHelperLink(it, message, theme.key)}`);
    lines.push('');
  });
  lines.push(`인사말: "${message}"`);
  lines.push('모바일에서 "빠른 채팅" 링크를 눌러 인사말을 복사한 뒤, 매물에서 "채팅하기"에 붙여넣으세요.');
  lines.push('');
  lines.push(`중고 알리미 대시보드: ${DASHBOARD_URL}`);
  return lines.join('\n');
}

function esc(s) {
  return String(s || '').replace(/[&<>"]/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
  }[c]));
}

function buildHtml(watch, items, message, site, theme) {
  const t = theme || themeFor(null);
  const siteName = site || t.name;
  const ageText = describeMaxAge(watch);
  const cards = items
    .map(
      (it) => `
    <tr>
      <td style="padding:12px 0;border-bottom:1px solid #eee;">
        ${
          it.image
            ? `<img src="${esc(it.image)}" alt="" width="96" height="96" style="border-radius:8px;object-fit:cover;float:left;margin-right:12px;">`
            : ''
        }
        <a href="${esc(it.url)}" style="font-size:16px;font-weight:700;color:${t.dark};text-decoration:none;">
          ${esc(it.title || '(제목 없음)')}
        </a>
        <div style="margin-top:4px;color:#333;font-size:15px;">${esc(it.price || '')}</div>
        <div style="margin-top:2px;color:#888;font-size:13px;">${esc(it.region || '')}</div>
        ${it.publishedAt ? `<div style="margin-top:2px;color:#888;font-size:13px;">등록일 ${esc(new Date(it.publishedAt).toLocaleString('ko-KR'))}</div>` : ''}
        <div style="margin-top:10px;">
          <a href="${esc(chatHelperLink(it, message, t.key))}" style="display:inline-block;background:${t.primary};color:#fff;padding:9px 15px;border-radius:6px;font-size:13px;font-weight:700;text-decoration:none;margin-right:6px;">
            💬 빠른 채팅
          </a>
          <a href="${esc(it.url)}" style="display:inline-block;background:#fff;color:${t.dark};border:1.5px solid ${t.primary};padding:7px 14px;border-radius:6px;font-size:13px;text-decoration:none;">
            ${esc(siteName)}에서 보기 →
          </a>
        </div>
        <div style="clear:both;"></div>
      </td>
    </tr>`
    )
    .join('');

  return `<!doctype html>
<html lang="ko">
<body style="margin:0;background:#f6f6f6;font-family:-apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo','Malgun Gothic',sans-serif;">
  <div style="max-width:560px;margin:0 auto;padding:20px;">
    <div style="background:#fff;border-radius:12px;padding:0;overflow:hidden;border:1px solid #eee;">
      <div style="background:linear-gradient(135deg,${t.primary},${t.lite});padding:20px 24px;">
        <h1 style="margin:0;font-size:20px;color:#fff;">${t.emoji} ${esc(siteName)} 신규 매물 알림</h1>
      </div>
      <div style="padding:24px;">
      <p style="margin:0 0 16px;color:#555;font-size:14px;">
        <b style="color:${t.dark};">${esc(siteName)}</b> · 키워드 <b>'${esc(watch.keyword)}'</b> · 지역 <b>'${esc(watch.location || '전체')}'</b>${ageText ? ` · <b>${esc(ageText)}</b> 등록` : ''} 조건의 신규 매물 <b>${items.length}</b>건
      </p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${cards}</table>
      <div style="margin:18px 0 0;padding:12px 14px;background:${t.soft};border-radius:8px;">
        <div style="font-size:12px;color:${t.dark};font-weight:700;margin-bottom:4px;">미리 준비된 인사말</div>
        <div style="font-size:15px;color:#333;">${esc(message)}</div>
      </div>
      <p style="margin:14px 0 0;color:#999;font-size:12px;">
        <b>💬 빠른 채팅</b> 버튼 → 인사말 <b>복사</b> → <b>${esc(siteName)}에서 "채팅하기"</b>에 붙여넣기 후 전송하세요.<br>
        (계정 보호 및 각 사이트 이용약관 준수를 위해 전송은 직접 완료합니다.)<br>
        이 메일은 GitHub Actions 자동 알림으로 발송되었습니다.
      </p>
      </div>
      <div style="padding:18px 24px;background:#f8fafc;border-top:1px solid #e9edf2;text-align:center;">
        <p style="margin:0 0 10px;color:#64748b;font-size:12px;line-height:1.5;">
          감시 목록과 최근 매물을 한곳에서 확인하세요.
        </p>
        <a href="${DASHBOARD_URL}" style="display:inline-block;padding:10px 18px;border-radius:8px;background:${t.dark};color:#fff;font-size:13px;font-weight:700;text-decoration:none;">
          🔔 중고 알리미 대시보드 열기
        </a>
        <div style="margin-top:9px;font-size:11px;line-height:1.4;">
          <a href="${DASHBOARD_URL}" style="color:#8491a3;text-decoration:underline;word-break:break-all;">${DASHBOARD_URL}</a>
        </div>
      </div>
    </div>
  </div>
</body>
</html>`;
}

module.exports = { sendNewItemsEmail, buildHtml, buildText };

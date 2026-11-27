'use strict';

/**
 * 아주 단순한 "접속 코드" 게이트.
 *
 * 초대받은 사용자를 위한 정보 공간용으로, 코드를 입력해야 페이지 내용을 보여준다.
 *   1) docs/config/access.json 에서 접속 코드의 SHA-256 해시(digest)만 읽는다(평문 미저장).
 *   2) 입력한 코드를 브라우저에서 SHA-256으로 해시해 digest 와 비교한다.
 *   3) 일치하면 sessionStorage 에 허용 상태를 기록하고 페이지를 보여준다.
 *
 * ⚠️ 정적 사이트의 간단한 접근 제한일 뿐, 민감정보 보호 목적이 아닙니다.
 *    해시가 클라이언트에 노출되므로 진짜 보안 경계로 사용하지 마세요.
 */
(function () {
  const CONFIG_URL = './config/access.json';
  const STORAGE_KEY = 'site-access';

  let config = null; // { version, digest, ... }

  // ---- 유틸 ----------------------------------------------------------------

  // 문자열의 SHA-256 16진수 해시. 보안 컨텍스트(https/localhost)에서만 동작.
  async function sha256hex(str) {
    if (!(window.crypto && window.crypto.subtle)) {
      throw new Error('이 브라우저/환경에서는 해시(Web Crypto)를 사용할 수 없습니다. (https 필요)');
    }
    const bytes = new TextEncoder().encode(str);
    const buf = await window.crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  function readSession() {
    try {
      return JSON.parse(sessionStorage.getItem(STORAGE_KEY) || 'null');
    } catch (_) {
      return null;
    }
  }

  function writeSession(version) {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ v: version, ok: true }));
    } catch (_) {
      /* 프라이빗 모드 등에서 저장 실패해도 현재 세션은 계속 진행 */
    }
  }

  // gate-pending: 내용만 숨김(코드 입력창은 아직 안 띄움) — 저장된 세션의 version 확인 중.
  // gate-locked : 내용 숨김 + 코드 입력창 표시.
  function pend() {
    document.documentElement.classList.add('gate-pending');
  }
  function lock() {
    document.documentElement.classList.remove('gate-pending');
    document.documentElement.classList.add('gate-locked');
  }
  function reveal() {
    document.documentElement.classList.remove('gate-pending', 'gate-locked');
  }

  // 내용이 잠깐 보였다 가려지는 깜빡임을 막기 위해 스크립트 로드 시점(문서 파싱 전)에
  // 즉시 스타일을 주입하고 내용을 숨긴다. 저장된 세션이 없으면 바로 입력창(lock),
  // 있으면 version 확인이 끝날 때까지 내용만 숨긴다(pend). 코드를 교체(version 변경)한
  // 뒤에도 옛 세션이 확인 전 내용을 엿보지 못하게 하기 위함이다.
  (function lockEarly() {
    injectStyles();
    const s = readSession();
    if (s && s.ok) pend(); // 허용 세션이라도 version 확인 전에는 내용을 보여주지 않는다
    else lock();
  })();

  // 게이트 전용 스타일을 주입한다(style.css 의존 없이 자체 완결).
  function injectStyles() {
    if (document.getElementById('site-gate-style')) return;
    const css = `
      html.gate-locked body { overflow: hidden; }
      html.gate-locked body > *:not(#site-gate),
      html.gate-pending body > *:not(#site-gate) { visibility: hidden !important; }
      #site-gate { display: none; }
      html.gate-locked #site-gate { display: flex; }
      #site-gate {
        position: fixed; inset: 0; z-index: 2147483000;
        align-items: center; justify-content: center; padding: 24px;
        background: linear-gradient(135deg, #ff7e36, #ff9f1c);
        font-family: -apple-system, BlinkMacSystemFont, 'Apple SD Gothic Neo', 'Malgun Gothic', sans-serif;
      }
      #site-gate .gate-card {
        width: 100%; max-width: 360px; background: #fff; color: #222;
        border-radius: 16px; padding: 28px 24px; box-shadow: 0 10px 40px rgba(0,0,0,.25);
        text-align: center;
      }
      #site-gate .gate-emoji { font-size: 44px; line-height: 1; }
      #site-gate h1 { margin: 10px 0 6px; font-size: 20px; }
      #site-gate p { margin: 6px 0; color: #555; font-size: 14px; }
      #site-gate form { margin: 16px 0 6px; display: flex; gap: 8px; }
      #site-gate input {
        flex: 1; min-width: 0; padding: 12px 14px; font-size: 16px;
        border: 1px solid #ddd; border-radius: 10px; outline: none;
      }
      #site-gate input:focus { border-color: #ff7e36; box-shadow: 0 0 0 3px rgba(255,126,54,.2); }
      #site-gate button {
        padding: 12px 18px; font-size: 15px; font-weight: 700; cursor: pointer;
        color: #fff; background: #ff7e36; border: 0; border-radius: 10px;
      }
      #site-gate button:disabled { opacity: .6; cursor: default; }
      #site-gate .gate-error { color: #d12; font-weight: 600; min-height: 18px; }
      #site-gate .gate-note { margin-top: 14px; color: #999; font-size: 12px; line-height: 1.4; }
      @media (prefers-color-scheme: dark) {
        #site-gate .gate-card { background: #1f1f1f; color: #eee; }
        #site-gate p { color: #aaa; }
        #site-gate input { background: #2a2a2a; color: #eee; border-color: #444; }
      }`;
    const style = document.createElement('style');
    style.id = 'site-gate-style';
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
  }

  // 게이트 오버레이 DOM 을 만든다(이미 있으면 재사용).
  function buildGate() {
    let gate = document.getElementById('site-gate');
    if (gate) return gate;
    gate = document.createElement('div');
    gate.id = 'site-gate';
    gate.setAttribute('role', 'dialog');
    gate.setAttribute('aria-modal', 'true');
    gate.setAttribute('aria-label', '접속 코드 입력');
    gate.innerHTML =
      '<div class="gate-card">' +
      '<div class="gate-emoji">🔒</div>' +
      '<h1>접속 코드 입력</h1>' +
      '<p>초대받은 분을 위한 정보 공간입니다.<br />접속 코드를 입력하세요.</p>' +
      '<form id="site-gate-form" autocomplete="off">' +
      '<input id="site-gate-input" type="password" inputmode="text" autocomplete="off" ' +
      'autocapitalize="off" spellcheck="false" placeholder="접속 코드" aria-label="접속 코드" />' +
      '<button type="submit">입장</button>' +
      '</form>' +
      '<p class="gate-error" id="site-gate-error" role="alert"></p>' +
      '<p class="gate-note">⚠️ 정적 사이트의 간단한 접근 제한이며 민감정보 보호용이 아닙니다.</p>' +
      '</div>';
    document.body.appendChild(gate);

    const form = gate.querySelector('#site-gate-form');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = gate.querySelector('#site-gate-input');
      const btn = form.querySelector('button');
      const errEl = gate.querySelector('#site-gate-error');
      errEl.textContent = '';
      btn.disabled = true;
      try {
        const ok = await unlock(input.value);
        if (!ok) {
          errEl.textContent = '접속 코드가 올바르지 않습니다.';
          input.select();
        }
      } catch (err) {
        errEl.textContent = err && err.message ? err.message : '오류가 발생했습니다.';
      } finally {
        btn.disabled = false;
      }
    });
    return gate;
  }

  function showGate() {
    injectStyles();
    lock();
    const gate = buildGate();
    const input = gate.querySelector('#site-gate-input');
    if (input) setTimeout(() => input.focus(), 0);
  }

  // ---- 공개 API ------------------------------------------------------------

  // access.json 에서 허용 해시 목록을 뽑는다. digests(배열) 또는 digest(단일) 모두 지원.
  function allowedDigests(cfg) {
    const list = [];
    if (cfg && Array.isArray(cfg.digests)) list.push(...cfg.digests);
    if (cfg && cfg.digest) list.push(cfg.digest);
    return list.map((d) => String(d || '').toLowerCase()).filter(Boolean);
  }

  // 입력 코드를 해시해 허용 해시 목록과 비교. 하나라도 일치하면 허용 상태 기록 후 페이지 노출.
  async function unlock(code) {
    if (!config) config = await loadConfig();
    const allowed = allowedDigests(config);
    if (!allowed.length) {
      throw new Error('접속 설정(access.json)을 불러오지 못했습니다.');
    }
    const digest = (await sha256hex(String(code == null ? '' : code).trim())).toLowerCase();
    if (!allowed.includes(digest)) {
      return false;
    }
    writeSession(config.version);
    reveal();
    const gate = document.getElementById('site-gate');
    if (gate) gate.remove();
    return true;
  }

  async function loadConfig() {
    // 코드 교체(version 변경)가 즉시 반영되도록 캐시를 쓰지 않는다.
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), 8000) : null;
    let res;
    try {
      res = await fetch(CONFIG_URL, { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined });
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (!res.ok) throw new Error('접속 설정을 불러오지 못했습니다: HTTP ' + res.status);
    return res.json();
  }

  // 페이지 로드 시 호출: 허용된 세션이면 바로 보여주고, 아니면 게이트를 띄운다.
  async function initAuth() {
    injectStyles();
    try {
      config = await loadConfig();
    } catch (_) {
      // 설정을 못 읽으면 접근을 막는다(fail-closed). 게이트는 띄우되 오류를 표시.
      showGate();
      const errEl = document.getElementById('site-gate-error');
      if (errEl) errEl.textContent = '접속 설정(config/access.json)을 불러오지 못했습니다.';
      return;
    }
    const s = readSession();
    // version 이 정의돼 있고 허용 해시가 하나라도 있을 때만 기존 세션을 인정한다.
    // (version 누락 시 위조 세션 {ok:true} 의 undefined === undefined 로 통과되는 것을 방지)
    const configUsable = config && config.version != null && allowedDigests(config).length > 0;
    if (configUsable && s && s.ok && s.v === config.version) {
      reveal(); // 이미 이 버전으로 허용됨
      return;
    }
    // 코드가 교체(version 변경)되었거나 처음 방문 → 재입력 요구
    showGate();
  }

  // 전역 노출(명세: initAuth / unlock) + 자동 초기화
  window.initAuth = initAuth;
  window.unlock = unlock;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAuth);
  } else {
    initAuth();
  }
})();

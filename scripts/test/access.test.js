'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const ACCESS_PATH = path.join(ROOT, 'docs', 'config', 'access.json');

function load() {
  return JSON.parse(fs.readFileSync(ACCESS_PATH, 'utf8'));
}

test('access.json: version 은 양의 정수이고 SHA-256 해시만 저장한다', () => {
  const cfg = load();
  assert.ok(Number.isInteger(cfg.version) && cfg.version >= 1, 'version 은 1 이상의 정수');
  assert.ok(Array.isArray(cfg.digests) && cfg.digests.length >= 1, 'digests 는 비어 있지 않은 배열');
  for (const d of cfg.digests) {
    assert.match(d, /^[0-9a-f]{64}$/, `SHA-256 hex(64자) 형식이어야 한다: ${d}`);
  }
  assert.equal(new Set(cfg.digests).size, cfg.digests.length, 'digests 중복 없음');
});

test('access.json: 평문 비밀번호 필드를 두지 않는다', () => {
  const cfg = load();
  for (const key of Object.keys(cfg)) {
    assert.doesNotMatch(key, /^(password|passwd|code|secret|plain)/i, `평문처럼 보이는 키: ${key}`);
  }
});

test('site.js: initAuth / unlock 을 전역으로 노출하고 모든 페이지가 로드한다', () => {
  const src = fs.readFileSync(path.join(ROOT, 'docs', 'assets', 'site.js'), 'utf8');
  assert.match(src, /window\.initAuth\s*=\s*initAuth/);
  assert.match(src, /window\.unlock\s*=\s*unlock/);
  const pages = fs.readdirSync(path.join(ROOT, 'docs')).filter((f) => f.endsWith('.html'));
  assert.ok(pages.length > 0);
  for (const page of pages) {
    const html = fs.readFileSync(path.join(ROOT, 'docs', page), 'utf8');
    assert.match(html, /assets\/site\.js/, `${page} 에 site.js 가 없다(게이트 우회)`);
  }
});

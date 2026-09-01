'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { reportEmailFailure } = require('../github');

// 공용: 환경변수와 fetch 를 저장/복원하며 시나리오를 실행한다.
async function withMockedGitHub({ listResponse }, run) {
  const originalFetch = global.fetch;
  const originalToken = process.env.GITHUB_TOKEN;
  const originalRepo = process.env.GITHUB_REPOSITORY;
  process.env.GITHUB_TOKEN = 'test-token';
  process.env.GITHUB_REPOSITORY = 'leemgs/used-notifier';

  const calls = [];
  global.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || 'GET', body: opts.body });
    // 열린 실패 이슈 조회(GET) vs 이슈 생성(POST) 구분
    if ((opts.method || 'GET') === 'GET') {
      return { ok: true, json: async () => listResponse };
    }
    return {
      ok: true,
      json: async () => ({ number: 123, html_url: 'https://github.com/leemgs/used-notifier/issues/123' }),
    };
  };

  try {
    return await run(calls);
  } finally {
    global.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = originalToken;
    if (originalRepo === undefined) delete process.env.GITHUB_REPOSITORY;
    else process.env.GITHUB_REPOSITORY = originalRepo;
  }
}

test('이메일 실패 시 실패 라벨로 새 이슈를 생성한다', async () => {
  const result = await withMockedGitHub({ listResponse: [] }, async (calls) => {
    const r = await reportEmailFailure({
      to: ['leemgs@gmail.com', 'family@gmail.com'],
      watch: { keyword: '화분', location: '수원시영통구' },
      source: { name: '당근마켓' },
      error: new Error('Invalid login: 535-5.7.8 Username and Password not accepted'),
    });
    // 1) 중복 확인(GET) → 2) 생성(POST) 순으로 호출
    assert.equal(calls.length, 2);
    assert.equal(calls[0].method, 'GET');
    assert.match(calls[0].url, /state=open/);
    assert.match(calls[0].url, /labels=/);
    assert.equal(calls[1].method, 'POST');

    const posted = JSON.parse(calls[1].body);
    assert.deepEqual(posted.labels, ['이메일-발송실패']);
    assert.match(posted.title, /이메일/);
    // 오류 메시지와 점검 가이드(GMAIL_APP_PASSWORD)가 본문에 포함된다
    assert.match(posted.body, /Invalid login/);
    assert.match(posted.body, /GMAIL_APP_PASSWORD/);
    // 수신 이메일은 마스킹되어 원문 그대로 노출되지 않는다
    assert.doesNotMatch(posted.body, /leemgs@gmail\.com/);
    assert.match(posted.body, /le\*+@gmail\.com/);
    return r;
  });

  assert.equal(result.number, 123);
  assert.ok(!result.deduped);
});

test('이미 열린 실패 이슈가 있으면 중복 생성하지 않는다', async () => {
  await withMockedGitHub(
    { listResponse: [{ number: 42, html_url: 'https://github.com/leemgs/used-notifier/issues/42' }] },
    async (calls) => {
      const r = await reportEmailFailure({
        to: 'leemgs@gmail.com',
        watch: { keyword: '테이블', location: '' },
        source: { name: '중고나라' },
        error: new Error('연결 시간 초과'),
      });
      // GET 한 번만 호출되고 POST(생성)는 없어야 한다
      assert.equal(calls.length, 1);
      assert.equal(calls[0].method, 'GET');
      assert.equal(r.deduped, true);
      assert.equal(r.number, 42);
    }
  );
});

test('토큰/저장소 환경변수가 없으면 예외를 던진다', async () => {
  const originalToken = process.env.GITHUB_TOKEN;
  const originalRepo = process.env.GITHUB_REPOSITORY;
  delete process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_REPOSITORY;
  try {
    await assert.rejects(
      () => reportEmailFailure({ to: 'a@b.com', watch: { keyword: 'x' }, error: new Error('e') }),
      /GITHUB_TOKEN/
    );
  } finally {
    if (originalToken !== undefined) process.env.GITHUB_TOKEN = originalToken;
    if (originalRepo !== undefined) process.env.GITHUB_REPOSITORY = originalRepo;
  }
});

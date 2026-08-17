'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { formatPrice } = require('../price');
const {
  buildSearchUrl,
  matchesWatch,
  parseItems: parseDaangn,
  searchDaangn,
} = require('../daangn');
const { parseItems: parseJoongna } = require('../joongna');
const { parseItems: parseBunjang } = require('../bunjang');
const { buildHtml, buildText } = require('../mailer');

test('0원 감시는 무료 매물만 매칭한다', () => {
  const watch = { keyword: '의자', location: '', maxPrice: 0 };

  assert.equal(matchesWatch({ title: '의자 나눔', priceValue: 0 }, watch), true);
  assert.equal(matchesWatch({ title: '의자 판매', priceValue: 1 }, watch), false);
  assert.equal(matchesWatch({ title: '의자 가격제안', priceValue: null }, watch), false);
});

test('maxPrice 미지정은 기존처럼 가격 제한을 적용하지 않는다', () => {
  assert.equal(
    matchesWatch({ title: '의자 판매', priceValue: 100000 }, { keyword: '의자', location: '' }),
    true
  );
});

test('사이트별 0원 표시를 유지한다', () => {
  assert.equal(formatPrice(0), '나눔');
  assert.equal(formatPrice(0, '0원'), '0원');

  const joongnaHtml = `<script type="application/json">${JSON.stringify({
    id: 10101,
    title: '의자',
    price: 0,
  })}</script>`;
  assert.equal(parseJoongna(joongnaHtml)[0].price, '0원');
  assert.equal(parseJoongna(joongnaHtml)[0].priceValue, 0);

  const bunjang = parseBunjang({ list: [{ pid: 20202, name: '의자', price: 0 }] });
  assert.equal(bunjang[0].price, '0원');
  assert.equal(bunjang[0].priceValue, 0);
});

test('당근 카드의 나눔 문구와 숫자 0 가격을 무료 매물로 파싱한다', () => {
  const cardHtml = `
    <a href="/kr/buy-sell/벽돌-나눔-abc123/">
      <span class="title">벽돌</span>
      <span class="price">나눔</span>
      <span class="region">권선동</span>
    </a>`;
  const card = parseDaangn(cardHtml)[0];
  assert.equal(card.price, '나눔');
  assert.equal(card.priceValue, 0);
  assert.equal(matchesWatch(card, { keyword: '벽돌', location: '', maxPrice: 0 }), true);

  const jsonLd = `<script type="application/ld+json">${JSON.stringify({
    '@type': 'Product',
    name: '무료 벽돌',
    url: '/kr/buy-sell/무료-벽돌-def456/',
    price: 0,
  })}</script>`;
  const numeric = parseDaangn(jsonLd).find((item) => item.id === 'def456');
  assert.ok(numeric);
  assert.equal(numeric.price, '나눔');
  assert.equal(numeric.priceValue, 0);
});

test('무료 모드의 나눔 키워드는 제품명과 무관하게 무료 품목만 허용한다', () => {
  const watch = { keyword: '나눔', location: '', maxPrice: 0 };
  assert.equal(matchesWatch({ title: '벽돌', priceValue: 0 }, watch), true);
  assert.equal(matchesWatch({ title: '벽돌', priceValue: 10000 }, watch), false);
});

test('당근 매탄동 검색은 파싱 가능한 검색 경로와 in 파라미터를 사용한다', () => {
  assert.equal(
    buildSearchUrl('화분', '매탄동-4535'),
    'https://www.daangn.com/kr/buy-sell/?search=%ED%99%94%EB%B6%84&in=%EB%A7%A4%ED%83%84%EB%8F%99-4535'
  );
});

test('지역 검색된 매탄동 화분 무료나눔은 실제 카드 지역까지 일치해야 한다', () => {
  const watch = {
    keyword: '화분',
    location: '수원시영통구',
    daangnRegion: '매탄동-4535',
    maxPrice: 0,
  };
  assert.equal(matchesWatch({ title: '화분 무료나눔', region: '매탄3동', priceValue: 0 }, watch), true);
  assert.equal(matchesWatch({ title: '화분 무료나눔', region: '서초4동', priceValue: 0 }, watch), false);
  assert.equal(matchesWatch({ title: '화분 무료나눔', region: '', priceValue: 0 }, watch), false);
});

test('로그인 쿠키가 있어도 수원시영통구 감시에 서초4동 매물을 허용하지 않는다', () => {
  const watch = { keyword: '테이블', location: '수원시영통구', maxPrice: 0 };
  const item = { title: 'LIVART 원목 좌식 테이블', region: '서초4동', priceValue: 0 };
  assert.equal(matchesWatch(item, watch), false);
});

test('당근 검색 전체 흐름에서도 쿠키 응답의 서초4동 매물을 차단한다', async () => {
  const originalFetch = global.fetch;
  const originalCookie = process.env.DAANGN_COOKIE;
  process.env.DAANGN_COOKIE = 'session=test';
  global.fetch = async () => ({
    ok: true,
    text: async () => `
      <a href="/kr/buy-sell/LIVART-원목-좌식-테이블-cookie123/">
        <span class="title">LIVART 원목 좌식 테이블</span>
        <span class="price">나눔</span>
        <span class="region">서초4동</span>
      </a>`,
  });

  try {
    const found = await searchDaangn({
      keyword: '테이블',
      location: '수원시영통구',
      maxPrice: 0,
    });
    assert.deepEqual(found, []);
  } finally {
    global.fetch = originalFetch;
    if (originalCookie === undefined) delete process.env.DAANGN_COOKIE;
    else process.env.DAANGN_COOKIE = originalCookie;
  }
});

test('알림 이메일 하단에 중고 알리미 대시보드 링크를 표시한다', () => {
  const watch = { keyword: '화분', location: '매탄동' };
  const items = [{ id: 'item1', title: '화분 나눔', url: 'https://example.com/item1' }];
  const dashboard = 'https://leemgs.github.io/used-notifier/';

  const html = buildHtml(watch, items, '구매 가능할까요?', '당근마켓');
  const text = buildText(watch, items, '구매 가능할까요?', '당근마켓', { key: 'daangn' });

  assert.match(html, new RegExp(`href="${dashboard}"`));
  assert.match(html, /중고 알리미 대시보드 열기/);
  assert.match(text, new RegExp(`중고 알리미 대시보드: ${dashboard}`));
});

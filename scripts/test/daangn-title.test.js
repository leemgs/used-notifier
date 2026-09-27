'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseItems, matchesWatch } = require('../daangn');

// 회귀 방지: 당근 검색 페이지 마크업이 바뀌면서(2026-09 경) URL 주변의 "최근접" 텍스트
// 필드가 상품명이 아니라 이웃 매물의 "동네 이름"이 되었다. 예전 파서는 광역 텍스트
// 스캔(extractFromText) 값이 JSON-LD 의 정확한 제목을 덮어써(마지막 값 우선), 제목이
// '망포2동' 같은 동네명으로 오염됐고 keywordMatches 가 전부 실패해 알림이 0건이 되었다.
//
// 아래 HTML 은 그 상황을 재현한다.
//  - JSON-LD 에는 올바른 상품명("UAG 노트20 울트라 케이스")이 있다.
//  - 같은 매물 URL 뒤에 이웃 동네명("망포2동")이 "name"/"region" 필드로 붙어 있어,
//    옛 파서라면 제목을 동네명으로 덮어썼다.
const PRODUCT_URL =
  'https://www.daangn.com/kr/buy-sell/uag-%EB%85%B8%ED%8A%B820-%EC%9A%B8%ED%8A%B8%EB%9D%BC-%EC%BC%80%EC%9D%B4%EC%8A%A4-abc123def456/';

const HTML = `<!DOCTYPE html><html><head>
<script type="application/ld+json">${JSON.stringify({
  '@context': 'https://schema.org',
  '@type': 'ItemList',
  numberOfItems: 1,
  itemListElement: [
    {
      '@type': 'ListItem',
      position: 1,
      item: {
        '@type': 'Product',
        name: 'UAG 노트20 울트라 케이스',
        url: PRODUCT_URL,
        offers: { '@type': 'Offer', price: '10000', priceCurrency: 'KRW' },
      },
    },
  ],
})}</script>
</head><body>
<!-- 새 마크업: 매물 URL 주변에 이웃 동네명이 name/region 으로 섞여 있다 -->
<script>self.__next_f.push([1,"{\\"region\\":\\"중산동\\",\\"name\\":\\"망포2동\\",\\"url\\":\\"${PRODUCT_URL}\\",\\"price\\":10000}"])</script>
</body></html>`;

test('JSON-LD 제목이 광역 텍스트 스캔의 동네명으로 덮어써지지 않는다', () => {
  const items = parseItems(HTML);
  const item = items.find((it) => it.id === 'abc123def456');
  assert.ok(item, '매물이 파싱되어야 한다');
  assert.ok(
    item.title.includes('노트20'),
    `제목이 상품명이어야 하는데 '${item.title}' 로 오염됨`
  );
  assert.ok(
    !/^[가-힣]{2,}\d{0,2}(?:동|읍|면|가|리)$/.test(item.title),
    `제목이 동네 이름 한 토큰('${item.title}')이면 안 된다`
  );
});

test('제목이 살아있어 키워드 매칭이 성공한다', () => {
  const items = parseItems(HTML);
  const item = items.find((it) => it.id === 'abc123def456');
  const watch = { keyword: '노트20 UAG', location: '수원시', maxPrice: 20000 };
  // 지역 대조는 이 테스트의 관심사가 아니므로 수원 소재 동네로 고정해 격리한다.
  assert.equal(
    matchesWatch({ ...item, region: '원천동' }, watch),
    true,
    '제목 복원 후 노트20 UAG 키워드가 매칭되어야 한다'
  );
});

test('구조적 제목이 없으면 URL 슬러그에서 상품명을 복원한다', () => {
  // JSON-LD 없이, 매물 URL 만 있는 축약 페이지에서도 제목이 슬러그로 복원된다.
  const html = `<html><body><a href="${PRODUCT_URL}">망포2동</a></body></html>`;
  const items = parseItems(html);
  const item = items.find((it) => it.id === 'abc123def456');
  assert.ok(item, '매물이 파싱되어야 한다');
  assert.ok(item.title.includes('노트20'), `슬러그 복원 실패: '${item.title}'`);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { formatPrice } = require('../price');
const {
  buildSearchUrl,
  resolveDaangnRegion,
  resolveDaangnRegions,
  matchesWatch,
  parseItems: parseDaangn,
  searchDaangn,
  describeMaxAge,
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

test('당근 카드의 datetime 등록일을 파싱한다', () => {
  const html = `
    <a href="/kr/buy-sell/의자-나눔-date123/">
      <span class="title">의자</span><span class="price">나눔</span>
      <time datetime="2026-08-24T03:00:00Z">2일 전</time>
    </a>`;
  assert.equal(parseDaangn(html)[0].publishedAt, '2026-08-24T03:00:00.000Z');
});

test('무료 모드의 나눔 키워드는 제품명과 무관하게 무료 품목만 허용한다', () => {
  const watch = { keyword: '나눔', location: '', maxPrice: 0 };
  assert.equal(matchesWatch({ title: '벽돌', priceValue: 0 }, watch), true);
  assert.equal(matchesWatch({ title: '벽돌', priceValue: 10000 }, watch), false);
});

test('매탄동 모든 무료나눔 감시는 제품 종류와 다른 동네를 구분한다', () => {
  const watch = {
    keyword: '나눔',
    allItems: true,
    location: '매탄동',
    daangnRegion: '매탄동-4535',
    maxPrice: 0,
  };

  assert.equal(matchesWatch({ title: '책장', region: '매탄3동', priceValue: 0 }, watch), true);
  assert.equal(matchesWatch({ title: '냉장고', region: '매탄동', priceValue: 0 }, watch), true);
  assert.equal(matchesWatch({ title: '책장', region: '매탄동', priceValue: 1000 }, watch), false);
  assert.equal(matchesWatch({ title: '책장', region: '영통동', priceValue: 0 }, watch), false);
});

test('allItems는 일반 검색어도 제품명 필터가 아닌 후보 조회용으로만 사용한다', () => {
  const watch = { keyword: '나눔', allItems: true, location: '', maxPrice: 5000 };
  assert.equal(matchesWatch({ title: '유아용 의자', region: '매탄동', priceValue: 3000 }, watch), true);
});

test('물품명 모두, 0원, 매탄동은 모든 종류의 매탄동 나눔만 매칭한다', () => {
  const watch = {
    keyword: '모두',
    location: '매탄동',
    daangnRegion: '매탄동-4535',
    maxPrice: 0,
  };
  assert.equal(matchesWatch({ title: '소파 나눔', region: '매탄2동', priceValue: 0 }, watch), true);
  assert.equal(matchesWatch({ title: '책상', region: '매탄동', priceValue: 0 }, watch), true);
  assert.equal(matchesWatch({ title: '책상', region: '매탄동', priceValue: 5000 }, watch), false);
  assert.equal(matchesWatch({ title: '책상', region: '원천동', priceValue: 0 }, watch), false);
});

test('물품명 모두인 무료 감시는 당근에서 나눔 검색어로 조회한다', async () => {
  const originalFetch = global.fetch;
  let requestedUrl = '';
  global.fetch = async (url) => {
    requestedUrl = url;
    return { ok: true, text: async () => '' };
  };
  try {
    await searchDaangn({ keyword: '모두', location: '매탄동', daangnRegion: '매탄동-4535', maxPrice: 0 });
    assert.equal(
      requestedUrl,
      'https://www.daangn.com/kr/buy-sell/?search=%EB%82%98%EB%88%94&in=%EB%A7%A4%ED%83%84%EB%8F%99-4535'
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('나눔 등록일 범위는 확인 가능한 날짜에 적용하고 등록일 불명은 놓치지 않는다', () => {
  const now = Date.now();
  const watch = { keyword: '모두', location: '', maxPrice: 0, maxAgeDays: 3 };
  assert.equal(matchesWatch({ title: '의자', priceValue: 0, publishedAt: new Date(now - 86400000).toISOString() }, watch), true);
  assert.equal(matchesWatch({ title: '의자', priceValue: 0, publishedAt: new Date(now - 5 * 86400000).toISOString() }, watch), false);
  assert.equal(matchesWatch({ title: '의자', priceValue: 0 }, watch), true);
});

test('시간 단위 등록일 범위(maxAgeHours)는 지금부터 롤링 윈도우로 적용한다', () => {
  const now = Date.now();
  const watch = { keyword: '모두', location: '', maxPrice: 0, maxAgeHours: 3 };
  // 3시간 이내는 통과, 그 이전은 제외
  assert.equal(matchesWatch({ title: '의자', priceValue: 0, publishedAt: new Date(now - 2 * 3600000).toISOString() }, watch), true);
  assert.equal(matchesWatch({ title: '의자', priceValue: 0, publishedAt: new Date(now - 4 * 3600000).toISOString() }, watch), false);
  // 등록일 불명은 놓치지 않는다
  assert.equal(matchesWatch({ title: '의자', priceValue: 0 }, watch), true);
});

test('maxAgeHours 는 maxAgeDays 보다 우선한다', () => {
  const now = Date.now();
  // 시간(1h)이 우선이라 6시간 전 매물은 제외되어야 한다(일=3이 있어도).
  const watch = { keyword: '모두', location: '', maxPrice: 0, maxAgeDays: 3, maxAgeHours: 1 };
  assert.equal(matchesWatch({ title: '의자', priceValue: 0, publishedAt: new Date(now - 30 * 60000).toISOString() }, watch), true);
  assert.equal(matchesWatch({ title: '의자', priceValue: 0, publishedAt: new Date(now - 6 * 3600000).toISOString() }, watch), false);
});

test('describeMaxAge 는 시간/일 조건 문구를 만든다', () => {
  assert.equal(describeMaxAge({ maxAgeHours: 3 }), '최근 3시간 이내');
  assert.equal(describeMaxAge({ maxAgeDays: 2 }), '최근 2일 이내');
  assert.equal(describeMaxAge({ maxAgeDays: 3, maxAgeHours: 6 }), '최근 6시간 이내'); // 시간 우선
  assert.equal(describeMaxAge({ maxAgeDays: 0 }), '최근 0일 이내');
  assert.equal(describeMaxAge({}), '');
});

test('영통구 감시는 당근의 서초 기본지역 대신 구 전역 코드를 자동 사용한다', async () => {
  // 구 단위 선택 → 대표 동(매탄동) 하나가 아니라 구 전역 코드로 조회해야 구 전체가 후보에 든다.
  assert.equal(resolveDaangnRegion({ location: '수원시영통구' }), '수원시-영통구-1293');
  assert.equal(
    resolveDaangnRegion({ location: '수원시영통구', daangnRegion: '영통동-1234' }),
    '영통동-1234'
  );

  const originalFetch = global.fetch;
  let requestedUrl = '';
  global.fetch = async (url) => {
    requestedUrl = url;
    return { ok: true, text: async () => '' };
  };
  try {
    await searchDaangn({ keyword: '모두', location: '수원시영통구', maxPrice: 0 });
    assert.equal(
      requestedUrl,
      'https://www.daangn.com/kr/buy-sell/?search=%EB%82%98%EB%88%94&in=%EC%88%98%EC%9B%90%EC%8B%9C-%EC%98%81%ED%86%B5%EA%B5%AC-1293'
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('시 단위 선택은 시 전역 코드로 조회하고 시내 모든 구를 허용한다', async () => {
  assert.deepEqual(resolveDaangnRegions({ location: '수원시' }), ['수원시-4179']);
  // 코드 미확보 구(장안/팔달)는 시 전역 코드로 폴백한 뒤 location 필터로 좁힌다.
  assert.deepEqual(resolveDaangnRegions({ location: '수원시장안구' }), ['수원시-4179']);

  const originalFetch = global.fetch;
  let requestedUrl = '';
  global.fetch = async (url) => {
    requestedUrl = url;
    return { ok: true, text: async () => '' };
  };
  try {
    await searchDaangn({ keyword: '모두', location: '수원시', maxPrice: 0 });
    assert.equal(
      requestedUrl,
      'https://www.daangn.com/kr/buy-sell/?search=%EB%82%98%EB%88%94&in=%EC%88%98%EC%9B%90%EC%8B%9C-4179'
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('시 단위 감시는 시내 여러 구 매물을 통과시키되 다른 도시는 막는다', () => {
  const watch = { keyword: '모두', allItems: true, location: '수원시', maxPrice: 0 };
  assert.equal(matchesWatch({ title: '의자 나눔', region: '영통구 매탄동', priceValue: 0 }, watch), true);
  assert.equal(matchesWatch({ title: '책상 나눔', region: '권선구 권선동', priceValue: 0 }, watch), true);
  assert.equal(matchesWatch({ title: '소파 나눔', region: '팔달구 인계동', priceValue: 0 }, watch), true);
  assert.equal(matchesWatch({ title: '책장 나눔', region: '서초4동', priceValue: 0 }, watch), false);
});

test('구 단위 감시는 구 전역 조회 결과에서 다른 구 매물을 걸러낸다', () => {
  // 구 전역 코드는 자동 코드이므로 엄격 대조가 아닌 넓은 location 조건으로 구 범위를 좁힌다.
  const watch = { keyword: '모두', allItems: true, location: '수원시영통구', maxPrice: 0 };
  assert.equal(matchesWatch({ title: '의자 나눔', region: '영통구 영통동', priceValue: 0 }, watch), true);
  assert.equal(matchesWatch({ title: '책상 나눔', region: '권선구 권선동', priceValue: 0 }, watch), false);
});

test('여러 지역 코드를 콤마로 지정하면 각각 조회해 병합한다', async () => {
  const originalFetch = global.fetch;
  const requested = [];
  global.fetch = async (url) => {
    requested.push(url);
    // 지역별로 서로 다른 매물 카드를 반환해 병합/중복제거를 확인한다.
    const id = requested.length === 1 ? 'aaa111' : 'bbb222';
    return {
      ok: true,
      text: async () =>
        `<a href="/kr/buy-sell/item-${id}/"><span class="title">의자 나눔</span><span class="price">나눔</span><span class="region">영통동</span></a>`,
    };
  };
  try {
    const found = await searchDaangn({
      keyword: '모두',
      allItems: true,
      location: '수원시영통구',
      daangnRegion: '매탄동-4535, 영통동-4537',
      maxPrice: 0,
    });
    assert.equal(requested.length, 2);
    assert.equal(found.length, 2);
  } finally {
    global.fetch = originalFetch;
  }
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

test('수원시(시 전체) 감시는 모든 구·동 매물을 매칭하고 타 지역은 제외한다', () => {
  const watch = { keyword: '모두', allItems: true, location: '수원시', maxPrice: 0 };
  // 4개 구 각각의 동 매물이 모두 통과해야 한다.
  assert.equal(matchesWatch({ title: '책상', region: '수원시 영통구 매탄동', priceValue: 0 }, watch), true);
  assert.equal(matchesWatch({ title: '의자', region: '권선동', priceValue: 0 }, watch), true); // 권선구
  assert.equal(matchesWatch({ title: '책장', region: '정자동', priceValue: 0 }, watch), true); // 장안구
  assert.equal(matchesWatch({ title: '선반', region: '행궁동', priceValue: 0 }, watch), true); // 팔달구
  // 수원이 아닌 지역은 걸러진다.
  assert.equal(matchesWatch({ title: '테이블', region: '서초4동', priceValue: 0 }, watch), false);
  // 지역 정보가 없는 카드는 오알림 방지를 위해 제외한다.
  assert.equal(matchesWatch({ title: '테이블', region: '', priceValue: 0 }, watch), false);
});

test('수원시 감시는 당근 기본지역(서초4동) 대신 시 전역 코드로 조회한다', () => {
  // 대표 동(매탄동) 하나가 아니라 시 전역 코드를 써야 시내 모든 구/동이 후보에 든다.
  assert.equal(resolveDaangnRegion({ location: '수원시' }), '수원시-4179');
  // 사용자가 지정한 지역 코드는 그대로 우선한다.
  assert.equal(
    resolveDaangnRegion({ location: '수원시', daangnRegion: '권선동-1234' }),
    '권선동-1234'
  );
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

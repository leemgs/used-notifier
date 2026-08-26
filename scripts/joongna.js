'use strict';

/**
 * 중고나라(web.joongna.com) 검색 및 파싱 모듈.
 *
 * 중고나라는 Next.js 기반이라 검색 결과가 페이지에 임베드된 JSON(__NEXT_DATA__ 등)
 * 또는 내부 API 로 내려온다. 마크업/스키마 변경에 견디도록 여러 전략을 시도한다.
 *   1) 검색 페이지 HTML 의 임베드 JSON(__NEXT_DATA__ / application/json)에서 매물 수집
 *   2) 검색 API(JSON) 시도
 *   3) 상품 링크(/product/{id}) 정규식 폴백
 *
 * 반환 항목은 당근과 동일한 형태로 정규화하고, 필터는 daangn 의 matchesWatch 를
 * 그대로 재사용해 키워드/지역/희망가 동작을 일치시킨다.
 */

const { formatPrice, parsePriceValue } = require('./price');
const { matchesWatch } = require('./daangn');

const BASE = 'https://web.joongna.com';
// {kw} 는 URL 인코딩된 키워드로 치환. 환경변수로 재정의 가능.
const SEARCH_URL = process.env.JOONGNA_SEARCH_URL || 'https://web.joongna.com/search/{kw}';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

async function fetchText(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/json,*/*',
        'Accept-Language': 'ko-KR,ko;q=0.9',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

// 검색 결과는 페이지 로드 후 API 로 불러오므로 API 를 직접 호출한다.
// 여러 후보 엔드포인트/바디를 시도하고, 응답 JSON 에서 매물 객체를 수집한다.
function apiCandidates(keyword) {
  const url = 'https://search-api.joongna.com/v3/search/all';
  // 검색어 필드는 searchWord (keyword 는 무시됨). keywordSource:"INPUT_KEYWORD".
  const body = {
    searchWord: keyword,
    keywordSource: 'INPUT_KEYWORD',
    actionDetailType: 'NONE',
    page: 0,
    size: 50,
    sort: 'RECENT_SORT',
    filter: {},
  };
  return [{ method: 'POST', url, body }];
}

// 응답에서 검색 결과 배열(data.items)을 뽑는다.
// 키워드가 없거나 매치가 없으면 추천상품이 섞여 오지만, 최종 matchesWatch(키워드 토큰)
// 필터가 무관한 항목을 걸러내므로 여기서는 배열만 정규화한다.
function extractSearchItems(json) {
  const d = (json && json.data) || {};
  const cand =
    d.items ||
    d.productList ||
    d.products ||
    d.list ||
    (d.searchResult && d.searchResult.items);
  const out = [];
  if (Array.isArray(cand)) collectProducts(cand, out, new Set());
  return out;
}

async function fetchApiItems(keyword, debugLog) {
  for (const ep of apiCandidates(keyword)) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 20000);
    try {
      const res = await fetch(ep.url, {
        method: ep.method,
        signal: ctrl.signal,
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'application/json, text/plain, */*',
          'Accept-Language': 'ko-KR,ko;q=0.9',
          'Content-Type': 'application/json',
          Origin: 'https://web.joongna.com',
          Referer: 'https://web.joongna.com/',
        },
        body: ep.method === 'POST' ? JSON.stringify(ep.body) : undefined,
      });
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch (_) {}
      const out = json ? extractSearchItems(json) : [];
      if (out.length) return normalizeItems(out);
    } catch (_) {
      /* 다음 후보로 폴백 */
    } finally {
      clearTimeout(t);
    }
  }
  return null;
}

// 문자열에서 <script ...>{...}</script> 의 JSON 블록들을 추출 (application/json, __NEXT_DATA__ 등)
function extractJsonBlocks(html) {
  const blocks = [];
  const re =
    /<script[^>]*type="application\/(?:ld\+)?json"[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const raw = m[1].trim();
    if (raw) blocks.push(raw);
  }
  return blocks;
}

// 임의의 JSON 트리를 순회하며 매물처럼 보이는 객체(id + 제목 + 가격)를 수집
function collectProducts(node, out, seen) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const x of node) collectProducts(x, out, seen);
    return;
  }
  const id = node.seq ?? node.productSeq ?? node.productId ?? node.articleId ?? node.id;
  const title = node.title ?? node.productTitle ?? node.name ?? node.subject;
  const priceRaw = node.price ?? node.productPrice ?? node.sellPrice ?? node.priceValue;
  const looksProduct = id != null && title && priceRaw != null && !isNaN(Number(priceRaw));

  if (looksProduct) {
    const key = String(id);
    if (!seen.has(key)) {
      seen.add(key);
      let region =
        node.locationNames || node.regionName || node.region || node.addressName ||
        node.sellerLocation || node.location || '';
      if (Array.isArray(region)) region = region.filter(Boolean).join(' ');
      const image =
        node.imageUrl || node.img || node.thumbnail || node.image || node.thumbImageUrl || '';
      out.push({
        id: key,
        title: String(title),
        price: String(priceRaw),
        region: String(region || ''),
        image: typeof image === 'string' ? image : '',
        url: `${BASE}/product/${key}`,
        publishedAt:
          node.createdAt || node.createdDate || node.registeredAt || node.updateDate || '',
      });
    }
  }
  for (const k of Object.keys(node)) collectProducts(node[k], out, seen);
}

// 폴백: HTML 에서 상품 링크(/product/{id})만이라도 긁는다 (제목/가격 불명)
function parseProductLinks(html, out, seen) {
  const re = /\/product\/(\d{4,})/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const key = m[1];
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ id: key, title: '', price: '', region: '', image: '', url: `${BASE}/product/${key}` });
    }
  }
}

// 원시 매물 배열을 정규화 (가격 표시/숫자값 부여)
function normalizeItems(rawItems) {
  return rawItems.map((it) => ({
    id: it.id,
    title: it.title || '',
    // 중고나라의 무료 매물은 사이트 표기에 맞춰 "0원"으로 유지한다.
    price: formatPrice(it.price, '0원'),
    priceValue: parsePriceValue(it.price),
    region: it.region || '',
    url: it.url,
    image: it.image || '',
    publishedAt: normalizeTimestamp(it.publishedAt),
  }));
}

function normalizeTimestamp(value) {
  if (value == null || value === '') return '';
  const raw = String(value);
  const milliseconds = /^\d{10}$/.test(raw) ? Number(raw) * 1000 : /^\d{13}$/.test(raw) ? Number(raw) : Date.parse(raw);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : '';
}

/**
 * 중고나라 검색 결과(원시 매물) 파싱.
 * @param {string} html
 */
function parseItems(html) {
  const out = [];
  const seen = new Set();

  for (const block of extractJsonBlocks(html)) {
    try {
      collectProducts(JSON.parse(block), out, seen);
    } catch (_) {
      /* JSON 파싱 실패한 블록은 건너뜀 */
    }
  }
  // 제목/가격이 있는 항목이 하나도 없으면 링크 폴백으로라도 채운다
  if (out.length === 0) parseProductLinks(html, out, seen);

  return normalizeItems(out);
}

/**
 * 검색 + 파싱 + 필터(키워드/지역/희망가는 당근과 동일 규칙).
 * @param {{keyword:string,location:string,maxPrice?:number}} watch
 * @returns {Promise<Array>}
 */
async function searchJoongna(watch) {
  const debug = process.env.DEBUG === 'true' ? [] : null;

  // 1) 검색 API 우선 (제목/가격/지역 포함)
  let items = await fetchApiItems(watch.keyword, debug);
  let via = 'API';

  // 2) API 실패 시 검색 페이지 HTML 폴백 (링크만이라도)
  let html = null;
  if (!items || !items.length) {
    via = 'HTML';
    const url = SEARCH_URL.replace('{kw}', encodeURIComponent(watch.keyword));
    html = await fetchText(url);
    items = parseItems(html);
  }

  const matched = items.filter((it) => matchesWatch(it, watch));

  if (debug) {
    console.log(`    [DEBUG] 중고나라(${via}) 파싱 ${items.length}건, 매칭 ${matched.length}건`);
    matched.slice(0, 5).forEach((it) =>
      console.log(`    [DEBUG] · ${it.title || '(제목없음)'} | ${it.price || '-'} | 지역:${it.region || '(없음)'} | ${it.url}`)
    );
  }
  return matched;
}

module.exports = { searchJoongna, parseItems };

'use strict';

/**
 * 번개장터(bunjang.com) 검색 및 파싱 모듈.
 *
 * 번개장터는 공개 검색 API(find_v2.json)를 제공한다.
 *   GET https://api.bunjang.com/api/1/find_v2.json?q=키워드&order=date&n=100&...
 *   → { list: [ { pid, name, price, location, product_image, update_time, ... } ] }
 *
 * 반환 항목은 당근과 동일한 형태로 정규화하고, 필터는 daangn 의 matchesWatch 를
 * 그대로 재사용해 키워드/지역/희망가 동작을 일치시킨다.
 */

const { formatPrice, parsePriceValue } = require('./price');
const { matchesWatch } = require('./daangn');

// {kw} 는 URL 인코딩된 키워드로 치환. 환경변수로 재정의 가능(단일 URL).
const SEARCH_API = process.env.BUNJANG_SEARCH_URL || '';

// find_v2.json 을 서빙하는 후보 호스트들 (api 서브도메인이 바뀌는 경우 대비)
function candidateUrls(keyword) {
  if (SEARCH_API) return [SEARCH_API.replace('{kw}', encodeURIComponent(keyword))];
  const qs =
    `q=${encodeURIComponent(keyword)}&order=date&page=0&n=100&stat_device=w&req_ref=search&version=4`;
  // api.bunjang.co.kr 가 현재 동작(.com 은 DNS 없음). 나머지는 폴백.
  return [
    `https://api.bunjang.co.kr/api/1/find_v2.json?${qs}`,
    `https://api.bunjang.com/api/1/find_v2.json?${qs}`,
    `https://www.bunjang.com/api/1/find_v2.json?${qs}`,
  ];
}

// 매물 상세 페이지 도메인
const PRODUCT_BASE = 'https://www.bunjang.com/products';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

async function fetchJson(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    let res;
    try {
      res = await fetch(url, {
        signal: ctrl.signal,
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'application/json, text/plain, */*',
          'Accept-Language': 'ko-KR,ko;q=0.9',
          Referer: 'https://www.bunjang.com/',
        },
      });
    } catch (e) {
      // 연결 단계 오류(fetch failed)의 실제 원인을 드러낸다.
      const c = e && e.cause ? ` (${e.cause.code || e.cause.message || e.cause})` : '';
      throw new Error(`${e.message}${c} [${url.slice(0, 60)}…]`);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

// 번개장터 지역 코드는 문자열/배열로 올 수 있어 정규화
function toRegion(loc) {
  if (!loc) return '';
  if (Array.isArray(loc)) return loc.filter(Boolean).join(' ');
  return String(loc);
}

// find_v2 응답의 list 항목을 정규화된 매물로 변환
function normalizeItems(list) {
  return list
    .filter((p) => p && (p.pid || p.pid === 0))
    .map((p) => {
      const priceRaw = p.price != null ? p.price : p.product_price;
      return {
        id: String(p.pid),
        title: p.name || p.title || '',
        // 번개장터의 무료 매물은 사이트 표기에 맞춰 "0원"으로 유지한다.
        price: formatPrice(priceRaw, '0원'),
        priceValue: parsePriceValue(priceRaw),
        region: toRegion(p.location || p.location_name || p.region || ''),
        url: `${PRODUCT_BASE}/${p.pid}`,
        image: p.product_image || p.image || '',
        publishedAt: normalizeTimestamp(p.update_time || p.created_at || p.createdAt),
      };
    });
}

function normalizeTimestamp(value) {
  if (value == null || value === '') return '';
  const raw = String(value);
  const milliseconds = /^\d{10}$/.test(raw) ? Number(raw) * 1000 : /^\d{13}$/.test(raw) ? Number(raw) : Date.parse(raw);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : '';
}

/**
 * 검색 결과 파싱 (list 배열).
 * @param {object} json find_v2 응답
 */
function parseItems(json) {
  const list = json && Array.isArray(json.list) ? json.list : [];
  return normalizeItems(list);
}

/**
 * 검색 + 파싱 + 필터(키워드/지역/희망가는 당근과 동일 규칙).
 * @param {{keyword:string,location:string,maxPrice?:number}} watch
 * @returns {Promise<Array>}
 */
async function searchBunjang(watch) {
  const dbg = process.env.DEBUG === 'true';
  let json = null;
  let lastErr = '';
  for (const url of candidateUrls(watch.keyword)) {
    try {
      const j = await fetchJson(url);
      if (j && Array.isArray(j.list)) {
        json = j;
        if (dbg) console.log(`    [DEBUG] 번개장터 호스트 OK → ${url.split('?')[0]}`);
        break;
      }
    } catch (e) {
      lastErr = e.message;
    }
  }

  if (!json) {
    throw new Error(`번개장터 검색 실패 (${lastErr})`);
  }

  const items = parseItems(json);
  const matched = items.filter((it) => matchesWatch(it, watch));

  if (dbg) {
    console.log(
      `    [DEBUG] 번개장터 list ${json.list.length}건, 파싱 ${items.length}건, 매칭 ${matched.length}건`
    );
    matched.slice(0, 5).forEach((it) =>
      console.log(`    [DEBUG] · ${it.title || '(제목없음)'} | ${it.price || '-'} | 지역:${it.region || '(없음)'} | ${it.url}`)
    );
  }
  return matched;
}

module.exports = { searchBunjang, parseItems };

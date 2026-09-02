'use strict';

/**
 * 당근마켓(중고거래) 검색 및 파싱 모듈.
 *
 * 당근마켓 웹 검색 페이지를 가져와서 매물 목록을 구조화된 객체 배열로 변환한다.
 * 당근마켓은 SSR(Next.js 계열) 페이지이므로 다음 순서로 데이터를 추출한다.
 *   1) JSON-LD (<script type="application/ld+json">) 의 ItemList / Product
 *   2) __NEXT_DATA__ 등 페이지에 임베드된 JSON
 *   3) 위 방법이 실패하면 매물 링크(<a href>) 기반 정규식 파싱 (폴백)
 *
 * 마크업이 바뀌면 parseItems() 내부의 추출기만 손보면 된다.
 */

// 시/도 → 시/군/구 → 읍/면/동 데이터 (시 단위 입력을 동 목록으로 확장해 매칭)
let REGIONS = {};
try {
  REGIONS = require('./regions-data');
} catch (_) {
  /* 데이터 파일이 없어도 기본 매칭은 동작 */
}

// 가격 정규화 유틸 (당근/중고나라 공용)
const { formatPrice, parsePriceValue } = require('./price');

// 검색 URL 템플릿. {kw} 는 URL 인코딩된 키워드로 치환된다.
// 기존 경로(/kr/buy-sell/)는 SSR 로 매물 데이터를 실어주어 서버측 파싱이 가능하며,
//   in=<지역코드>(예: 매탄동-4535)를 붙이면 그 동네로 검색된다(로그인 불필요, 실측 확인).
//   지역코드 없이 호출하면 기본지역(서초4동) 결과가 나온다.
// 참고: 신형 경로(/kr/buy-sell/s/)도 in= 를 반영하지만 결과가 클라이언트 렌더링 +
//   PoW(봇 차단)로 보호돼 서버측 파싱이 불가하므로 사용하지 않는다.
// 환경변수 DAANGN_SEARCH_URL 로 재정의 가능.
const DEFAULT_SEARCH_URL = 'https://www.daangn.com/kr/buy-sell/?search={kw}';

// 당근 검색은 in=이 없으면 실행 환경과 무관하게 서초4동 결과를 돌려준다. 관리 화면에서
// 시/군/구만 선택한 기존 감시도 엉뚱한 기본 지역으로 조회되지 않도록 대표 동네를 사용한다.
// 사용자가 daangnRegion을 직접 지정하면 그 값을 항상 우선한다.
// 대표 동네는 당근 검색의 "중심점"일 뿐이다(watch.daangnRegion 처럼 결과를 그 동네로
// 엄격히 제한하지 않는다). 시 전체(수원시) 감시는 시의 중앙에 가까운 동네를 중심점으로 잡아
// 서초4동 기본지역 폴백을 피하고, 실제 지역 일치는 넓은 location('수원시') 조건으로 판단한다.
const DEFAULT_REGION_BY_LOCATION = Object.freeze({
  수원시: '매탄동-4535',
  수원시영통구: '매탄동-4535',
  영통구: '매탄동-4535',
});

// 매물 상세 페이지의 기본 도메인 (상대경로 -> 절대경로 변환용)
const BASE_URL = 'https://www.daangn.com';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

/**
 * 검색어로 당근마켓 검색 결과 HTML 을 가져온다.
 * @param {string} keyword
 * @returns {Promise<string>} HTML 문자열
 */
function buildSearchUrl(keyword, region) {
  const template = process.env.DAANGN_SEARCH_URL || DEFAULT_SEARCH_URL;
  let url = template.replaceAll('{kw}', encodeURIComponent(keyword));
  if (region) url += `${url.includes('?') ? '&' : '?'}in=${encodeURIComponent(region)}`;
  return url;
}

function resolveDaangnRegion(watch) {
  const explicit = String((watch && watch.daangnRegion) || '').trim();
  if (explicit) return explicit;
  return DEFAULT_REGION_BY_LOCATION[normalize(watch && watch.location)] || '';
}

async function fetchSearchHtml(keyword, region) {
  const url = buildSearchUrl(keyword, region);

  // /s/ 검색의 in=으로 동네를 지정하고, 로그인 전용 결과가 필요한 경우에는
  // DAANGN_COOKIE 시크릿의 브라우저 세션도 함께 전달한다.
  const headers = {
    'User-Agent': USER_AGENT,
    Accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
  };
  if (process.env.DAANGN_COOKIE) headers.Cookie = process.env.DAANGN_COOKIE;

  const res = await fetch(url, { headers });

  if (!res.ok) {
    throw new Error(`당근마켓 검색 요청 실패: HTTP ${res.status} (${url})`);
  }
  return res.text();
}

/**
 * 문자열을 비교용으로 정규화 (공백 제거 + 소문자).
 */
function normalize(s) {
  return String(s || '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

/**
 * HTML 에서 매물 항목들을 추출한다.
 * @param {string} html
 * @returns {Array<{id:string,title:string,price:string,region:string,url:string,image:string}>}
 */
function parseItems(html) {
  const byId = new Map();

  const add = (item) => {
    if (!item || !item.id) return;
    const id = String(item.id);
    const existing = byId.get(id) || {};
    // 가격은 먼저 확보된(구조적으로 더 신뢰할 수 있는) 값을 보존한다.
    // 나중에 도는 광역 텍스트 스캔(extractFromText)이 이웃 매물의 가격을 덮어써
    // 나눔(0원) 매물에 엉뚱한 고가가 붙어 maxPrice 필터에 탈락하는 것을 막는다.
    const hasExistingPrice = existing.rawPrice != null && existing.rawPrice !== '';
    const rawPrice = hasExistingPrice
      ? existing.rawPrice
      : item.price != null && item.price !== ''
        ? item.price
        : '';
    byId.set(id, {
      id,
      title: item.title || existing.title || '',
      rawPrice,
      price: formatPrice(rawPrice),
      priceValue: parsePriceValue(rawPrice), // 숫자 가격(원). 나눔=0, 불명=null
      region: item.region || existing.region || '',
      url: item.url || existing.url || `${BASE_URL}/kr/buy-sell/${id}/`,
      image: item.image || existing.image || '',
      publishedAt: item.publishedAt || existing.publishedAt || '',
    });
  };

  // --- 1) JSON-LD ---
  for (const block of extractJsonLd(html)) {
    for (const node of flattenJsonLd(block)) {
      if (!node || typeof node !== 'object') continue;
      const type = node['@type'];
      if (type === 'Product' || type === 'ListItem' || node.url || node.name) {
        const target = node.item && typeof node.item === 'object' ? node.item : node;
        const url = target.url || node.url;
        const id = extractIdFromUrl(url);
        if (!id && !target.name) continue;
        add({
          id: id || slugId(target.name),
          title: target.name,
          price: extractPrice(target),
          region: target.address || target.areaServed || '',
          url: absolutize(url),
          image: firstImage(target.image),
          publishedAt: normalizePublishedAt(
            target.datePosted || target.datePublished || target.uploadDate || target.createdAt
          ),
        });
      }
    }
  }

  // --- 2) <a> 태그 기반 매물 카드 파싱 ---
  const linkRe =
    /<a[^>]+href="((?:https?:\/\/[^"]+)?\/(?:kr\/buy-sell|articles)\/[^"]*?)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = linkRe.exec(html)) !== null) {
    const href = m[1];
    const inner = m[2];
    const id = extractIdFromUrl(href);
    if (!id) continue;
    const text = stripTags(inner);
    add({
      id,
      title: pickTitle(inner) || text,
      price: pickPrice(inner),
      region: pickRegion(inner),
      url: absolutize(href),
      image: pickImage(inner),
      publishedAt: pickPublishedAt(inner),
    });
  }

  // --- 3) 임베드 JSON / RSC 스트림 파싱 ---
  // 최신 당근 웹은 Next.js RSC 스트림(self.__next_f.push[...])에 매물 데이터를
  // 이스케이프된 문자열로 담는다. 원본과 언이스케이프본 양쪽에서 매물 URL과
  // 주변 필드(title/price/region)를 추출한다.
  extractFromText(html, add);
  extractFromText(deEscape(html), add);

  return Array.from(byId.values());
}

// 이스케이프된 JSON 문자열( /, \" 등 )을 실제 문자로 복원
function deEscape(s) {
  return String(s)
    .replace(/\\u002[fF]/g, '/')
    .replace(/\\u0026/g, '&')
    .replace(/\\\//g, '/')
    .replace(/\\"/g, '"');
}

// 당근 매물 JSON 은 보통 {title, price, region, url} 순서라, 한 매물의 필드는 자기 url "앞"에 온다.
// 따라서 url 위치(center) 기준으로 "바로 앞의 가장 가까운" 값을 고른다(없으면 뒤쪽 최근접).
// 예전엔 창 안 첫 매칭(leftmost)을 써서 이웃 매물의 title/price 가 잘못 붙었다.
function nearestValue(matches, center) {
  let before = null;
  let beforeIdx = -1;
  let after = null;
  let afterDist = Infinity;
  for (const { idx, val } of matches) {
    if (idx <= center) {
      if (idx > beforeIdx) {
        beforeIdx = idx;
        before = val;
      }
    } else {
      const d = idx - center;
      if (d < afterDist) {
        afterDist = d;
        after = val;
      }
    }
  }
  return before != null ? before : after;
}

function matchFieldNear(win, keys, center) {
  const matches = [];
  for (const k of keys) {
    const re = new RegExp('"' + k + '"\\s*:\\s*"([^"]{1,120})"', 'ig');
    let mm;
    while ((mm = re.exec(win)) !== null) matches.push({ idx: mm.index, val: mm[1] });
  }
  const v = nearestValue(matches, center);
  return v == null ? '' : v;
}

// 가격 필드: 문자열("price":"0")·숫자("price":0)·명시적 무료 플래그를 인식하고 url 앞 최근접을 고른다.
// 나눔 매물은 당근이 "price":0 으로 내려주므로 자기 가격(0)이 최근접으로 잡힌다.
// ⚠️ "나눔" 같은 제목 텍스트는 가격 신호로 쓰지 않는다(이웃 매물 제목이 창에 섞여 오탐).
function matchPriceNear(win, center) {
  const matches = [];
  const re = /"(?:price|salePrice|sellPrice|priceValue)"\s*:\s*(?:"([^"]{1,20})"|(\d{1,12}))/gi;
  let mm;
  while ((mm = re.exec(win)) !== null) {
    matches.push({ idx: mm.index, val: mm[1] != null ? mm[1] : mm[2] });
  }
  // isFree/free/sharing:true 도 0원 신호로 취급하되, 위치를 기록해 "최근접"으로만 채택(이웃 오탐 방지).
  const fre = /"(?:isFree|free|sharing)"\s*:\s*true/gi;
  while ((mm = fre.exec(win)) !== null) matches.push({ idx: mm.index, val: '0' });
  const v = nearestValue(matches, center);
  return v == null ? '' : v;
}

function matchPublishedAtNear(win, center) {
  const matches = [];
  const re = /"(?:createdAt|publishedAt|published_at|created_at|datePosted)"\s*:\s*(?:"([^"]{4,40})"|(\d{10,13}))/gi;
  let mm;
  while ((mm = re.exec(win)) !== null) {
    matches.push({ idx: mm.index, val: normalizePublishedAt(mm[1] || mm[2]) });
  }
  return nearestValue(matches.filter((m) => m.val), center) || '';
}

// 카드 본문 텍스트에서 동네(…동/읍/면/가) 토큰을 추출. 태그/JSON 경계를 넘지 않도록
// 링크 직후 구간에서 뒤에 한글이 붙지 않는 첫 지역 토큰을 찾는다.
function extractNeighborhood(s) {
  const m = String(s).match(/([가-힣]{2,}[0-9]{0,2}(?:동|읍|면|가))(?![가-힣])/);
  return m ? m[1] : '';
}

// 텍스트(HTML/JSON)에서 매물 URL 을 찾아 주변 창(window)에서 필드를 추출
function extractFromText(text, add) {
  // 슬러그 전체를 탐욕적으로 잡아 마지막 하이픈 세그먼트(진짜 id)까지 포함시킨다.
  const urlRe =
    /(?:https?:\/\/www\.daangn\.com)?\/(?:kr\/buy-sell\/[^"'\\\s)]*-[0-9a-zA-Z]{5,}|articles\/\d+)\/?/g;
  let m;
  while ((m = urlRe.exec(text)) !== null) {
    const href = m[0];
    const id = extractIdFromUrl(href);
    if (!id) continue;
    const start = Math.max(0, m.index - 500);
    const end = Math.min(text.length, m.index + 500);
    const win = text.slice(start, end);
    const center = m.index - start; // 창 안에서의 URL 위치
    let price = matchPriceNear(win, center);
    if (!price) {
      // 폴백: 링크 직후 좁은 구간에서만 "N원" 을 찾는다(이웃 매물 가격 오염 방지).
      const near = text.slice(m.index, m.index + 200);
      price = (near.match(/([0-9][0-9,]{2,})\s*원/) || [])[1] || '';
    }
    // 지역: JSON 필드(URL 최근접) 우선, 없으면 링크 뒤쪽(카드 본문)에서 동네(…동/읍/면/가) 추출
    let region = matchFieldNear(win, ['regionName', 'region', 'address', 'areaName', 'location'], center);
    if (!region) region = extractNeighborhood(text.slice(m.index, m.index + 900));
    add({
      id,
      title: matchFieldNear(win, ['title', 'name', 'subject'], center),
      price,
      region,
      url: absolutize(href),
      image: '',
      publishedAt: matchPublishedAtNear(win, center),
    });
  }
}

/* ------------------------- 필터링 ------------------------- */

/**
 * 지역 미입력(또는 '전국'/'전체')이면 전국 검색으로 간주.
 */
function isNationwide(location) {
  const loc = normalize(location);
  return !loc || loc === '전국' || loc === '전체' || loc === 'all';
}

/**
 * 지역 문자열의 매칭 후보들을 만든다.
 * 당근은 매물 위치를 '수원시 영통구' 처럼 전체로 주기도, '영통동' 처럼 동만 주기도 한다.
 * 그래서 입력값과 행정구역 접미사를 뗀 어간(수원시 -> 수원)을 모두 후보로 사용한다.
 */
function locationVariants(location) {
  const loc = normalize(location);
  if (!loc) return [];
  const variants = new Set([loc]);

  const addStem = (s) => {
    const stem = s.replace(
      /(특별자치시|특별자치도|특별시|광역시|시|군|구|읍|면|동|리)$/,
      ''
    );
    if (stem && stem.length >= 2 && stem !== s) variants.add(stem);
  };
  addStem(loc);

  // 연결된 행정구역명 분해 (수원시영통구 -> 수원시, 영통구 / 각 어간도 추가)
  const chunks = loc.match(
    /[가-힣]+?(?:특별자치시|특별자치도|특별시|광역시|시|군|구|읍|면|동|리)/g
  );
  if (chunks && chunks.length > 1) {
    for (const c of chunks) {
      if (c.length >= 2) variants.add(c);
      addStem(c);
    }
  }
  return [...variants];
}

// 시/도·시/군/구 입력을 그 안의 읍/면/동 이름 집합으로 확장 (당근은 동 이름으로 표기)
const _dongCache = new Map();
function dongsForLocation(location) {
  const n = normalize(location);
  if (!n) return _EMPTY_SET;
  if (_dongCache.has(n)) return _dongCache.get(n);
  const set = new Set();
  for (const sido of Object.keys(REGIONS)) {
    const nsido = normalize(sido);
    for (const sgg of Object.keys(REGIONS[sido])) {
      const nsgg = normalize(sgg);
      const hit = n === nsido || n === nsgg || nsgg.startsWith(n) || n.startsWith(nsgg);
      if (hit) for (const d of REGIONS[sido][sgg]) set.add(normalize(d));
    }
  }
  _dongCache.set(n, set);
  return set;
}
const _EMPTY_SET = new Set();

/**
 * 매물이 (제목에 키워드 포함) AND (지역 일치) 조건을 만족하는지.
 * - 지역 미입력 = 전국(지역 조건 없음)
 * - 지역 입력 시: 매물 지역/제목에 지역명(또는 어간)이 포함되면 통과
 * - 매물에 지역 정보가 아예 없을 땐 기본 제외(STRICT_REGION=false 면 통과)
 */
function keywordMatches(title, keyword) {
  const t = normalize(title);
  // 다중 단어 키워드는 순서와 무관하게 모든 토큰이 제목에 있으면 매칭
  const tokens = String(keyword || '')
    .trim()
    .split(/\s+/)
    .map(normalize)
    .filter(Boolean);
  if (tokens.length === 0) return true;
  return tokens.every((tok) => t.includes(tok));
}

// 희망 금액(이하) 필터.
// - maxPrice 미설정: 금액 제한 없음
// - maxPrice 0: 무료 매물(priceValue === 0)만 통과
// - maxPrice 양수: 해당 금액 이하. 가격 불명 매물도 놓치지 않도록 통과
function priceWithinMax(item, watch) {
  const hasMaxPrice = Object.prototype.hasOwnProperty.call(watch, 'maxPrice');
  if (!hasMaxPrice || watch.maxPrice === '' || watch.maxPrice == null) return true;
  const maxP = Number(watch.maxPrice);
  if (!Number.isFinite(maxP) || maxP < 0) return true; // 잘못된 설정은 제한 없음으로 처리
  if (maxP === 0) return item.priceValue === 0;
  if (!Number.isFinite(item.priceValue)) return true; // 가격 불명 → 통과
  return item.priceValue <= maxP;
}

// 등록일 필터의 "가장 이른 허용 시각"을 구한다.
// - maxAgeHours: 지금(now)으로부터 정확히 N시간 전까지의 롤링 윈도우 (예: 3시간전)
// - maxAgeDays : 오늘 0시를 기준으로 N일 전까지의 달력 윈도우 (예: 0=오늘, 3=최근 3일)
// 시간 단위가 지정되면 시간을, 아니면 일을 사용한다. 둘 다 없으면 null(제한 없음).
function earliestAllowedAt(watch, now = Date.now()) {
  const hasHours = watch.maxAgeHours !== '' && watch.maxAgeHours != null;
  if (hasHours) {
    const hours = Number(watch.maxAgeHours);
    if (Number.isInteger(hours) && hours >= 0) return now - hours * 3600000;
  }
  const hasDays = watch.maxAgeDays !== '' && watch.maxAgeDays != null;
  if (hasDays) {
    const days = Number(watch.maxAgeDays);
    if (Number.isInteger(days) && days >= 0) {
      const startOfToday = new Date(now);
      startOfToday.setHours(0, 0, 0, 0);
      return startOfToday.getTime() - days * 86400000;
    }
  }
  return null; // 미설정/잘못된 설정 → 제한 없음
}

function ageWithinMax(item, watch, now = Date.now()) {
  const earliest = earliestAllowedAt(watch, now);
  if (earliest == null) return true;
  const published = Date.parse(item.publishedAt || '');
  // 당근 검색 카드가 등록일을 내려주지 않는 경우가 많다. 날짜 불명 매물을 전부 버리면
  // 정상적인 신규 나눔까지 0건이 되므로, 날짜를 확인할 수 있을 때만 범위를 적용한다.
  if (!Number.isFinite(published)) return true;
  return published >= earliest && published <= now;
}

// 알림 메일/이슈에 표시할 등록일 조건 문구. (예: "최근 3시간 이내", "최근 3일 이내")
function describeMaxAge(watch) {
  if (!watch) return '';
  const hasHours = watch.maxAgeHours !== '' && watch.maxAgeHours != null;
  if (hasHours) {
    const hours = Number(watch.maxAgeHours);
    if (Number.isInteger(hours) && hours >= 0) return `최근 ${hours}시간 이내`;
  }
  const hasDays = watch.maxAgeDays !== '' && watch.maxAgeDays != null;
  if (hasDays) {
    const days = Number(watch.maxAgeDays);
    if (Number.isInteger(days) && days >= 0) return `최근 ${days}일 이내`;
  }
  return '';
}

function isGenericFreeKeyword(watch) {
  if (Number(watch && watch.maxPrice) !== 0) return false;
  return /^(?:나눔|무료나눔|무료)$/.test(normalize(watch && watch.keyword));
}

function isAllItemsKeyword(watch) {
  return /^(?:모두|전체|all)$/.test(normalize(watch && watch.keyword));
}

// "모두"는 필터 의미이지 당근 검색어가 아니다. 무료 전체 감시에서는 당근이 실제로
// 무료 매물 후보를 반환할 수 있도록 검색어를 "나눔"으로 변환한다.
function searchKeywordForWatch(watch) {
  if ((watch.allItems || isAllItemsKeyword(watch)) && Number(watch.maxPrice) === 0) return '나눔';
  return watch.keyword;
}

function itemMatchesLocation(item, location) {
  if (isNationwide(location)) return true;

  const hay = normalize(`${item.region} ${item.title}`);
  // 당근 등은 행정동(매탄3동)으로 표기하지만 지역 데이터는 법정동(매탄동)이라
  // 동/가/읍/면 앞 숫자를 제거한 버전도 함께 비교한다. (매탄3동 → 매탄동)
  const hayDong = hay.replace(/([가-힣])\d+(동|가|읍|면)/g, '$1$2');
  const variants = locationVariants(location);
  if (variants.some((v) => hay.includes(v) || hayDong.includes(v))) return true;

  // 시/구 단위 입력 → 그 안의 동 이름이 매물 지역/제목에 있으면 매칭
  for (const d of dongsForLocation(location)) {
    if (d.length >= 2 && (hay.includes(d) || hayDong.includes(d))) return true;
  }
  return false;
}

function regionNameFromSlug(region) {
  return String(region || '').trim().replace(/-\d+$/, '');
}

function matchesWatch(item, watch) {
  // allItems는 검색어를 후보 조회에만 사용하고 제품명 필터는 적용하지 않는다.
  // 이전 설정과의 호환성을 위해 무료 모드의 범용 키워드도 같은 방식으로 처리한다.
  if (
    !watch.allItems &&
    !isAllItemsKeyword(watch) &&
    !isGenericFreeKeyword(watch) &&
    !keywordMatches(item.title, watch.keyword)
  ) {
    return false;
  }
  if (!priceWithinMax(item, watch)) return false;
  if (!ageWithinMax(item, watch)) return false;

  if (!itemMatchesLocation(item, watch.location)) return false;

  // in= 값이 잘못되거나 당근이 기본 지역으로 폴백해도 다른 동네를 알리지 않도록,
  // URL의 지역 slug(매탄동-4535 → 매탄동)도 실제 카드 지역과 반드시 대조한다.
  // 사용자가 직접 입력한 지역 코드는 해당 동네로 엄격히 제한한다. 시/군/구 감시에
  // 자동 적용한 대표 동네는 검색의 중심점일 뿐이므로 위의 넓은 location 조건을 유지한다.
  const scopedLocation = regionNameFromSlug(watch.daangnRegion);
  if (scopedLocation && !itemMatchesLocation(item, scopedLocation)) return false;

  // 지역을 지정했는데 카드 지역을 파싱하지 못한 경우는 오알림 방지를 위해 fail-closed.
  if (!item.region && !isNationwide(watch.location)) return false;
  return true;
}

/**
 * 검색 + 파싱 + 필터를 한 번에 수행.
 * @param {{keyword:string,location:string}} watch
 * @returns {Promise<Array>} 조건을 만족하는 매물 목록
 */
async function searchDaangn(watch) {
  const daangnRegion = resolveDaangnRegion(watch);
  const html = await fetchSearchHtml(searchKeywordForWatch(watch), daangnRegion);
  const items = parseItems(html);
  // 쿠키나 in= 응답을 신뢰해 지역 검사를 생략하지 않는다. 당근이 잘못된/기본 지역으로
  // 폴백할 수 있으므로 모든 카드를 watch.location 및 daangnRegion과 다시 대조한다.
  const matched = items.filter((it) => matchesWatch(it, watch));

  if (process.env.DEBUG === 'true') {
    console.log(
      `    [DEBUG] HTML ${html.length}자, 파싱된 매물 ${items.length}건, 매칭 ${matched.length}건` +
        (daangnRegion ? ` (in=${daangnRegion} 지역검색)` : ' (지역코드 없음: 당근 기본지역 응답)') +
        (process.env.DAANGN_COOKIE ? ' (로그인 쿠키)' : '') +
        (isNationwide(watch.location) ? ' (전국 검색)' : '')
    );
    // 매물 링크가 페이지에 몇 번 등장하는지(파서와 무관한 원자료 신호)
    const rawLinks = (html.match(/\/kr\/buy-sell\//g) || []).length;
    const hasNextData = html.includes('__NEXT_DATA__') || html.includes('__next_f');
    console.log(
      `    [DEBUG] buy-sell 링크 흔적 ${rawLinks}회, RSC/NEXT ${hasNextData ? '있음' : '없음'}`
    );
    if (items.length === 0) {
      // 파싱 0건이면 페이지 앞부분을 덤프해 차단/리다이렉트/JS쉘 여부 확인
      const snippet = html.replace(/\s+/g, ' ').slice(0, 400);
      console.log(`    [DEBUG] HTML 앞부분: ${snippet}`);
    }
    items.slice(0, 5).forEach((it) =>
      console.log(`    [DEBUG] · ${it.title || '(제목없음)'} | ${it.region || '-'} | ${it.url}`)
    );
  }
  return matched;
}

/* ------------------------- 헬퍼 ------------------------- */

function extractJsonLd(html) {
  const out = [];
  const re =
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      out.push(JSON.parse(m[1].trim()));
    } catch (_) {
      /* 무시 */
    }
  }
  return out;
}

function flattenJsonLd(node, acc = []) {
  if (Array.isArray(node)) {
    node.forEach((n) => flattenJsonLd(n, acc));
  } else if (node && typeof node === 'object') {
    acc.push(node);
    if (Array.isArray(node.itemListElement)) {
      flattenJsonLd(node.itemListElement, acc);
    }
    if (Array.isArray(node['@graph'])) {
      flattenJsonLd(node['@graph'], acc);
    }
  }
  return acc;
}

function extractIdFromUrl(url) {
  if (!url) return '';
  // 예: /kr/buy-sell/멋진-가마솥-abcdef123456/  또는 /articles/123456789
  const mBuySell = String(url).match(/\/kr\/buy-sell\/[^/?#]*?-([0-9a-zA-Z]+)\/?(?:[?#]|$)/);
  if (mBuySell) return mBuySell[1];
  const mArticle = String(url).match(/\/articles\/(\d+)/);
  if (mArticle) return mArticle[1];
  const mGeneric = String(url).match(/\/([0-9a-zA-Z]{6,})\/?(?:[?#]|$)/);
  if (mGeneric) return mGeneric[1];
  return '';
}

function extractPrice(node) {
  if (node.offers) {
    const offer = Array.isArray(node.offers) ? node.offers[0] : node.offers;
    if (offer && (offer.price || offer.price === 0)) {
      return `${offer.price}${offer.priceCurrency ? ' ' + offer.priceCurrency : ''}`;
    }
  }
  return node.price || '';
}

function firstImage(image) {
  if (!image) return '';
  if (typeof image === 'string') return image;
  if (Array.isArray(image)) return firstImage(image[0]);
  if (typeof image === 'object') return image.url || image.contentUrl || '';
  return '';
}

function slugId(name) {
  return normalize(name).slice(0, 40);
}

function absolutize(url) {
  if (!url) return '';
  if (/^https?:\/\//i.test(url)) return url;
  return BASE_URL + (url.startsWith('/') ? url : '/' + url);
}

function stripTags(s) {
  return String(s || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// 폴백 파서에서 매물 카드 내부 텍스트로부터 제목/가격/지역/이미지 추정
function pickTitle(inner) {
  const m =
    inner.match(/class="[^"]*(?:title|name)[^"]*"[^>]*>([\s\S]*?)</i) ||
    inner.match(/<(?:h\d|strong|span)[^>]*>([\s\S]*?)<\//i);
  return m ? stripTags(m[1]) : '';
}
function pickPrice(inner) {
  const m =
    inner.match(/class="[^"]*price[^"]*"[^>]*>([\s\S]*?)</i) ||
    inner.match(/([0-9][0-9,]*)\s*원/) ||
    inner.match(/(무료나눔|나눔|무료)/);
  return m ? stripTags(m[1]) : '';
}
function pickRegion(inner) {
  const m = inner.match(/class="[^"]*(?:region|location|area)[^"]*"[^>]*>([\s\S]*?)</i);
  return m ? stripTags(m[1]) : '';
}
function pickImage(inner) {
  const m = inner.match(/<img[^>]+src="([^"]+)"/i);
  return m ? m[1] : '';
}

function normalizePublishedAt(value) {
  if (value == null || value === '') return '';
  const raw = String(value).trim();
  if (/^\d{10,13}$/.test(raw)) {
    const milliseconds = raw.length === 10 ? Number(raw) * 1000 : Number(raw);
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? '' : date.toISOString();
  }
  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : '';
}

function pickPublishedAt(inner) {
  const datetime = String(inner).match(/datetime=["']([^"']+)["']/i);
  if (datetime) return normalizePublishedAt(datetime[1]);
  return '';
}

module.exports = {
  buildSearchUrl,
  resolveDaangnRegion,
  fetchSearchHtml,
  parseItems,
  matchesWatch,
  searchDaangn,
  normalize,
  describeMaxAge,
};

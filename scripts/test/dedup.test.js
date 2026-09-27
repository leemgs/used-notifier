'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { kstDay, daysBetweenDays, normalizeSeen, pruneSeen } = require('../check_daangn');

test('kstDay 는 UTC 시각을 한국(UTC+9) 날짜로 변환한다', () => {
  // 2026-09-26 20:00Z = 한국 2026-09-27 05:00 → 날짜는 09-27
  assert.equal(kstDay(Date.parse('2026-09-26T20:00:00Z')), '2026-09-27');
  // 2026-09-27 14:00Z = 한국 2026-09-27 23:00 → 09-27
  assert.equal(kstDay(Date.parse('2026-09-27T14:00:00Z')), '2026-09-27');
  // 2026-09-27 15:00Z = 한국 2026-09-28 00:00 → 09-28
  assert.equal(kstDay(Date.parse('2026-09-27T15:00:00Z')), '2026-09-28');
});

test('daysBetweenDays 는 두 날짜의 일수 차를 구한다', () => {
  assert.equal(daysBetweenDays('2026-09-01', '2026-09-01'), 0);
  assert.equal(daysBetweenDays('2026-09-01', '2026-09-04'), 3);
  assert.equal(daysBetweenDays('2026-09-04', '2026-09-01'), -3);
  assert.equal(daysBetweenDays('bad', '2026-09-01'), Infinity);
});

test('normalizeSeen 은 구버전 배열을 오늘 날짜 맵으로 승격한다', () => {
  const m = normalizeSeen(['a', 'b', 'c'], '2026-09-27');
  assert.deepEqual(m, { a: '2026-09-27', b: '2026-09-27', c: '2026-09-27' });
  // 객체는 문자열 날짜 값만 복사
  assert.deepEqual(normalizeSeen({ a: '2026-09-01', bad: 123 }, '2026-09-27'), { a: '2026-09-01' });
  // 그 외 입력은 빈 맵
  assert.deepEqual(normalizeSeen(undefined, '2026-09-27'), {});
  assert.deepEqual(normalizeSeen(null, '2026-09-27'), {});
});

test('pruneSeen 은 보존기간 지난 기록을 지우고 상한을 넘으면 오래된 것부터 지운다', () => {
  const today = '2026-09-27';
  const map = { old: '2026-08-01', midd: '2026-09-20', fresh: '2026-09-27' };
  const changed = pruneSeen(map, today, 30); // 8/1 은 57일 전 → 삭제
  assert.equal(changed, true);
  assert.deepEqual(Object.keys(map).sort(), ['fresh', 'midd']);

  // 상한 초과 시 오래된 날짜부터 제거
  const big = {};
  for (let i = 1; i <= 5; i++) big[`d${i}`] = `2026-09-2${i}`; // 21~25일
  const changed2 = pruneSeen(big, today, 365, 3); // 3개만 남김
  assert.equal(changed2, true);
  assert.deepEqual(Object.keys(big).sort(), ['d3', 'd4', 'd5']);

  // 아무것도 지우지 않으면 false
  assert.equal(pruneSeen({ a: today }, today, 30, 100), false);
});

// 메인 루프의 중복 판정 로직을 헬퍼로 재현해 "하루 1회" 동작을 검증한다.
function simulateRun(prevRaw, foundIds, today) {
  const seenMap = normalizeSeen(prevRaw != null ? prevRaw : undefined, today);
  for (const id of foundIds) {
    if (id in seenMap) seenMap[id] = today; // 계속 노출 중 → 날짜 갱신(재알림 안 함)
  }
  const newIds = foundIds.filter((id) => !(id in seenMap));
  for (const id of newIds) seenMap[id] = today; // 알림 성공 가정 → 기록
  pruneSeen(seenMap, today, 30);
  return { newIds, seenMap };
}

test('같은 매물은 하루에도, 다음 날에도 다시 알리지 않는다(계속 노출 시)', () => {
  // 1일차: 3건 모두 신규
  let r = simulateRun(undefined, ['x', 'y', 'z'], '2026-09-27');
  assert.deepEqual(r.newIds, ['x', 'y', 'z']);

  // 같은 날 재실행(30분 뒤): 동일 매물 → 신규 0
  r = simulateRun(r.seenMap, ['x', 'y', 'z'], '2026-09-27');
  assert.deepEqual(r.newIds, []);

  // 다음 날: 여전히 노출 중 → 신규 0 (여러 날 중복 방지)
  r = simulateRun(r.seenMap, ['x', 'y', 'z'], '2026-09-28');
  assert.deepEqual(r.newIds, []);

  // 새 매물 w 만 신규
  r = simulateRun(r.seenMap, ['x', 'y', 'z', 'w'], '2026-09-28');
  assert.deepEqual(r.newIds, ['w']);
});

test('구버전 배열 상태에서 넘어와도 기존 매물을 다시 알리지 않는다', () => {
  const legacyArray = ['x', 'y'];
  const r = simulateRun(legacyArray, ['x', 'y', 'z'], '2026-09-27');
  assert.deepEqual(r.newIds, ['z']); // 배열의 x,y 는 이미 본 것으로 취급
});

test('오래 사라졌다 재등장한 매물은 보존기간 후 다시 알린다', () => {
  // 최초 알림
  let r = simulateRun(undefined, ['gone'], '2026-07-01');
  assert.deepEqual(r.newIds, ['gone']);
  // 목록에서 사라진 채 보존기간(30일)을 넘기면 기록이 만료(삭제)된다.
  r = simulateRun(r.seenMap, [], '2026-08-15'); // 45일 경과
  assert.deepEqual(Object.keys(r.seenMap), []);
  // 재등장하면 그때 다시 신규로 알린다.
  r = simulateRun(r.seenMap, ['gone'], '2026-08-16');
  assert.deepEqual(r.newIds, ['gone']);
});

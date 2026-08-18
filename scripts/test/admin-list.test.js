'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { filterAndSortWatches } = require('../../docs/assets/watch-list');

const watches = [
  { keyword: '화분', enabled: true },
  { keyword: '롱샴', enabled: false },
  { keyword: '고추대', enabled: false },
  { keyword: '테이블' },
];
const searchableText = (watch) => watch.keyword.toLocaleLowerCase('ko-KR');

test('감시 목록을 사용 상태별로 필터링한다', () => {
  const enabled = filterAndSortWatches(watches, '', 'enabled', searchableText);
  const disabled = filterAndSortWatches(watches, '', 'disabled', searchableText);

  assert.deepEqual(enabled.map(({ watch }) => watch.keyword), ['테이블', '화분']);
  assert.deepEqual(disabled.map(({ watch }) => watch.keyword), ['고추대', '롱샴']);
});

test('필터 후 키워드를 오름차순으로 정렬하고 원본 인덱스를 유지한다', () => {
  const result = filterAndSortWatches(watches, '', 'all', searchableText);

  assert.deepEqual(
    result.map(({ watch, index }) => ({ keyword: watch.keyword, index })),
    [
      { keyword: '고추대', index: 2 },
      { keyword: '롱샴', index: 1 },
      { keyword: '테이블', index: 3 },
      { keyword: '화분', index: 0 },
    ]
  );
});

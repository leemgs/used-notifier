'use strict';

(function initWatchListUtils(root) {
  const keywordCollator = new Intl.Collator('ko-KR', {
    sensitivity: 'base',
    numeric: true,
  });

  function filterAndSortWatches(watches, query, enabledFilter, searchableText) {
    const normalizedQuery = String(query || '').trim().toLocaleLowerCase('ko-KR');
    return watches
      .map((watch, index) => ({ watch, index }))
      .filter(({ watch }) => {
        const enabled = watch.enabled !== false;
        const matchesEnabled =
          enabledFilter === 'all' ||
          (enabledFilter === 'enabled' && enabled) ||
          (enabledFilter === 'disabled' && !enabled);
        return matchesEnabled && (!normalizedQuery || searchableText(watch).includes(normalizedQuery));
      })
      .sort((a, b) => keywordCollator.compare(a.watch.keyword || '', b.watch.keyword || ''));
  }

  const api = { filterAndSortWatches };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WatchListUtils = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

'use strict';

const assert = require('assert');

const BASE_URL = 'https://api.tradera.com';
const ORDER_BY = new Set([
  'Relevance', 'BidsAscending', 'BidsDescending', 'PriceAscending',
  'PriceDescending', 'EndDateAscending', 'EndDateDescending',
]);

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function retryAfterMs(headers, now = Date.now()) {
  const value = headers && typeof headers.get === 'function' ? headers.get('retry-after') : null;
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : 0;
}

function errorMessage(payload, status) {
  const nested = payload && payload.error;
  const first = payload && Array.isArray(payload.errors) ? payload.errors[0] : null;
  const message = nested && (nested.message || nested.description)
    || first && (first.message || first.description)
    || payload && (payload.message || payload.title)
    || `Tradera API returned HTTP ${status}`;
  const code = nested && nested.code || first && (first.code || first.errorCode) || status;
  return `${message} (${code})`;
}

function normalizeSearchResult(payload = {}) {
  const items = payload.items ?? payload.Items ?? payload.searchItems ?? payload.SearchItems ?? [];
  const errors = payload.errors ?? payload.Errors ?? [];
  return {
    total: Math.max(0, Number(payload.totalNumberOfItems ?? payload.TotalNumberOfItems ?? payload.total ?? 0) || 0),
    totalPages: Math.max(0, Number(payload.totalNumberOfPages ?? payload.TotalNumberOfPages ?? payload.totalPages ?? 0) || 0),
    items: Array.isArray(items) ? items : [],
    errors: Array.isArray(errors) ? errors : [],
  };
}

function createTraderaClient(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('Tradera client needs fetch.');
  const appId = String(options.appId || '').trim();
  const appKey = String(options.appKey || '').trim();
  if (!/^\d+$/.test(appId) || !appKey) throw new Error('Add a numeric Tradera App ID and App Key first.');
  const minGapMs = Math.max(0, Number(options.minGapMs) || 125);
  const onRequest = typeof options.onRequest === 'function' ? options.onRequest : () => {};
  let lastRequestAt = 0;
  let blockedUntil = 0;
  let requestCount = 0;

  async function pace() {
    const wait = Math.max(blockedUntil - Date.now(), lastRequestAt + minGapMs - Date.now());
    if (wait > 0) await sleep(wait);
  }

  async function apiGet(pathname, query = {}, kind = 'tradera') {
    await pace();
    const url = new URL(`${BASE_URL}${pathname}`);
    for (const [key, value] of Object.entries(query)) if (value != null && value !== '') url.searchParams.set(key, String(value));
    lastRequestAt = Date.now();
    requestCount += 1;
    onRequest({ kind, ts: lastRequestAt, requestCount });
    const response = await fetchImpl(url.href, {
      headers: { accept: 'application/json', 'x-app-id': appId, 'x-app-key': appKey },
    });
    let payload = null;
    try { payload = await response.json(); } catch { payload = null; }
    if (!response.ok) {
      if (response.status === 429) blockedUntil = Date.now() + Math.max(30_000, retryAfterMs(response.headers));
      const error = new Error(errorMessage(payload, response.status));
      error.status = response.status;
      error.retryAt = blockedUntil || null;
      throw error;
    }
    return payload || {};
  }

  async function search({ query, categoryId = 0, pageNumber = 0, orderBy = 'Relevance' } = {}) {
    const text = String(query || '').trim().slice(0, 120);
    if (!text) throw new Error('Tradera search needs a query.');
    const result = normalizeSearchResult(await apiGet('/v4/search', {
      query: text,
      categoryId: Math.max(0, Number(categoryId) || 0),
      pageNumber: Math.max(0, Number(pageNumber) || 0),
      orderBy: ORDER_BY.has(orderBy) ? orderBy : 'Relevance',
    }, 'search'));
    if (result.errors.length) {
      const first = result.errors[0] || {};
      const error = new Error(first.message || first.description || first.errorMessage || 'Tradera search returned an error.');
      error.code = first.code || first.errorCode || 'SEARCH_ERROR';
      throw error;
    }
    return result;
  }

  async function getItem(itemId) {
    const id = String(itemId || '').trim();
    if (!/^\d+$/.test(id)) throw new Error('Invalid Tradera item id.');
    return apiGet(`/v4/items/${id}`, {}, 'item');
  }

  async function health() {
    const payload = await apiGet('/v4/reference-data/time', {}, 'health');
    return { ok: true, serverTime: payload.time || payload.Time || null };
  }

  return {
    search,
    getItem,
    health,
    status: () => ({ requestCount, lastRequestAt, blockedUntil: blockedUntil || null }),
  };
}

module.exports = { BASE_URL, createTraderaClient, normalizeSearchResult, retryAfterMs };

if (require.main === module && process.argv.includes('--selftest')) {
  const calls = [];
  const searchFixture = {
    totalNumberOfItems: 1,
    totalNumberOfPages: 1,
    items: [{ id: 123, shortDescription: 'Macho I’m A Man vinyl', buyItNowPrice: 200, itemUrl: 'https://www.tradera.com/item/123' }],
    errors: [],
  };
  const fakeFetch = async (url, request = {}) => {
    calls.push({ url: String(url), request });
    const payload = String(url).includes('/v4/search') ? searchFixture
      : (String(url).includes('/reference-data/time') ? { time: '2026-08-20T12:00:00Z' } : { id: 123 });
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => payload };
  };
  (async () => {
    const client = createTraderaClient({ appId: '1234', appKey: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', fetchImpl: fakeFetch, minGapMs: 0 });
    const result = await client.search({ query: 'Macho I am a Man vinyl', orderBy: 'PriceAscending' });
    assert.strictEqual(result.items.length, 1);
    assert.strictEqual(result.total, 1);
    assert.strictEqual(calls[0].request.headers['x-app-id'], '1234');
    assert.ok(calls[0].url.includes('orderBy=PriceAscending'));
    await client.getItem(123);
    assert.strictEqual((await client.health()).ok, true);
    assert.deepStrictEqual(normalizeSearchResult({ Items: [{ Id: 7 }], TotalNumberOfItems: 1 }).items, [{ Id: 7 }]);
    assert.strictEqual(retryAfterMs({ get: () => '2' }), 2000);
    console.log('tradera client selftest: OK');
  })().catch((error) => { console.error(error); process.exitCode = 1; });
}

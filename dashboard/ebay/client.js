'use strict';

const assert = require('assert');

const SCOPE = 'https://api.ebay.com/oauth/api_scope';
const ENVIRONMENTS = Object.freeze({
  production: { api: 'https://api.ebay.com', identity: 'https://api.ebay.com' },
  sandbox: { api: 'https://api.sandbox.ebay.com', identity: 'https://api.sandbox.ebay.com' },
});

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function safeEnvironment(value) {
  return value === 'sandbox' ? 'sandbox' : 'production';
}

function safeMarketplace(value) {
  const text = String(value || 'EBAY_NL').toUpperCase();
  return /^EBAY_[A-Z]{2,12}$/.test(text) ? text : 'EBAY_NL';
}

function safeCountry(value) {
  const text = String(value || 'NL').toUpperCase();
  return /^[A-Z]{2}$/.test(text) ? text : 'NL';
}

function retryAfterMs(headers, now = Date.now()) {
  const value = headers && typeof headers.get === 'function' ? headers.get('retry-after') : null;
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : 0;
}

function normalizeErrorPayload(payload, status) {
  const error = payload && Array.isArray(payload.errors) ? payload.errors[0] : null;
  const message = error && (error.longMessage || error.message)
    || payload && (payload.error_description || payload.message)
    || `eBay API returned HTTP ${status}`;
  const code = error && (error.errorId || error.domain) || payload && payload.error || status;
  return `${message} (${code})`;
}

function createEbayClient(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('eBay client needs fetch.');
  const clientId = String(options.clientId || '').trim();
  const clientSecret = String(options.clientSecret || '').trim();
  if (!clientId || !clientSecret) throw new Error('Add the eBay App ID and Cert ID first.');
  const environment = safeEnvironment(options.environment);
  const endpoints = ENVIRONMENTS[environment];
  const marketplace = safeMarketplace(options.marketplace);
  const deliveryCountry = safeCountry(options.deliveryCountry);
  const postalCode = String(options.postalCode || '').trim().slice(0, 16);
  const minGapMs = Math.max(0, Number(options.minGapMs) || 125);
  const onRequest = typeof options.onRequest === 'function' ? options.onRequest : () => {};
  let token = null;
  let tokenExpiresAt = 0;
  let lastRequestAt = 0;
  let blockedUntil = 0;
  let requestCount = 0;

  async function pace() {
    const wait = Math.max(blockedUntil - Date.now(), lastRequestAt + minGapMs - Date.now());
    if (wait > 0) await sleep(wait);
  }

  async function fetchJson(url, request, kind) {
    await pace();
    lastRequestAt = Date.now();
    requestCount += 1;
    onRequest({ kind, ts: lastRequestAt, requestCount });
    const response = await fetchImpl(url, request);
    let payload = null;
    try { payload = await response.json(); } catch { payload = null; }
    if (!response.ok) {
      if (response.status === 429) blockedUntil = Date.now() + Math.max(30_000, retryAfterMs(response.headers));
      const error = new Error(normalizeErrorPayload(payload, response.status));
      error.status = response.status;
      error.retryAt = blockedUntil || null;
      throw error;
    }
    return payload || {};
  }

  async function accessToken(force = false) {
    if (!force && token && Date.now() < tokenExpiresAt - 60_000) return token;
    const basic = Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64');
    const body = new URLSearchParams({ grant_type: 'client_credentials', scope: SCOPE }).toString();
    const payload = await fetchJson(`${endpoints.identity}/identity/v1/oauth2/token`, {
      method: 'POST',
      headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded' },
      body,
    }, 'oauth');
    if (!payload.access_token) throw new Error('eBay did not return an application access token.');
    token = String(payload.access_token);
    tokenExpiresAt = Date.now() + Math.max(60, Number(payload.expires_in) || 7200) * 1000;
    return token;
  }

  function contextHeader() {
    const parts = [`country=${deliveryCountry}`];
    if (postalCode) parts.push(`zip=${postalCode}`);
    return `contextualLocation=${encodeURIComponent(parts.join(','))}`;
  }

  async function apiGet(pathname, query = {}) {
    const url = new URL(`${endpoints.api}${pathname}`);
    for (const [key, value] of Object.entries(query)) if (value != null && value !== '') url.searchParams.set(key, String(value));
    const request = () => fetchJson(url.href, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        'x-ebay-c-marketplace-id': marketplace,
        'x-ebay-c-enduserctx': contextHeader(),
      },
    }, 'browse');
    await accessToken();
    try { return await request(); }
    catch (error) {
      if (error && error.status === 401) { await accessToken(true); return request(); }
      throw error;
    }
  }

  async function search({ q, limit = 10, offset = 0, sort = 'newlyListed' } = {}) {
    const query = String(q || '').trim().slice(0, 100);
    if (!query) throw new Error('eBay search needs a query.');
    const filters = [`deliveryCountry:${deliveryCountry}`, 'conditions:{USED|UNSPECIFIED}'];
    const payload = await apiGet('/buy/browse/v1/item_summary/search', {
      q: query,
      limit: Math.min(50, Math.max(1, Number(limit) || 10)),
      offset: Math.max(0, Number(offset) || 0),
      sort,
      filter: filters.join(','),
    });
    return {
      total: Math.max(0, Number(payload.total) || 0),
      items: Array.isArray(payload.itemSummaries) ? payload.itemSummaries : [],
      next: payload.next || null,
    };
  }

  async function getItem(itemId) {
    const id = String(itemId || '').trim();
    if (!id || id.length > 160) throw new Error('Invalid eBay item id.');
    return apiGet(`/buy/browse/v1/item/${encodeURIComponent(id)}`);
  }

  async function health() {
    await accessToken();
    return { ok: true, environment, marketplace, deliveryCountry, tokenExpiresAt };
  }

  return {
    search,
    getItem,
    health,
    status: () => ({ environment, marketplace, deliveryCountry, requestCount, lastRequestAt, blockedUntil: blockedUntil || null, tokenExpiresAt }),
  };
}

module.exports = { createEbayClient, safeEnvironment, safeMarketplace, safeCountry, retryAfterMs, SCOPE };

if (require.main === module && process.argv.includes('--selftest')) {
  const calls = [];
  const fakeFetch = async (url, request = {}) => {
    calls.push({ url: String(url), request });
    const isToken = String(url).includes('/oauth2/token');
    const payload = isToken
      ? { access_token: 'secret-token', expires_in: 7200 }
      : (String(url).includes('/item_summary/search') ? { total: 1, itemSummaries: [{ itemId: 'v1|123|0', title: 'Macho I’m A Man vinyl' }] } : { itemId: 'v1|123|0' });
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => payload };
  };
  (async () => {
    const client = createEbayClient({ clientId: 'app-id', clientSecret: 'cert-id', fetchImpl: fakeFetch, minGapMs: 0, marketplace: 'EBAY_NL', deliveryCountry: 'NL' });
    const result = await client.search({ q: 'Macho I am a Man vinyl' });
    assert.strictEqual(result.items.length, 1);
    assert.ok(calls[0].request.headers.authorization.startsWith('Basic '));
    assert.strictEqual(calls[1].request.headers.authorization, 'Bearer secret-token');
    assert.strictEqual(calls[1].request.headers['x-ebay-c-marketplace-id'], 'EBAY_NL');
    assert.ok(calls[1].url.includes('sort=newlyListed'));
    await client.getItem('v1|123|0');
    assert.strictEqual(calls.filter((call) => call.url.includes('/oauth2/token')).length, 1, 'OAuth token is cached');
    assert.strictEqual(retryAfterMs({ get: () => '2' }), 2000);
    console.log('ebay client selftest: OK');
  })().catch((error) => { console.error(error); process.exitCode = 1; });
}

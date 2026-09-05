'use strict';

const assert = require('assert');

const API_URL = 'https://api.marktplaats.nl';
const TOKEN_URL = 'https://auth.marktplaats.nl/accounts/oauth/token';
const WEB_SEARCH_URL = 'https://www.marktplaats.nl/lrp/api/search';

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function retryAfterMs(headers, now = Date.now()) {
  const value = headers && typeof headers.get === 'function' ? headers.get('retry-after') : null;
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : 0;
}

function normalizeErrorPayload(payload, status) {
  const first = payload && Array.isArray(payload.errors) ? payload.errors[0] : null;
  const message = first && (first.message || first.description)
    || payload && (payload.error_description || payload.message || payload.error)
    || `Marktplaats API returned HTTP ${status}`;
  const code = first && (first.code || first.errorCode) || payload && payload.error || status;
  return `${message} (${code})`;
}

function normalizeSearchResult(payload = {}) {
  const embedded = payload && payload._embedded && payload._embedded['mp:search-result'];
  return {
    total: Math.max(0, Number(payload.totalCount) || 0),
    offset: Math.max(0, Number(payload.offset) || 0),
    limit: Math.max(0, Number(payload.limit) || 0),
    items: Array.isArray(embedded) ? embedded : [],
    next: payload && payload._links && payload._links.next && payload._links.next.href || null,
  };
}

function publicPriceModel(priceInfo = {}) {
  const type = String(priceInfo.priceType || '').toUpperCase();
  const modelType = type === 'FIXED' ? 'fixed' : (type.includes('BID') ? 'bid' : 'other');
  return { modelType, askingPrice: Number(priceInfo.priceCents), currency: 'EUR' };
}

function normalizePublicListing(item = {}) {
  const itemId = String(item.itemId || '').trim();
  const vipUrl = String(item.vipUrl || '');
  const websiteUrl = vipUrl.startsWith('/') ? `https://www.marktplaats.nl${vipUrl}` : vipUrl;
  return {
    itemId,
    title: String(item.title || ''),
    description: String(item.description || item.categorySpecificDescription || ''),
    categoryId: item.categoryId || null,
    status: item.reserved ? 'reserved' : 'available',
    priceModel: publicPriceModel(item.priceInfo),
    location: item.location && item.location.cityName ? { cityName: item.location.cityName } : null,
    attributes: [...(Array.isArray(item.attributes) ? item.attributes : []), ...(Array.isArray(item.extendedAttributes) ? item.extendedAttributes : [])],
    imageUrls: Array.isArray(item.imageUrls) ? item.imageUrls.slice(0, 1) : [],
    _links: { 'mp:advertisement-website-link': { href: websiteUrl } },
    sourceType: 'public_web',
  };
}

function normalizePublicSearchResult(payload = {}, requested = {}) {
  const maxItems = Math.max(1, Number(requested.limit) || 10);
  const items = Array.isArray(payload.listings) ? payload.listings.slice(0, maxItems).map(normalizePublicListing) : [];
  return {
    total: Math.max(0, Number(payload.totalResultCount) || items.length),
    offset: Math.max(0, Number(requested.offset) || 0),
    limit: Math.max(0, Number(requested.limit) || items.length),
    items,
    next: null,
  };
}

function createMarktplaatsClient(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('Marktplaats client needs fetch.');
  const clientId = String(options.clientId || '').trim();
  const clientSecret = String(options.clientSecret || '').trim();
  if (!clientId || !clientSecret) throw new Error('Add the Marktplaats Client ID and Client Secret first.');
  const minGapMs = Math.max(0, Number(options.minGapMs) || 200);
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
      let message = normalizeErrorPayload(payload, response.status);
      if (kind === 'oauth' && (response.status === 401 || response.status === 403)) {
        message = 'Marktplaats rejected these partner credentials. Use the Client ID and Client Secret assigned during Marktplaats API onboarding; a normal account login does not work.';
      } else if (kind !== 'oauth' && response.status === 403) {
        message = 'This Marktplaats API client is not allowed to use read-only search. Ask your Marktplaats technical contact to enable GET /v2/search and advertisement-detail access.';
      }
      const error = new Error(message);
      error.status = response.status;
      error.retryAt = blockedUntil || null;
      throw error;
    }
    return payload || {};
  }

  async function accessToken(force = false) {
    if (!force && token && Date.now() < tokenExpiresAt - 60_000) return token;
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    }).toString();
    const payload = await fetchJson(TOKEN_URL, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body,
    }, 'oauth');
    if (!payload.access_token) throw new Error('Marktplaats did not return an application access token.');
    token = String(payload.access_token);
    tokenExpiresAt = Date.now() + Math.max(60, Number(payload.expires_in) || 86400) * 1000;
    return token;
  }

  async function apiGet(pathname, query = {}, kind = 'api') {
    const url = new URL(`${API_URL}${pathname}`);
    for (const [key, value] of Object.entries(query)) {
      if (value != null && value !== '') url.searchParams.set(key, String(value));
    }
    const request = () => fetchJson(url.href, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    }, kind);
    await accessToken();
    try { return await request(); }
    catch (error) {
      if (error && error.status === 401) { await accessToken(true); return request(); }
      throw error;
    }
  }

  async function search({ query, categoryId = '', postcode = '', distance = '', limit = 10, offset = 0 } = {}) {
    const text = String(query || '').trim().slice(0, 120);
    if (!text) throw new Error('Marktplaats search needs a query.');
    const category = String(categoryId || '').trim();
    if (category && !/^\d+$/.test(category)) throw new Error('Marktplaats category ID must be numeric.');
    const postCode = String(postcode || '').replace(/\s+/g, '').toUpperCase().slice(0, 6);
    const radius = distance === '' || distance == null ? '' : Math.max(1, Number(distance) || 0);
    return normalizeSearchResult(await apiGet('/v2/search', {
      query: text,
      categoryId: category,
      withImages: true,
      searchDescription: true,
      postCode: postCode.length === 6 ? postCode : '',
      distance: postCode.length === 6 ? radius : '',
      sortBy: 'default',
      sortOrder: 'descending',
      offset: Math.max(0, Number(offset) || 0),
      limit: Math.min(50, Math.max(1, Number(limit) || 10)),
      locale: 'nl-NL',
    }, 'search'));
  }

  async function getAdvertisement(itemId) {
    const id = String(itemId || '').trim();
    if (!/^[a-zA-Z]\d+$/.test(id)) throw new Error('Invalid Marktplaats advertisement id.');
    return apiGet(`/v2/advertisements/${encodeURIComponent(id)}`, {}, 'advertisement');
  }

  async function health() {
    await accessToken();
    return { ok: true, tokenExpiresAt };
  }

  return {
    search,
    getAdvertisement,
    health,
    mode: 'official_api',
    status: () => ({ requestCount, lastRequestAt, blockedUntil: blockedUntil || null, tokenExpiresAt }),
  };
}

function createMarktplaatsWebClient(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('Marktplaats web fallback needs fetch.');
  const minGapMs = Math.max(500, Number(options.minGapMs) || 1500);
  const onRequest = typeof options.onRequest === 'function' ? options.onRequest : () => {};
  let lastRequestAt = 0;
  let blockedUntil = 0;
  let requestCount = 0;
  const cache = new Map();

  async function pace() {
    const wait = Math.max(blockedUntil - Date.now(), lastRequestAt + minGapMs - Date.now());
    if (wait > 0) await sleep(wait);
  }

  async function search({ query, categoryId = '', postcode = '', distance = '', limit = 10, offset = 0 } = {}) {
    const text = String(query || '').trim().slice(0, 120);
    if (!text) throw new Error('Marktplaats search needs a query.');
    const category = String(categoryId || '').trim();
    if (category && !/^\d+$/.test(category)) throw new Error('Marktplaats category ID must be numeric.');
    const postCode = String(postcode || '').replace(/\s+/g, '').toUpperCase().slice(0, 6);
    const requested = {
      limit: Math.min(20, Math.max(1, Number(limit) || 10)),
      offset: Math.max(0, Number(offset) || 0),
    };
    const url = new URL(WEB_SEARCH_URL);
    url.searchParams.set('query', text);
    url.searchParams.set('limit', String(requested.limit));
    url.searchParams.set('offset', String(requested.offset));
    if (category) url.searchParams.set('categoryId', category);
    if (postCode.length === 6) {
      url.searchParams.set('postcode', postCode);
      url.searchParams.set('distanceMeters', String(Math.max(1000, Number(distance) || 100000)));
    }
    await pace();
    lastRequestAt = Date.now();
    requestCount += 1;
    onRequest({ kind: 'public-web-search', ts: lastRequestAt, requestCount });
    const response = await fetchImpl(url.href, { headers: { accept: 'application/json', 'accept-language': 'nl-NL,nl;q=0.9' } });
    let payload = null;
    try { payload = await response.json(); } catch { payload = null; }
    if (!response.ok) {
      if (response.status === 429) blockedUntil = Date.now() + Math.max(60_000, retryAfterMs(response.headers));
      const error = new Error(response.status === 429
        ? 'Marktplaats is tijdelijk gepauzeerd omdat de publieke zoekroute een rate limit teruggaf.'
        : `Marktplaats public web search returned HTTP ${response.status}.`);
      error.status = response.status;
      error.retryAt = blockedUntil || null;
      throw error;
    }
    if (!payload || !Array.isArray(payload.listings)) throw new Error('Marktplaats changed the public search response; fallback scan stopped safely.');
    const normalized = normalizePublicSearchResult(payload, requested);
    for (const item of normalized.items) if (item.itemId) cache.set(item.itemId, item);
    return normalized;
  }

  async function getAdvertisement(itemId) {
    const id = String(itemId || '').trim();
    if (!/^[a-zA-Z]\d+$/.test(id)) throw new Error('Invalid Marktplaats advertisement id.');
    return cache.get(id) || { itemId: id, sourceType: 'public_web' };
  }

  return {
    search,
    getAdvertisement,
    health: async () => ({ ok: true, mode: 'public_web' }),
    mode: 'public_web',
    status: () => ({ requestCount, lastRequestAt, blockedUntil: blockedUntil || null }),
  };
}

module.exports = { API_URL, TOKEN_URL, WEB_SEARCH_URL, createMarktplaatsClient, createMarktplaatsWebClient, normalizeSearchResult, normalizePublicSearchResult, normalizePublicListing, retryAfterMs };

if (require.main === module && process.argv.includes('--selftest')) {
  const calls = [];
  const fixture = {
    _embedded: {
      'mp:search-result': [{
        itemId: 'm123', title: 'Macho I’m A Man 12 inch vinyl', description: 'GO 123',
        priceModel: { modelType: 'fixed', askingPrice: 2000 },
        _links: { 'mp:advertisement-website-link': { href: 'https://link.marktplaats.nl/m123' } },
      }],
    },
    totalCount: 1, offset: 0, limit: 10,
  };
  const fakeFetch = async (url, request = {}) => {
    calls.push({ url: String(url), request });
    const payload = String(url).includes('/oauth/token') ? { access_token: 'secret-token', expires_in: 86400 }
      : (String(url).includes('/v2/search') ? fixture : { itemId: 'm123' });
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => payload };
  };
  (async () => {
    const client = createMarktplaatsClient({ clientId: 'client', clientSecret: 'secret', fetchImpl: fakeFetch, minGapMs: 0 });
    const result = await client.search({ query: 'Macho I am a Man vinyl', categoryId: '1784', postcode: '2011AA', distance: 50000 });
    assert.strictEqual(result.items.length, 1);
    assert.strictEqual(result.total, 1);
    assert.ok(calls[0].request.body.includes('grant_type=client_credentials'));
    assert.ok(calls[0].request.body.includes('client_secret=secret'));
    assert.strictEqual(calls[1].request.headers.authorization, 'Bearer secret-token');
    assert.ok(calls[1].url.includes('searchDescription=true'));
    assert.ok(calls[1].url.includes('postCode=2011AA'));
    await client.getAdvertisement('m123');
    assert.strictEqual(calls.filter((call) => call.url.includes('/oauth/token')).length, 1, 'OAuth token is cached');
    assert.strictEqual(retryAfterMs({ get: () => '2' }), 2000);
    const rejected = createMarktplaatsClient({
      clientId: 'ordinary-account', clientSecret: 'not-a-partner-secret', minGapMs: 0,
      fetchImpl: async () => ({ ok: false, status: 401, headers: { get: () => null }, json: async () => null }),
    });
    await assert.rejects(() => rejected.health(), /partner credentials.*normal account login/i);
    const publicCalls = [];
    const publicClient = createMarktplaatsWebClient({ minGapMs: 500, fetchImpl: async (url) => {
      publicCalls.push(String(url));
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({
        listings: [{ itemId: 'm456', title: 'Macho I’m A Man', description: 'GO 123 original 12 inch', priceInfo: { priceCents: 1500, priceType: 'FIXED' }, location: { cityName: 'Haarlem', postcode: '2011AA' }, sellerInformation: { sellerId: 7, sellerName: 'private' }, vipUrl: '/v/cd-s-en-dvd-s/vinyl/m456-test', attributes: [{ key: 'size', value: '12 inch' }] }],
        totalResultCount: 1,
      }) };
    } });
    const publicResult = await publicClient.search({ query: 'Macho vinyl', postcode: '2011AA', distance: 50000, limit: 2 });
    assert.strictEqual(publicClient.mode, 'public_web');
    assert.strictEqual(publicResult.items[0].priceModel.modelType, 'fixed');
    assert.strictEqual(publicResult.items[0].priceModel.askingPrice, 1500);
    assert.ok(publicResult.items[0]._links['mp:advertisement-website-link'].href.startsWith('https://www.marktplaats.nl/v/'));
    assert.ok(!JSON.stringify(publicResult.items[0]).includes('private') && !JSON.stringify(publicResult.items[0]).includes('2011AA'), 'public fallback drops seller and precise postcode before returning data');
    assert.ok(publicCalls[0].includes('postcode=2011AA') && publicCalls[0].includes('distanceMeters=50000'));
    console.log('marktplaats client selftest: OK');
  })().catch((error) => { console.error(error); process.exitCode = 1; });
}

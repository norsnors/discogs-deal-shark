'use strict';
/*
 * discogs.js — thin client for the OFFICIAL Discogs API (api.discogs.com).
 *
 * Only endpoints that actually work programmatically live here. Everything on
 * www.discogs.com (marketplace listing pages, the sales-history median, the
 * direct listing link) is behind Cloudflare's "Just a moment..." JS challenge and
 * is NOT reachable from a plain fetch / cloud server — see README "The Cloudflare wall".
 *
 * Auth: header  Authorization: Discogs token=<personal access token>
 *   - token optional for stats/release (works anonymously at a lower rate limit)
 *   - token REQUIRED for /marketplace/price_suggestions
 * A descriptive User-Agent is mandatory — Discogs 403s the default Node UA.
 *
 * Rate limit: 60 req/min authenticated, 25/min anonymous. The client reads the
 * X-Discogs-Ratelimit-* response headers and self-throttles, and backs off on 429.
 */

const API = 'https://api.discogs.com';
const DEFAULT_UA = 'DiscogsDealShark/1.0';

function makeClient(opts = {}) {
  const token = opts.token || '';
  const userAgent = opts.userAgent || DEFAULT_UA;
  const fetchImpl = opts.fetch || globalThis.fetch;
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  // Conservative floor between calls so we never trip the per-minute cap.
  const minIntervalMs = opts.minIntervalMs ?? (token ? 1100 : 2500);

  let lastAt = 0;
  let remaining = null; // last seen X-Discogs-Ratelimit-Remaining

  async function req(pathname, { method = 'GET', searchParams } = {}) {
    // Self-throttle: keep at least minIntervalMs between calls, and pause if the
    // window is nearly exhausted.
    const now = Date.now();
    const wait = Math.max(0, lastAt + minIntervalMs - now);
    if (wait) await sleep(wait);
    if (remaining != null && remaining <= 1) await sleep(60_000); // window almost empty

    const url = new URL(API + pathname);
    if (searchParams) for (const [k, v] of Object.entries(searchParams)) url.searchParams.set(k, v);

    const headers = { 'User-Agent': userAgent, Accept: 'application/json' };
    if (token) headers.Authorization = `Discogs token=${token}`;

    for (let attempt = 0; attempt < 4; attempt++) {
      lastAt = Date.now();
      let res;
      try {
        res = await fetchImpl(url.toString(), { method, headers });
      } catch (e) {
        if (attempt === 3) throw e;
        await sleep(1500 * (attempt + 1));
        continue;
      }
      const rem = res.headers.get('x-discogs-ratelimit-remaining');
      if (rem != null) remaining = parseInt(rem, 10);

      if (res.status === 429) {
        const retry = parseInt(res.headers.get('retry-after') || '', 10);
        await sleep(Number.isFinite(retry) ? retry * 1000 : 60_000);
        continue;
      }
      if (res.status === 404) return { status: 404, data: null };
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        const err = new Error(`Discogs ${res.status} on ${pathname}: ${body.slice(0, 200)}`);
        err.status = res.status;
        throw err;
      }
      if (res.status === 204) return { status: res.status, data: null };
      let data = null;
      try { data = await res.json(); } catch { /* successful empty response */ }
      return { status: res.status, data };
    }
    throw new Error(`Discogs request gave up after retries: ${pathname}`);
  }

  // --- endpoints ---

  // Full wantlist, paginated. Returns [{ wantId, releaseId, title, artist, year, thumb }].
  async function getWantlist(username) {
    const out = [];
    let page = 1;
    let pages = 1;
    do {
      const { data } = await req(`/users/${encodeURIComponent(username)}/wants`, {
        searchParams: { page, per_page: 100, sort: 'added', sort_order: 'desc' },
      });
      pages = data?.pagination?.pages || 1;
      for (const w of data?.wants || []) {
        const bi = w.basic_information || {};
        out.push({
          wantId: w.id,
          releaseId: bi.id,
          title: bi.title,
          artist: (bi.artists || []).map((a) => a.name).join(', '),
          year: bi.year,
          thumb: bi.thumb || bi.cover_image || null,
          formats: (bi.formats || []).map((f) => f.name).join(', '),
        });
      }
      page += 1;
    } while (page <= pages);
    return out;
  }

  // { numForSale, lowestPrice, currency } — the single cheapest copy, any condition.
  async function getMarketplaceStats(releaseId, currency = 'EUR') {
    const { data, status } = await req(`/marketplace/stats/${releaseId}`, { searchParams: { curr_abbr: currency } });
    if (status === 404 || !data) return { numForSale: 0, lowestPrice: null, currency, blocked: false };
    return {
      numForSale: data.num_for_sale ?? 0,
      lowestPrice: data.lowest_price ? data.lowest_price.value : null,
      currency: data.lowest_price ? data.lowest_price.currency : currency,
      blocked: !!data.blocked_from_sale,
    };
  }

  // Per-condition suggested price, e.g. { "Very Good Plus (VG+)": { value, currency }, ... }.
  // Requires a token; throws 401 otherwise. Returns null when unavailable for the release.
  async function getPriceSuggestions(releaseId) {
    const { data, status } = await req(`/marketplace/price_suggestions/${releaseId}`);
    if (status === 404 || !data) return null;
    return data;
  }

  // Release metadata for nice email/dashboard labels.
  async function getRelease(releaseId) {
    const { data } = await req(`/releases/${releaseId}`);
    if (!data) return null;
    return {
      id: data.id,
      title: data.title,
      artist: (data.artists || []).map((a) => a.name).join(', '),
      year: data.year,
      thumb: data.thumb || (data.images && data.images[0] && data.images[0].uri150) || null,
      uri: data.uri,
      country: data.country || null,
      genres: Array.isArray(data.genres) ? data.genres : [],
      styles: Array.isArray(data.styles) ? data.styles : [],
      formats: Array.isArray(data.formats) ? data.formats.map((format) => ({
        name: format.name || '',
        qty: format.qty || null,
        descriptions: Array.isArray(format.descriptions) ? format.descriptions : [],
      })) : [],
      labels: Array.isArray(data.labels) ? data.labels.map((label) => ({
        name: label.name || '',
        catno: label.catno || null,
      })) : [],
    };
  }

  // Public, for-sale inventory for a marketplace seller. City Dig uses small newest-first pages
  // and enriches their release ids through getRelease; Discogs does not include genre/style in an
  // inventory row. The normal client throttle therefore remains the source of truth.
  async function getInventory(username, { page = 1, perPage = 50, sort = 'listed', sortOrder = 'desc' } = {}) {
    const { data, status } = await req(`/users/${encodeURIComponent(username)}/inventory`, {
      searchParams: {
        status: 'For Sale',
        page: Math.max(1, Number(page) || 1),
        per_page: Math.min(100, Math.max(1, Number(perPage) || 50)),
        sort,
        sort_order: sortOrder === 'asc' ? 'asc' : 'desc',
      },
    });
    if (status === 404 || !data) return { pagination: { page, pages: 0, items: 0 }, listings: [] };
    return {
      pagination: data.pagination || { page, pages: 1, items: 0 },
      listings: Array.isArray(data.listings) ? data.listings : [],
    };
  }

  async function getUserProfile(username) {
    const { data, status } = await req(`/users/${encodeURIComponent(username)}`);
    if (status === 404 || !data) return null;
    return {
      username: data.username || username,
      name: data.name || '',
      location: data.location || '',
      numForSale: Number(data.num_for_sale) || 0,
      uri: data.uri || `https://www.discogs.com/user/${encodeURIComponent(username)}`,
    };
  }

  // Database discovery for the Scout tab. Discogs treats e.g. Italo-Disco as a style, while
  // broader families such as Electronic or Rock are genres. Always limit this feature to concrete
  // vinyl releases: master releases cannot be added to a wantlist and have no marketplace stats.
  async function searchReleases({ field = 'style', query, format = 'Vinyl', page = 1, perPage = 100 } = {}) {
    const key = field === 'genre' ? 'genre' : 'style';
    const searchParams = { type: 'release', format, page, per_page: Math.min(100, Math.max(1, Number(perPage) || 100)) };
    searchParams[key] = String(query || '').trim();
    const { data } = await req('/database/search', { searchParams });
    return {
      pagination: data?.pagination || { page, pages: 1, items: 0 },
      results: Array.isArray(data?.results) ? data.results : [],
    };
  }

  async function addToWantlist(username, releaseId) {
    const { data } = await req(`/users/${encodeURIComponent(username)}/wants/${Number(releaseId)}`, { method: 'PUT' });
    return data || { id: Number(releaseId) };
  }

  return { req, getWantlist, getMarketplaceStats, getPriceSuggestions, getRelease, getInventory, getUserProfile, searchReleases, addToWantlist, get rateRemaining() { return remaining; } };
}

module.exports = { makeClient, API, DEFAULT_UA };

// --- tiny self-test (node discogs.js --selftest) ---------------------------
if (require.main === module && process.argv.includes('--selftest')) {
  const assert = require('assert');
  (async () => {
    // Fake fetch: serve canned JSON, assert UA + token headers are set.
    const calls = [];
    const fakeFetch = async (url, init) => {
      calls.push({ url, init });
      assert.ok(init.headers['User-Agent'], 'User-Agent always sent');
      const u = new URL(url);
      const json = (obj) => ({ ok: true, status: 200, headers: new Map([['x-discogs-ratelimit-remaining', '55']]), json: async () => obj, text: async () => '' });
      if (u.pathname.endsWith('/wants')) {
        const page = +u.searchParams.get('page');
        return json({ pagination: { pages: 2 }, wants: page === 1
          ? [{ id: 1, basic_information: { id: 249504, title: 'Never Gonna Give You Up', artists: [{ name: 'Rick Astley' }], year: 1987, formats: [{ name: 'Vinyl' }] } }]
          : [{ id: 2, basic_information: { id: 100, title: 'B', artists: [{ name: 'X' }], year: 1990 } }] });
      }
      if (u.pathname.includes('/marketplace/stats/')) return json({ num_for_sale: 115, lowest_price: { value: 0.57, currency: 'EUR' }, blocked_from_sale: false });
      if (u.pathname === '/users/wgwstore/inventory') return json({
        pagination: { page: 1, pages: 1, items: 1 },
        listings: [{ id: 55, price: { value: 9, currency: 'EUR' }, release: { id: 777, artist: 'My Mine', title: 'Hypnotic Tango', format: '12\"' } }],
      });
      if (u.pathname === '/users/wgwstore') return json({ username: 'wgwstore', name: 'Wallys Groove World', location: 'Antwerp', num_for_sale: 71510 });
      if (u.pathname === '/releases/777') return json({ id: 777, title: 'Hypnotic Tango', artists: [{ name: 'My Mine' }], genres: ['Electronic'], styles: ['Italo-Disco'], formats: [{ name: 'Vinyl', descriptions: ['12\"'] }] });
      if (u.pathname === '/database/search') return json({
        pagination: { page: 1, pages: 1, items: 1 },
        results: [{ id: 777, title: 'My Mine - Hypnotic Tango', style: ['Italo-Disco'], format: ['Vinyl'] }],
      });
      if (u.pathname.endsWith('/wants/777') && init.method === 'PUT') return json({ id: 777, rating: 0 });
      return json({});
    };
    let sleeps = 0;
    const c = makeClient({ token: 'TESTTOKEN', fetch: fakeFetch, sleep: async () => { sleeps++; }, minIntervalMs: 0 });

    const wl = await c.getWantlist('someone');
    assert.strictEqual(wl.length, 2, 'wantlist paginates across 2 pages');
    assert.strictEqual(wl[0].releaseId, 249504);
    assert.strictEqual(wl[0].artist, 'Rick Astley');

    const stats = await c.getMarketplaceStats(249504, 'EUR');
    assert.strictEqual(stats.numForSale, 115);
    assert.strictEqual(stats.lowestPrice, 0.57);

    const inventory = await c.getInventory('wgwstore', { perPage: 25 });
    assert.strictEqual(inventory.listings[0].release.id, 777);
    const inventoryUrl = new URL(calls.find((x) => new URL(x.url).pathname === '/users/wgwstore/inventory').url);
    assert.strictEqual(inventoryUrl.searchParams.get('status'), 'For Sale');
    assert.strictEqual(inventoryUrl.searchParams.get('per_page'), '25');
    assert.strictEqual((await c.getUserProfile('wgwstore')).numForSale, 71510);
    const release = await c.getRelease(777);
    assert.deepStrictEqual(release.styles, ['Italo-Disco']);

    const search = await c.searchReleases({ query: 'Italo-Disco', perPage: 50 });
    assert.strictEqual(search.results[0].id, 777);
    const searchUrl = new URL(calls.find((x) => new URL(x.url).pathname === '/database/search').url);
    assert.strictEqual(searchUrl.searchParams.get('style'), 'Italo-Disco');
    assert.strictEqual(searchUrl.searchParams.get('type'), 'release');
    assert.strictEqual(searchUrl.searchParams.get('format'), 'Vinyl');
    assert.strictEqual((await c.addToWantlist('someone', 777)).id, 777);

    // token present -> Authorization header set
    assert.ok(calls.every((x) => x.init.headers.Authorization === 'Discogs token=TESTTOKEN'), 'token header sent');
    assert.strictEqual(sleeps, 0, 'an explicit zero interval disables throttling (useful for tests)');

    console.log('discogs selftest: all assertions passed');
  })().catch((e) => { console.error('FAILED:', e.stack || e); process.exit(1); });
}

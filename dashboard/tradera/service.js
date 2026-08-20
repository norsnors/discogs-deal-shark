'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createTraderaClient } = require('./client');
const { createEcbFxClient } = require('./fx');
const { createTraderaState } = require('./state');
const {
  buildWantIndex,
  matchCatalogItem,
  resolvePressingMatch,
  targetIndexKey,
} = require('../vinted/policy');

const DAY_MS = 24 * 60 * 60 * 1000;
const LIVE_TTL_MS = 7 * DAY_MS;
const FX_FALLBACK_TTL_MS = 7 * DAY_MS;
const MAX_DAILY_CALLS = 9500;

function clamp(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}
function first(item, ...names) {
  for (const name of names) if (item && item[name] != null) return item[name];
  return null;
}
function money(value) {
  const number = Number(value && typeof value === 'object' ? (value.value ?? value.amount) : value);
  return Number.isFinite(number) ? number : null;
}
function roundMoney(value) { return Math.round((Number(value) + Number.EPSILON) * 100) / 100; }
function scalarText(value, output = [], depth = 0) {
  if (output.join(' ').length >= 5000 || depth > 6 || value == null) return output;
  if (['string', 'number'].includes(typeof value)) output.push(String(value));
  else if (Array.isArray(value)) for (const entry of value) scalarText(entry, output, depth + 1);
  else if (typeof value === 'object') for (const entry of Object.values(value)) scalarText(entry, output, depth + 1);
  return output;
}
function termCondition(item = {}) {
  const attributes = first(item, 'attributeValues', 'AttributeValues') || {};
  const terms = first(attributes, 'termAttributeValues', 'TermAttributeValues') || [];
  for (const term of Array.isArray(terms) ? terms : []) {
    const name = String(first(term, 'name', 'Name') || '');
    if (/condition|skick/i.test(name)) {
      const values = first(term, 'values', 'Values') || [];
      return (Array.isArray(values) ? values : [values]).map(String).filter(Boolean).join(', ');
    }
  }
  const itemAttributes = first(item, 'itemAttributes', 'ItemAttributes') || [];
  return Array.isArray(itemAttributes) && itemAttributes.map(Number).includes(2) ? 'Used' : '';
}
function safeHttps(value) {
  try { const url = new URL(String(value || '')); return url.protocol === 'https:' ? url.href : null; } catch { return null; }
}
function safeTraderaUrl(value, itemId = null) {
  try {
    const url = new URL(String(value || ''));
    const host = url.hostname.toLowerCase();
    if (url.protocol === 'https:' && (host === 'tradera.com' || host === 'www.tradera.com')) return url.href;
  } catch { /* use the canonical fallback below */ }
  const id = String(itemId || '');
  return /^\d+$/.test(id) ? `https://www.tradera.com/item/${id}` : null;
}
function shippingOfferedFrom(item = {}) {
  const options = first(item, 'shippingOptions', 'ShippingOptions') || [];
  const values = (Array.isArray(options) ? options : []).map((option) => money(first(option, 'cost', 'Cost'))).filter((value) => value != null && value >= 0);
  return values.length ? Math.min(...values) : null;
}
function fixedPriceAvailable(item = {}) {
  return money(first(item, 'buyItNowPrice', 'BuyItNowPrice')) > 0;
}
function itemAvailable(item = {}, now = Date.now()) {
  if (first(item, 'isEnded', 'IsEnded') === true) return false;
  const endDate = first(item, 'endDate', 'EndDate');
  if (endDate && Number.isFinite(Date.parse(endDate)) && Date.parse(endDate) <= now) return false;
  const remaining = first(item, 'remainingQuantity', 'RemainingQuantity');
  return remaining == null || Number(remaining) > 0;
}
function normalizeTraderaItem(item = {}, fx = { rate: 1, targetCurrency: 'SEK' }) {
  const itemId = String(first(item, 'id', 'Id') || '').trim();
  const nativeItemPrice = money(first(item, 'buyItNowPrice', 'BuyItNowPrice'));
  const nativeShippingFrom = shippingOfferedFrom(item);
  const detailedImages = first(item, 'detailedImageLinks', 'DetailedImageLinks') || [];
  const imageLinks = first(item, 'imageLinks', 'ImageLinks') || [];
  const firstDetailed = Array.isArray(detailedImages) && detailedImages[0] ? first(detailedImages[0], 'url', 'Url') : null;
  const seller = first(item, 'seller', 'Seller') || {};
  const sellerAlias = first(item, 'sellerAlias', 'SellerAlias') || first(seller, 'alias', 'Alias', 'username', 'Username', 'id', 'Id');
  const rate = Number(fx.rate) > 0 ? Number(fx.rate) : 1;
  return {
    itemId,
    title: String(first(item, 'shortDescription', 'ShortDescription', 'title', 'Title') || ''),
    itemPrice: nativeItemPrice == null ? null : roundMoney(nativeItemPrice * rate),
    nativeItemPrice,
    nativeShippingFrom,
    shippingOfferedFrom: nativeShippingFrom == null ? null : roundMoney(nativeShippingFrom * rate),
    currency: String(fx.targetCurrency || 'SEK').toUpperCase(),
    nativeCurrency: 'SEK',
    condition: termCondition(item),
    seller: sellerAlias == null ? null : String(sellerAlias),
    image: safeHttps(first(item, 'thumbnailLink', 'ThumbnailLink') || firstDetailed || (Array.isArray(imageLinks) ? imageLinks[0] : null)),
    url: safeTraderaUrl(first(item, 'itemUrl', 'ItemUrl', 'itemLink', 'ItemLink'), itemId),
    createdAt: first(item, 'startDate', 'StartDate'),
    endAt: first(item, 'endDate', 'EndDate'),
    itemType: first(item, 'itemType', 'ItemType'),
    bidCount: Math.max(0, Number(first(item, 'bidCount', 'BidCount', 'totalBids', 'TotalBids')) || 0),
    raw: item,
  };
}
function bridgeItem(listing) {
  return {
    id: listing.itemId,
    title: listing.title,
    price: { amount: listing.itemPrice, currency_code: listing.currency },
    created_at: listing.createdAt,
  };
}
function evidenceDetail(listing, detail = {}) {
  return {
    name: String(first(detail, 'shortDescription', 'ShortDescription') || listing.title),
    description: scalarText([
      first(detail, 'longDescription', 'LongDescription'),
      first(detail, 'ownReferences', 'OwnReferences'),
      first(detail, 'attributeValues', 'AttributeValues'),
      first(detail, 'shippingCondition', 'ShippingCondition'),
    ]).join(' · ').slice(0, 5000),
    brand: '',
    category: scalarText(first(detail, 'attributeValues', 'AttributeValues')).join(' · ').slice(0, 1000),
  };
}
function queryFor(target) {
  return `${target.artist || ''} ${target.title || ''} vinyl`.replace(/\s+/g, ' ').trim().slice(0, 120);
}

function createTraderaService(options = {}) {
  if (!options.stateFile) throw new Error('createTraderaService needs stateFile.');
  for (const name of ['readSettings', 'writeSettings', 'readConfig', 'loadWantlist', 'loadMedians', 'loadReleaseMetadata', 'getCredentials']) {
    if (typeof options[name] !== 'function') throw new Error(`createTraderaService needs ${name}.`);
  }
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const emit = typeof options.emit === 'function' ? options.emit : () => {};
  const clientFactory = options.clientFactory || createTraderaClient;
  const fxClient = options.getFxRate ? null : createEcbFxClient(options.fxOptions);
  const getFxRate = options.getFxRate || ((from, to) => fxClient.getRate(from, to));
  const state = createTraderaState(options.stateFile);
  let client = null;
  let clientSignature = '';
  let timer = null;
  let stopped = false;
  let running = false;
  let nextPollAt = null;
  let lastPollAt = state.get().health.lastPollAt || null;
  let lastError = null;
  let progress = null;
  let context = null;
  let contextLoadedAt = 0;
  let callsToday = Number(state.get().health.callsToday) || 0;
  let callDay = state.get().health.callDay || new Date(now()).toISOString().slice(0, 10);
  let lastFx = state.get().health.fx || null;

  function settings() {
    const value = options.readSettings() || {};
    return {
      enabled: value.traderaEnabled === true,
      pollMinutes: clamp(value.traderaPollMinutes, 5, 1440, 30),
      batchSize: clamp(value.traderaBatchSize, 1, 25, 5),
    };
  }
  function refreshDay() {
    const day = new Date(now()).toISOString().slice(0, 10);
    if (day !== callDay) { callDay = day; callsToday = 0; }
  }
  function recordRequest() { refreshDay(); callsToday += 1; }
  function credentials() {
    const value = options.getCredentials() || {};
    return { appId: value.appId || '', appKey: value.appKey || '' };
  }
  function ensureClient() {
    const creds = credentials();
    const signature = JSON.stringify([creds.appId, creds.appKey]);
    if (!client || signature !== clientSignature) {
      client = clientFactory({ ...creds, onRequest: recordRequest });
      clientSignature = signature;
    }
    return client;
  }
  async function resolveFx(targetCurrency) {
    const currency = String(targetCurrency || 'EUR').toUpperCase();
    if (currency === 'SEK') {
      lastFx = { from: 'SEK', to: 'SEK', rate: 1, date: new Date(now()).toISOString().slice(0, 10), source: 'identity', capturedAt: now() };
      return lastFx;
    }
    try {
      const current = await getFxRate('SEK', currency);
      if (!(Number(current && current.rate) > 0)) throw new Error(`No SEK/${currency} conversion rate was returned.`);
      lastFx = { from: 'SEK', to: currency, rate: Number(current.rate), date: current.date || null, source: current.source || 'ecb-daily', stale: false, capturedAt: now() };
      return lastFx;
    } catch (error) {
      if (lastFx && lastFx.to === currency && Number(lastFx.rate) > 0 && now() - Number(lastFx.capturedAt || 0) <= FX_FALLBACK_TTL_MS) return { ...lastFx, stale: true };
      throw new Error(`SEK conversion is unavailable: ${error && error.message ? error.message : String(error)}`);
    }
  }
  async function loadContext(force = false) {
    const config = options.readConfig() || {};
    if (!force && context && now() - contextLoadedAt < 30 * 60 * 1000 && context.username === config.username && context.token === config.token) return context;
    if (!config.username || !config.token) throw new Error('Add your Discogs username and token first; Tradera matching uses that wantlist.');
    const [wantlist, medians] = await Promise.all([options.loadWantlist(config), options.loadMedians()]);
    const index = buildWantIndex(wantlist, medians || {});
    if (!index.targets.length) throw new Error('Your Discogs wantlist is empty.');
    context = { config, username: config.username, token: config.token, index };
    contextLoadedAt = now();
    state.update({ wantlist: index.targets.map((target) => ({ releaseId: target.releaseId, releaseIds: target.releaseIds, artist: target.artist, title: target.title, year: target.year, thumb: target.thumb, median: target.median })) });
    return context;
  }
  function searchUrl(target) { return `https://www.tradera.com/search?q=${encodeURIComponent(queryFor(target))}`; }
  function zeroWatch(snapshot = state.get()) {
    return Object.entries(snapshot.availability || {}).filter(([, value]) => value && value.status === 'zero').map(([key, value]) => ({
      releaseId: value.releaseId || key, artist: value.artist || '', title: value.title || '', year: value.year || null,
      thumb: value.thumb || null, checkedAt: value.checkedAt || null, url: value.url || `https://www.tradera.com/search?q=${encodeURIComponent(`${value.artist || ''} ${value.title || ''} vinyl`)}`,
    })).sort((a, b) => (b.checkedAt || 0) - (a.checkedAt || 0));
  }
  function publicStatus() {
    refreshDay();
    const cfg = settings(); const snapshot = state.get(); const hasCredentials = !!credentials().appId && !!credentials().appKey;
    return {
      enabled: cfg.enabled,
      configured: hasCredentials,
      running,
      health: running ? 'scanning' : (lastError ? 'error' : (lastPollAt ? 'live' : (hasCredentials ? (cfg.enabled ? 'idle' : 'disabled') : 'setup'))),
      pollMinutes: cfg.pollMinutes,
      lastPollAt,
      nextPollAt: cfg.enabled ? nextPollAt : null,
      callsToday,
      dailyLimit: MAX_DAILY_CALLS,
      targetCount: context && context.index ? context.index.targets.length : snapshot.wantlist.length,
      cursor: snapshot.cursor || 0,
      progress,
      fx: lastFx,
      error: lastError,
      message: !hasCredentials ? 'Add your Tradera developer App ID and App Key to connect the official API.'
        : (lastPollAt ? 'Official Tradera REST v4 · fixed-price listings · pressing-matched against your Discogs wantlist.' : 'Tradera API is configured and ready.'),
    };
  }
  function snapshot(extra = {}) {
    const current = state.get(); const cutoff = now() - LIVE_TTL_MS;
    return { status: publicStatus(), deals: current.deals.filter((record) => Number(record.observedAt || record.ts || 0) >= cutoff), gems: { ts: current.updatedAt || null, gems: current.gems, zeroWatch: zeroWatch(current) }, ...extra };
  }
  function publish(extra) { const value = snapshot(extra); try { emit(value); } catch { /* renderer may be closed */ } return value; }
  async function metadataFor(group, config) {
    const result = {};
    for (const pressing of Array.isArray(group.pressings) ? group.pressings : [group]) {
      if (pressing && pressing.releaseId != null) result[pressing.releaseId] = await options.loadReleaseMetadata(pressing.releaseId, config);
    }
    return result;
  }
  function recordFor(listing, resolved, evaluation, fx, observedAt) {
    return {
      id: `tradera:${listing.itemId}`,
      platform: 'tradera',
      sourceType: 'official_api',
      listingId: listing.itemId,
      releaseId: resolved.target.releaseId,
      releaseIds: resolved.target.releaseIds || [resolved.target.releaseId],
      artist: resolved.target.artist,
      title: resolved.target.title,
      year: resolved.target.year,
      thumb: listing.image || resolved.target.thumb || null,
      listingTitle: listing.title,
      itemCondition: listing.condition || null,
      itemPrice: listing.itemPrice,
      nativeItemPrice: listing.nativeItemPrice,
      nativeCurrency: 'SEK',
      lowest: listing.itemPrice,
      currency: listing.currency,
      shipping: null,
      shippingEstimate: evaluation.shippingEstimate,
      shippingOfferedFrom: listing.shippingOfferedFrom,
      nativeShippingOfferedFrom: listing.nativeShippingFrom,
      shippingSource: null,
      reference: evaluation.reference,
      referenceSource: 'sold-median',
      discount: evaluation.discount,
      numForSale: 1,
      matchScore: resolved.score,
      pressingVerified: true,
      pressingEvidence: resolved.evidence || [],
      conditionConfirmed: false,
      freshListing: listing.createdAt ? now() - Date.parse(listing.createdAt) < DAY_MS : false,
      observedAt,
      seller: listing.seller,
      buyingOptions: ['FIXED_PRICE'],
      bids: listing.bidCount,
      itemEndAt: listing.endAt,
      url: listing.url,
      listingUrl: listing.url,
      provenance: { source: 'tradera-rest-v4', nativeCurrency: 'SEK', fxSource: fx.source, fxDate: fx.date, fxRate: fx.rate, observedAt },
      ts: listing.createdAt && Number.isFinite(Date.parse(listing.createdAt)) ? Date.parse(listing.createdAt) : observedAt,
    };
  }
  async function scanTarget(target, config, fx, runStats) {
    const result = await ensureClient().search({ query: queryFor(target), pageNumber: 0, orderBy: 'PriceAscending' });
    const summaries = result.items.filter((item) => fixedPriceAvailable(item) && itemAvailable(item, now()));
    runStats.auctionsRejected += result.items.length - summaries.length;
    const accepted = [];
    let detailReads = 0;
    let metadataPromise = null;
    for (const rawSummary of summaries) {
      const summary = normalizeTraderaItem(rawSummary, { rate: fx.rate, targetCurrency: fx.to });
      if (!summary.itemId || summary.itemPrice == null || !summary.url) continue;
      const match = matchCatalogItem(bridgeItem(summary), { targets: [target] });
      if (!match) { runStats.titleRejected += 1; continue; }
      let detail = rawSummary;
      if (detailReads < 3) {
        try { detail = await ensureClient().getItem(summary.itemId); detailReads += 1; } catch { runStats.detailErrors += 1; }
      }
      const merged = { ...rawSummary, ...detail };
      if (!fixedPriceAvailable(merged) || !itemAvailable(merged, now())) continue;
      const listing = normalizeTraderaItem(merged, { rate: fx.rate, targetCurrency: fx.to });
      if (!metadataPromise) metadataPromise = metadataFor(match.target, config);
      const resolved = resolvePressingMatch(bridgeItem(listing), match, evidenceDetail(listing, merged), await metadataPromise);
      if (!resolved.accepted) { runStats.versionRejected += 1; continue; }
      const shippingEstimate = Math.max(0, Number(config.shippingEstimate) || 0);
      const total = listing.itemPrice + shippingEstimate;
      const reference = Number(resolved.reference) || null;
      const discount = reference > 0 ? (reference - total) / reference : null;
      const minDiscount = Number.isFinite(Number(config.minDiscount)) ? Number(config.minDiscount) : 0.5;
      const minReference = Number.isFinite(Number(config.minReference)) ? Number(config.minReference) : 25;
      const evaluation = { reference, discount, shippingEstimate, isDeal: reference >= minReference && total <= reference * (1 - minDiscount) };
      const record = recordFor(listing, resolved, evaluation, fx, now());
      accepted.push(record);
      const fresh = state.markSeen(record.id, { persist: false });
      if (evaluation.isDeal) {
        state.addDeal(record, { persist: false }); runStats.dealsFound += 1;
        if (fresh) runStats.newDeals.push(record);
      }
    }
    const availability = state.observeAvailability(targetIndexKey(target), accepted.length > 0, {
      releaseId: target.releaseId, artist: target.artist, title: target.title, year: target.year, thumb: target.thumb,
      url: searchUrl(target), itemIds: accepted.map((record) => record.listingId),
    }, { persist: false });
    if (availability.transition.isRareGem && accepted.length) {
      const gem = { ...accepted[0], id: `tradera-gem:${accepted[0].listingId}:${targetIndexKey(target)}`, rareGem: true, transition: availability.transition };
      state.addGem(gem, { persist: false }); runStats.gemsFound += 1; runStats.newGems.push(gem);
    }
    runStats.listingsFound += accepted.length;
  }
  async function runOnce({ all = false } = {}) {
    if (running) return snapshot();
    running = true; lastError = null; progress = { checked: 0, total: 0, all: !!all }; publish();
    const runStats = { checked: 0, listingsFound: 0, dealsFound: 0, gemsFound: 0, auctionsRejected: 0, titleRejected: 0, versionRejected: 0, detailErrors: 0, newDeals: [], newGems: [] };
    try {
      refreshDay();
      if (callsToday >= MAX_DAILY_CALLS - 5) throw new Error('The safe Tradera daily request budget is used up. Scanning resumes tomorrow.');
      ensureClient();
      const ctx = await loadContext(all);
      const fx = await resolveFx(ctx.config.currency || 'EUR');
      const targets = ctx.index.targets;
      const current = state.get();
      const count = all ? targets.length : Math.min(settings().batchSize, targets.length);
      progress = { checked: 0, total: count, all: !!all };
      for (let index = 0; index < count; index++) {
        if (callsToday >= MAX_DAILY_CALLS - 5) break;
        const cursor = all ? index : (current.cursor + index) % targets.length;
        const target = targets[cursor];
        progress = { ...progress, checked: index, current: `${target.artist || ''} – ${target.title || ''}` };
        publish();
        try { await scanTarget(target, ctx.config, fx, runStats); }
        catch (error) {
          if (error && (error.status === 401 || error.status === 403 || error.status === 429)) throw error;
          runStats.detailErrors += 1;
        }
        runStats.checked += 1;
        progress = { ...progress, checked: index + 1 };
        const nextCursor = targets.length ? (cursor + 1) % targets.length : 0;
        state.update({ cursor: nextCursor, health: { ...state.get().health, callDay, callsToday, lastPollAt, fx: lastFx, lastRunStats: { ...runStats, newDeals: undefined, newGems: undefined } } });
      }
      lastPollAt = now(); progress = null;
      state.update({ health: { ...state.get().health, callDay, callsToday, lastPollAt, fx: lastFx, lastRunStats: { ...runStats, newDeals: undefined, newGems: undefined } } });
      return publish({ newDeals: runStats.newDeals, newGems: runStats.newGems, runStats: { ...runStats, newDeals: undefined, newGems: undefined } });
    } catch (error) {
      lastError = error && error.message ? error.message : String(error); progress = null; publish(); throw error;
    } finally { running = false; schedule(); publish(); }
  }
  function schedule() {
    if (timer) clearTimeout(timer); timer = null; nextPollAt = null;
    if (stopped || !settings().enabled) return;
    const delay = settings().pollMinutes * 60 * 1000;
    nextPollAt = now() + delay;
    timer = setTimeout(() => runOnce().catch(() => {}), delay);
  }
  function start() { stopped = false; if (settings().enabled) { schedule(); setTimeout(() => runOnce().catch(() => {}), 1000); } return snapshot(); }
  function stop() { stopped = true; if (timer) clearTimeout(timer); timer = null; nextPollAt = null; }
  function setEnabled(enabled) { options.writeSettings({ traderaEnabled: !!enabled }); stopped = false; schedule(); if (enabled && !lastPollAt) setTimeout(() => runOnce().catch(() => {}), 0); return snapshot(); }
  function configure(patch = {}) {
    const next = {};
    if (patch.pollMinutes != null) next.traderaPollMinutes = clamp(patch.pollMinutes, 5, 1440, 30);
    if (patch.batchSize != null) next.traderaBatchSize = clamp(patch.batchSize, 1, 25, 5);
    options.writeSettings(next); client = null; clientSignature = ''; schedule(); return snapshot();
  }
  function resetClient() { client = null; clientSignature = ''; lastError = null; return snapshot(); }
  return { start, stop, snapshot, runOnce, setEnabled, configure, resetClient };
}

module.exports = {
  createTraderaService, normalizeTraderaItem, safeTraderaUrl, shippingOfferedFrom,
  fixedPriceAvailable, itemAvailable, evidenceDetail, queryFor, MAX_DAILY_CALLS,
};

if (require.main === module && process.argv.includes('--selftest')) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deal-shark-tradera-service-'));
  let settings = { traderaEnabled: false, traderaPollMinutes: 30 };
  const summary = {
    id: 123, shortDescription: 'Macho - I’m A Man original 12 inch', buyItNowPrice: 200,
    itemUrl: 'https://www.tradera.com/item/123', endDate: '2026-12-31T12:00:00Z',
    thumbnailLink: 'https://img.tradera.net/a.jpg', sellerAlias: 'vinyl-seller', bidCount: 0,
  };
  const detail = {
    ...summary, startDate: '2026-08-20T10:00:00Z', longDescription: 'Original pressing GO 123',
    itemAttributes: [2], shippingOptions: [{ cost: 50 }], remainingQuantity: 1,
  };
  const service = createTraderaService({
    stateFile: path.join(dir, 'state.json'), readSettings: () => settings, writeSettings: (patch) => { settings = { ...settings, ...patch }; },
    readConfig: () => ({ username: 'tester', token: 'discogs', currency: 'EUR', minDiscount: 0.5, minReference: 25, shippingEstimate: 5 }),
    loadWantlist: async () => [{ id: 1, artist: 'Macho', title: 'I’m A Man', year: 1978 }],
    loadMedians: async () => ({ 1: { median: 80 } }),
    loadReleaseMetadata: async () => ({ year: 1978, title: 'I’m A Man', artist: 'Macho', formats: [{ name: 'Vinyl', descriptions: ['12"', 'Original'] }], labels: [{ name: 'Goody Music', catno: 'GO 123' }] }),
    getCredentials: () => ({ appId: '1234', appKey: 'secret-key' }),
    getFxRate: async () => ({ rate: 1 / 11.2, date: '2026-08-20', source: 'ecb-daily' }),
    clientFactory: () => ({ search: async () => ({ total: 1, items: [summary] }), getItem: async () => detail }),
    now: () => Date.parse('2026-08-20T12:00:00Z'),
  });
  (async () => {
    const result = await service.runOnce({ all: true });
    assert.strictEqual(result.deals.length, 1);
    assert.strictEqual(result.deals[0].platform, 'tradera');
    assert.strictEqual(result.deals[0].nativeItemPrice, 200);
    assert.strictEqual(result.deals[0].currency, 'EUR');
    assert.strictEqual(result.deals[0].shipping, null, 'offered shipping is not misrepresented as delivery to the configured country');
    assert.strictEqual(result.deals[0].shippingEstimate, 5);
    assert.strictEqual(result.deals[0].sourceType, 'official_api');
    assert.strictEqual(safeTraderaUrl('https://www.tradera.com/item/123', 123).startsWith('https://www.tradera.com/'), true);
    assert.strictEqual(safeTraderaUrl('https://tradera.com.evil.example/item/123', 123), 'https://www.tradera.com/item/123');
    assert.strictEqual(fixedPriceAvailable({ buyItNowPrice: null }), false, 'auction-only rows never become deals');
    console.log('tradera service selftest: OK');
  })().catch((error) => { console.error(error); process.exitCode = 1; });
}

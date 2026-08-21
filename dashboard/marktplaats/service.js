'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMarktplaatsClient } = require('./client');
const { createMarktplaatsState } = require('./state');
const {
  buildWantIndex,
  matchCatalogItem,
  resolvePressingMatch,
  targetIndexKey,
} = require('../vinted/policy');

const DAY_MS = 24 * 60 * 60 * 1000;
const LIVE_TTL_MS = 7 * DAY_MS;
// This is a local safety budget, not a claim about the partner-specific Marktplaats quota.
const MAX_DAILY_CALLS = 4000;

function clamp(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}
function cents(value) {
  const number = Number(value && typeof value === 'object' ? (value.amount ?? value.value) : value);
  return Number.isFinite(number) ? number / 100 : null;
}
function relation(item, name) {
  const entry = item && item._links && item._links[name];
  return Array.isArray(entry) ? entry[0] : entry;
}
function safeMarktplaatsUrl(value) {
  try {
    const url = new URL(String(value || ''));
    const host = url.hostname.toLowerCase();
    if (!['marktplaats.nl', 'www.marktplaats.nl', 'link.marktplaats.nl'].includes(host)) return null;
    if (url.protocol === 'http:' && host === 'link.marktplaats.nl') url.protocol = 'https:';
    return url.protocol === 'https:' ? url.href : null;
  } catch { return null; }
}
function priceModel(item = {}) {
  return item.priceModel && typeof item.priceModel === 'object' ? item.priceModel : {};
}
function fixedPrice(item = {}) {
  const model = priceModel(item);
  return String(model.modelType || '').toLowerCase() === 'fixed' ? cents(model.askingPrice) : null;
}
function itemAvailable(item = {}) {
  const status = String(item.status || item.advertisementStatus || '').toLowerCase();
  return !status || ['available', 'active', 'open'].includes(status);
}
function flattenAttributes(value, prefix = '', output = []) {
  if (value == null || output.length >= 80) return output;
  if (Array.isArray(value)) {
    for (const entry of value) flattenAttributes(entry, prefix, output);
  } else if (typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      if (key.startsWith('_')) continue;
      flattenAttributes(entry, prefix ? `${prefix}.${key}` : key, output);
    }
  } else {
    const text = String(value).trim();
    if (text && text.length <= 240) output.push(`${prefix}: ${text}`);
  }
  return output;
}
function imageId(item = {}) {
  const embedded = item._embedded && item._embedded['mp:advertisement-image'];
  const image = Array.isArray(embedded) ? embedded[0] : embedded;
  return image && (image.mediaId || image.imageId) || null;
}
function normalizeMarktplaatsItem(item = {}) {
  const model = priceModel(item);
  const website = relation(item, 'mp:advertisement-website-link');
  const itemId = String(item.itemId || item.id || '').trim();
  const createdAt = item.creationDate || item.createdAt || item.startDate || item.activationDate || null;
  return {
    itemId,
    title: String(item.title || ''),
    description: String(item.description || ''),
    itemPrice: fixedPrice(item),
    currency: String(model.currency || 'EUR').toUpperCase(),
    priceModel: String(model.modelType || '').toLowerCase(),
    condition: String(item.condition || item.itemCondition || ''),
    seller: item.seller && (item.seller.sellerName || item.seller.name || item.seller.sellerId) || null,
    sellerId: item.seller && item.seller.sellerId || null,
    location: item.location && (item.location.cityName || item.location.postcode) || null,
    postcode: item.location && item.location.postcode || null,
    categoryId: item.categoryId || null,
    locale: item.locale || null,
    imageId: imageId(item),
    url: safeMarktplaatsUrl(website && website.href || item.websiteUrl || item.url || (itemId ? `https://link.marktplaats.nl/${itemId}` : '')),
    createdAt,
    attributes: item.attributes || item.attributeValues || null,
    raw: item,
  };
}
function bridgeItem(listing) {
  return {
    id: listing.itemId,
    title: listing.title,
    description: listing.description,
    price: { amount: listing.itemPrice, currency_code: listing.currency },
    created_at: listing.createdAt,
  };
}
function evidenceDetail(listing, detail = {}) {
  return {
    name: detail.title || listing.title,
    description: [detail.description || listing.description, flattenAttributes(detail.attributes || detail.attributeValues).join(' · ')].filter(Boolean).join(' · '),
    brand: String(detail.brand || detail.label || ''),
    category: [detail.categoryName, detail.category, listing.condition].filter(Boolean).join(' · '),
  };
}
function queryFor(target) {
  return `${target.artist || ''} ${target.title || ''} vinyl`.replace(/\s+/g, ' ').trim().slice(0, 120);
}

function createMarktplaatsService(options = {}) {
  if (!options.stateFile) throw new Error('createMarktplaatsService needs stateFile.');
  for (const name of ['readSettings', 'writeSettings', 'readConfig', 'loadWantlist', 'loadMedians', 'loadReleaseMetadata', 'getCredentials']) {
    if (typeof options[name] !== 'function') throw new Error(`createMarktplaatsService needs ${name}.`);
  }
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const emit = typeof options.emit === 'function' ? options.emit : () => {};
  const clientFactory = options.clientFactory || createMarktplaatsClient;
  const state = createMarktplaatsState(options.stateFile);
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

  function settings() {
    const value = options.readSettings() || {};
    return {
      enabled: value.marktplaatsEnabled === true,
      pollMinutes: clamp(value.marktplaatsPollMinutes, 5, 1440, 30),
      batchSize: clamp(value.marktplaatsBatchSize, 1, 25, 5),
      categoryId: /^\d+$/.test(String(value.marktplaatsCategoryId || '').trim()) ? String(value.marktplaatsCategoryId).trim() : '',
      postcode: String(value.marktplaatsPostcode || '').replace(/\s+/g, '').toUpperCase().slice(0, 6),
      distance: clamp(value.marktplaatsDistance, 1000, 500000, 100000),
    };
  }
  function refreshDay() {
    const day = new Date(now()).toISOString().slice(0, 10);
    if (day !== callDay) { callDay = day; callsToday = 0; }
  }
  function recordRequest() { refreshDay(); callsToday += 1; }
  function credentials() {
    const value = options.getCredentials() || {};
    return { clientId: value.clientId || '', clientSecret: value.clientSecret || '' };
  }
  function ensureClient() {
    const creds = credentials();
    const signature = JSON.stringify([creds.clientId, creds.clientSecret]);
    if (!client || signature !== clientSignature) {
      client = clientFactory({ ...creds, onRequest: recordRequest });
      clientSignature = signature;
    }
    return client;
  }
  async function loadContext(force = false) {
    const config = options.readConfig() || {};
    if (!force && context && now() - contextLoadedAt < 30 * 60 * 1000 && context.username === config.username && context.token === config.token) return context;
    if (!config.username || !config.token) throw new Error('Add your Discogs username and token first; Marktplaats matching uses that wantlist.');
    const [wantlist, medians] = await Promise.all([options.loadWantlist(config), options.loadMedians()]);
    const index = buildWantIndex(wantlist, medians || {});
    if (!index.targets.length) throw new Error('Your Discogs wantlist is empty.');
    context = { config, username: config.username, token: config.token, index };
    contextLoadedAt = now();
    state.update({ wantlist: index.targets.map((target) => ({ releaseId: target.releaseId, releaseIds: target.releaseIds, artist: target.artist, title: target.title, year: target.year, thumb: target.thumb, median: target.median })) });
    return context;
  }
  function searchUrl(target) {
    const query = encodeURIComponent(queryFor(target));
    return `https://www.marktplaats.nl/q/${query}/`;
  }
  function zeroWatch(snapshot = state.get()) {
    return Object.entries(snapshot.availability || {}).filter(([, value]) => value && value.status === 'zero').map(([key, value]) => ({
      releaseId: value.releaseId || key, artist: value.artist || '', title: value.title || '', year: value.year || null,
      thumb: value.thumb || null, checkedAt: value.checkedAt || null, url: value.url || `https://www.marktplaats.nl/q/${encodeURIComponent(`${value.artist || ''} ${value.title || ''} vinyl`)}/`,
    })).sort((a, b) => (b.checkedAt || 0) - (a.checkedAt || 0));
  }
  function publicStatus() {
    refreshDay();
    const cfg = settings(); const snapshot = state.get(); const creds = credentials();
    const hasCredentials = !!creds.clientId && !!creds.clientSecret;
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
      lastRunStats: snapshot.health && snapshot.health.lastRunStats || null,
      error: lastError,
      message: !hasCredentials ? 'Add Marktplaats API partner credentials to connect official search.'
        : (lastPollAt ? 'Official Marktplaats API · fixed-price listings · pressing-matched against your Discogs wantlist.' : 'Marktplaats API is configured and ready.'),
    };
  }
  function snapshot(extra = {}) {
    const current = state.get(); const cutoff = now() - LIVE_TTL_MS;
    return {
      status: publicStatus(),
      deals: current.deals.filter((record) => Number(record.observedAt || record.ts || 0) >= cutoff),
      matches: current.matches.filter((record) => Number(record.observedAt || record.ts || 0) >= cutoff),
      gems: { ts: current.updatedAt || null, gems: current.gems, zeroWatch: zeroWatch(current) },
      ...extra,
    };
  }
  function publish(extra) { const value = snapshot(extra); try { emit(value); } catch { /* renderer may be closed */ } return value; }
  async function metadataFor(group, config) {
    const result = {};
    for (const pressing of Array.isArray(group.pressings) ? group.pressings : [group]) {
      if (pressing && pressing.releaseId != null) result[pressing.releaseId] = await options.loadReleaseMetadata(pressing.releaseId, config);
    }
    return result;
  }
  function recordFor(listing, resolved, evaluation, observedAt) {
    return {
      id: `marktplaats:${listing.itemId}`,
      platform: 'marktplaats',
      sourceType: 'official_api',
      listingId: listing.itemId,
      releaseId: resolved.target.releaseId,
      releaseIds: resolved.target.releaseIds || [resolved.target.releaseId],
      artist: resolved.target.artist,
      title: resolved.target.title,
      year: resolved.target.year,
      thumb: resolved.target.thumb || null,
      listingTitle: listing.title,
      itemCondition: listing.condition || null,
      itemPrice: listing.itemPrice,
      lowest: listing.itemPrice,
      currency: listing.currency,
      shipping: null,
      shippingSource: null,
      shippingEstimate: evaluation.shippingEstimate,
      shipsFrom: listing.location,
      reference: evaluation.reference,
      referenceSource: 'sold-median',
      discount: evaluation.discount,
      alertEligible: !!evaluation.isDeal,
      dashboardOnly: !evaluation.isDeal,
      numForSale: 1,
      matchScore: resolved.score,
      pressingVerified: true,
      pressingEvidence: resolved.evidence || [],
      conditionConfirmed: false,
      freshListing: listing.createdAt ? now() - Date.parse(listing.createdAt) < DAY_MS : false,
      observedAt,
      seller: listing.seller,
      sellerId: listing.sellerId,
      categoryId: listing.categoryId,
      postcode: listing.postcode,
      priceModel: listing.priceModel,
      url: listing.url,
      listingUrl: listing.url,
      provenance: { source: 'marktplaats-api-v2', observedAt },
      ts: listing.createdAt && Number.isFinite(Date.parse(listing.createdAt)) ? Date.parse(listing.createdAt) : observedAt,
    };
  }
  async function scanTarget(target, config, runStats) {
    const cfg = settings();
    const result = await ensureClient().search({ query: queryFor(target), categoryId: cfg.categoryId, postcode: cfg.postcode, distance: cfg.distance, limit: 10 });
    const candidates = result.items.map(normalizeMarktplaatsItem).filter((listing) => listing.itemId && listing.itemPrice != null && listing.url && listing.priceModel === 'fixed' && itemAvailable(listing.raw));
    const accepted = [];
    let detailReads = 0;
    for (const summary of candidates) {
      const match = matchCatalogItem(bridgeItem(summary), { targets: [target] });
      if (!match) { runStats.titleRejected += 1; continue; }
      let detail = summary.raw;
      if (detailReads < 3) {
        try { detail = await ensureClient().getAdvertisement(summary.itemId); detailReads += 1; } catch { runStats.detailErrors += 1; }
      }
      const listing = normalizeMarktplaatsItem({ ...summary.raw, ...detail, _links: detail._links || summary.raw._links, _embedded: detail._embedded || summary.raw._embedded });
      if (listing.currency !== 'EUR' || String(config.currency || 'EUR').toUpperCase() !== 'EUR') { runStats.currencyRejected += 1; continue; }
      if (listing.priceModel !== 'fixed' || !itemAvailable(listing.raw)) { runStats.nonFixedRejected += 1; continue; }
      const metadata = await metadataFor(match.target, config);
      const resolved = resolvePressingMatch(bridgeItem(listing), match, evidenceDetail(listing, detail), metadata);
      if (!resolved.accepted) { runStats.versionRejected += 1; continue; }
      const shippingEstimate = Math.max(0, Number(config.shippingEstimate) || 0);
      const total = listing.itemPrice + shippingEstimate;
      const reference = Number(resolved.reference) || null;
      const discount = reference > 0 ? (reference - total) / reference : null;
      const minDiscount = Number.isFinite(Number(config.minDiscount)) ? Number(config.minDiscount) : 0.5;
      const minReference = Number.isFinite(Number(config.minReference)) ? Number(config.minReference) : 25;
      const evaluation = { reference, discount, shippingEstimate, isDeal: reference >= minReference && total <= reference * (1 - minDiscount) };
      const observedAt = now();
      const record = recordFor(listing, resolved, evaluation, observedAt);
      accepted.push(record);
      state.addMatch(record, { persist: false });
      if (evaluation.isDeal) {
        const fresh = state.markSeen(record.id, { persist: false });
        state.addDeal(record, { persist: false }); runStats.dealsFound += 1;
        if (fresh) runStats.newDeals.push(record);
      }
    }
    const availability = state.observeAvailability(targetIndexKey(target), accepted.length > 0, {
      releaseId: target.releaseId, artist: target.artist, title: target.title, year: target.year, thumb: target.thumb,
      url: searchUrl(target), itemIds: accepted.map((record) => record.listingId),
    }, { persist: false });
    if (availability.transition.isRareGem && accepted.length) {
      const gem = { ...accepted[0], id: `marktplaats-gem:${accepted[0].listingId}:${targetIndexKey(target)}`, rareGem: true, transition: availability.transition };
      state.addGem(gem, { persist: false }); runStats.gemsFound += 1; runStats.newGems.push(gem);
    }
    runStats.listingsFound += accepted.length;
  }
  async function runOnce({ all = false } = {}) {
    if (running) return snapshot();
    running = true; lastError = null; progress = { checked: 0, total: 0, all: !!all }; publish();
    const runStats = { checked: 0, listingsFound: 0, dealsFound: 0, gemsFound: 0, titleRejected: 0, versionRejected: 0, currencyRejected: 0, nonFixedRejected: 0, detailErrors: 0, newDeals: [], newGems: [] };
    try {
      refreshDay();
      if (callsToday >= MAX_DAILY_CALLS - 5) throw new Error('The local Marktplaats request safety budget is used up. Scanning resumes tomorrow.');
      ensureClient();
      const ctx = await loadContext(all);
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
        try { await scanTarget(target, ctx.config, runStats); }
        catch (error) {
          if (error && (error.status === 401 || error.status === 403 || error.status === 429)) throw error;
          runStats.detailErrors += 1;
        }
        runStats.checked += 1;
        progress = { ...progress, checked: index + 1 };
        const nextCursor = targets.length ? (cursor + 1) % targets.length : 0;
        state.update({ cursor: nextCursor, health: { ...state.get().health, callDay, callsToday, lastPollAt, lastRunStats: { ...runStats, newDeals: undefined, newGems: undefined } } });
      }
      lastPollAt = now(); progress = null;
      state.update({ health: { ...state.get().health, callDay, callsToday, lastPollAt, lastRunStats: { ...runStats, newDeals: undefined, newGems: undefined } } });
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
  function start() { stopped = false; if (settings().enabled) { schedule(); setTimeout(() => runOnce().catch(() => {}), 750); } return snapshot(); }
  function stop() { stopped = true; if (timer) clearTimeout(timer); timer = null; nextPollAt = null; }
  function setEnabled(enabled) { options.writeSettings({ marktplaatsEnabled: !!enabled }); stopped = false; schedule(); if (enabled && !lastPollAt) setTimeout(() => runOnce().catch(() => {}), 0); return snapshot(); }
  function configure(patch = {}) {
    const next = {};
    if (patch.pollMinutes != null) next.marktplaatsPollMinutes = clamp(patch.pollMinutes, 5, 1440, 30);
    if (patch.batchSize != null) next.marktplaatsBatchSize = clamp(patch.batchSize, 1, 25, 5);
    if (patch.categoryId != null) next.marktplaatsCategoryId = /^\d+$/.test(String(patch.categoryId).trim()) ? String(patch.categoryId).trim() : '';
    if (patch.postcode != null) next.marktplaatsPostcode = String(patch.postcode).replace(/\s+/g, '').toUpperCase().slice(0, 6);
    if (patch.distance != null) next.marktplaatsDistance = clamp(patch.distance, 1000, 500000, 100000);
    options.writeSettings(next); client = null; clientSignature = ''; schedule(); return snapshot();
  }
  function resetClient() { client = null; clientSignature = ''; lastError = null; return snapshot(); }
  return { start, stop, snapshot, runOnce, setEnabled, configure, resetClient };
}

module.exports = { createMarktplaatsService, normalizeMarktplaatsItem, safeMarktplaatsUrl, fixedPrice, itemAvailable, queryFor, MAX_DAILY_CALLS };

if (require.main === module && process.argv.includes('--selftest')) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deal-shark-marktplaats-service-'));
  let settings = { marktplaatsEnabled: false, marktplaatsPollMinutes: 30, marktplaatsPostcode: '2011AA', marktplaatsDistance: 100000 };
  let config = { username: 'tester', token: 'discogs', currency: 'EUR', minDiscount: 0.5, minReference: 100, shippingEstimate: 5 };
  const summary = {
    itemId: 'm123', title: 'Macho - I’m A Man original 12 inch', description: 'Goody Music GO 123',
    priceModel: { modelType: 'fixed', askingPrice: 2000, currency: 'EUR' }, status: 'available',
    seller: { sellerId: 7, sellerName: 'vinylseller' }, location: { postcode: '2011AA', cityName: 'Haarlem' },
    _links: { 'mp:advertisement-website-link': { href: 'http://link.marktplaats.nl/m123' } },
  };
  const service = createMarktplaatsService({
    stateFile: path.join(dir, 'state.json'), readSettings: () => settings, writeSettings: (patch) => { settings = { ...settings, ...patch }; },
    readConfig: () => config,
    loadWantlist: async () => [{ id: 1, artist: 'Macho', title: 'I’m A Man', year: 1978 }],
    loadMedians: async () => ({ 1: { median: 80 } }),
    loadReleaseMetadata: async () => ({ year: 1978, title: 'I’m A Man', artist: 'Macho', formats: [{ name: 'Vinyl', descriptions: ['12"', 'Original'] }], labels: [{ name: 'Goody Music', catno: 'GO 123' }] }),
    getCredentials: () => ({ clientId: 'client', clientSecret: 'secret' }),
    clientFactory: () => ({ search: async () => ({ total: 1, items: [summary] }), getAdvertisement: async () => ({ ...summary, attributes: { catalogNumber: 'GO 123', format: '12 inch' } }) }),
  });
  (async () => {
    const browseResult = await service.runOnce({ all: true });
    assert.strictEqual(browseResult.matches.length, 1, 'safe matches remain available to dashboard filters');
    assert.strictEqual(browseResult.matches[0].alertEligible, false);
    assert.strictEqual(browseResult.deals.length, 0, 'dashboard-only matches never cross the strict alert boundary');
    assert.strictEqual(browseResult.newDeals.length, 0);
    config = { ...config, minReference: 25 };
    const result = await service.runOnce({ all: true });
    assert.strictEqual(result.deals.length, 1);
    assert.strictEqual(result.matches.length, 1);
    assert.strictEqual(result.newDeals.length, 1, 'a previously browsed listing alerts when it later becomes strictly eligible');
    assert.strictEqual(result.deals[0].platform, 'marktplaats');
    assert.strictEqual(result.deals[0].shipping, null);
    assert.strictEqual(result.deals[0].shippingEstimate, 5);
    assert.strictEqual(result.deals[0].sourceType, 'official_api');
    assert.ok(safeMarktplaatsUrl('http://link.marktplaats.nl/m123').startsWith('https://link.marktplaats.nl/'));
    assert.strictEqual(safeMarktplaatsUrl('https://marktplaats.nl.evil.example/m123'), null);
    assert.strictEqual(fixedPrice({ priceModel: { modelType: 'bid', askingPrice: 1000 } }), null);
    console.log('marktplaats service selftest: OK');
  })().catch((error) => { console.error(error); process.exitCode = 1; });
}

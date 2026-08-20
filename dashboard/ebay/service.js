'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createEbayClient } = require('./client');
const { createEbayState } = require('./state');
const {
  buildWantIndex,
  matchCatalogItem,
  resolvePressingMatch,
  targetIndexKey,
} = require('../vinted/policy');

const DAY_MS = 24 * 60 * 60 * 1000;
const LIVE_TTL_MS = 7 * DAY_MS;
const MAX_DAILY_CALLS = 4800;

function clamp(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}
function money(value) {
  const number = Number(value && typeof value === 'object' ? (value.value ?? value.amount) : value);
  return Number.isFinite(number) ? number : null;
}
function aspectMap(item = {}) {
  const result = {};
  for (const aspect of Array.isArray(item.localizedAspects) ? item.localizedAspects : []) {
    const key = String(aspect && aspect.name || '').trim().toLowerCase();
    const value = String(aspect && aspect.value || '').trim();
    if (key && value) result[key] = value;
  }
  return result;
}
function aspectValue(aspects, ...names) {
  for (const name of names) if (aspects[String(name).toLowerCase()]) return aspects[String(name).toLowerCase()];
  return '';
}
function safeEbayUrl(value) {
  try {
    const url = new URL(String(value || ''));
    const host = url.hostname.toLowerCase();
    const allowed = /^(?:www\.)?ebay\.(?:com|nl|de|fr|it|es|be|at|ch|ie|pl|ca|com\.be|com\.au|co\.uk)$/.test(host);
    return url.protocol === 'https:' && allowed ? url.href : null;
  } catch { return null; }
}
function shippingCost(item = {}) {
  const values = (Array.isArray(item.shippingOptions) ? item.shippingOptions : [])
    .map((option) => money(option && option.shippingCost)).filter((value) => value != null && value >= 0);
  return values.length ? Math.min(...values) : null;
}
function importCharges(item = {}) {
  const values = (Array.isArray(item.shippingOptions) ? item.shippingOptions : [])
    .map((option) => money(option && option.importCharges)).filter((value) => value != null && value >= 0);
  return values.length ? Math.min(...values) : 0;
}
function buyingAllowed(item = {}) {
  const options = Array.isArray(item.buyingOptions) ? item.buyingOptions.map(String) : [];
  return options.includes('FIXED_PRICE') || options.includes('BEST_OFFER');
}
function itemAvailable(item = {}, now = Date.now()) {
  if (item.itemEndDate && Date.parse(item.itemEndDate) <= now) return false;
  const states = (Array.isArray(item.estimatedAvailabilities) ? item.estimatedAvailabilities : [])
    .map((entry) => entry && entry.estimatedAvailabilityStatus).filter(Boolean);
  return !states.length || states.some((state) => state === 'IN_STOCK' || state === 'LIMITED_STOCK');
}
function normalizeEbayItem(item = {}) {
  const aspects = aspectMap(item);
  const itemId = String(item.itemId || '').trim();
  const itemPrice = money(item.price);
  const deliveryCost = shippingCost(item);
  const importCost = importCharges(item);
  const shipping = deliveryCost == null ? null : deliveryCost + importCost;
  const currency = String(item.price && item.price.currency || 'EUR').toUpperCase();
  return {
    itemId,
    title: String(item.title || ''),
    artist: aspectValue(aspects, 'Artist', 'Interpret'),
    releaseTitle: aspectValue(aspects, 'Release Title', 'Record Title', 'Titel'),
    itemPrice,
    shipping,
    deliveryCost,
    importCharges: importCost,
    currency,
    condition: String(item.condition || ''),
    conditionId: item.conditionId || null,
    seller: item.seller && (item.seller.username || item.seller.userId) || null,
    sellerFeedbackPercentage: money(item.seller && item.seller.feedbackPercentage),
    location: item.itemLocation && (item.itemLocation.country || item.itemLocation.city) || null,
    image: item.image && item.image.imageUrl || null,
    url: safeEbayUrl(item.itemAffiliateWebUrl || item.itemWebUrl),
    createdAt: item.itemOriginDate || item.itemCreationDate || null,
    endAt: item.itemEndDate || null,
    buyingOptions: Array.isArray(item.buyingOptions) ? item.buyingOptions.map(String) : [],
    bidCount: Math.max(0, Number(item.bidCount) || 0),
    aspects,
    raw: item,
  };
}
function bridgeItem(listing) {
  return {
    id: listing.itemId,
    title: `${listing.artist ? `${listing.artist} - ` : ''}${listing.title}`,
    artist: listing.artist,
    release_title: listing.releaseTitle,
    price: { amount: listing.itemPrice, currency_code: listing.currency },
    created_at: listing.createdAt,
  };
}
function evidenceDetail(listing, detail = {}) {
  const aspects = { ...listing.aspects, ...aspectMap(detail) };
  return {
    name: detail.title || listing.title,
    description: [detail.shortDescription, detail.description, Object.entries(aspects).map(([key, value]) => `${key}: ${value}`).join(' · ')].filter(Boolean).join(' · '),
    brand: aspectValue(aspects, 'Record Label', 'Label'),
    category: [aspectValue(aspects, 'Format'), aspectValue(aspects, 'Genre'), aspectValue(aspects, 'Style')].filter(Boolean).join(' · '),
  };
}
function queryFor(target) {
  return `${target.artist || ''} ${target.title || ''} vinyl`.replace(/\s+/g, ' ').trim().slice(0, 100);
}

function createEbayService(options = {}) {
  if (!options.stateFile) throw new Error('createEbayService needs stateFile.');
  for (const name of ['readSettings', 'writeSettings', 'readConfig', 'loadWantlist', 'loadMedians', 'loadReleaseMetadata', 'getCredentials']) {
    if (typeof options[name] !== 'function') throw new Error(`createEbayService needs ${name}.`);
  }
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const emit = typeof options.emit === 'function' ? options.emit : () => {};
  const clientFactory = options.clientFactory || createEbayClient;
  const state = createEbayState(options.stateFile);
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
      enabled: value.ebayEnabled === true,
      pollMinutes: clamp(value.ebayPollMinutes, 5, 1440, 15),
      batchSize: clamp(value.ebayBatchSize, 1, 25, 5),
      marketplace: String(value.ebayMarketplace || 'EBAY_NL'),
      deliveryCountry: String(value.ebayDeliveryCountry || 'NL'),
      postalCode: String(value.ebayPostalCode || ''),
      environment: value.ebayEnvironment === 'sandbox' ? 'sandbox' : 'production',
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
    const cfg = settings(); const creds = credentials();
    const signature = JSON.stringify([creds.clientId, creds.clientSecret, cfg.environment, cfg.marketplace, cfg.deliveryCountry, cfg.postalCode]);
    if (!client || signature !== clientSignature) {
      client = clientFactory({ ...creds, ...cfg, onRequest: recordRequest });
      clientSignature = signature;
    }
    return client;
  }
  async function loadContext(force = false) {
    const config = options.readConfig() || {};
    if (!force && context && now() - contextLoadedAt < 30 * 60 * 1000 && context.username === config.username && context.token === config.token) return context;
    if (!config.username || !config.token) throw new Error('Add your Discogs username and token first; eBay matching uses that wantlist.');
    const [wantlist, medians] = await Promise.all([options.loadWantlist(config), options.loadMedians()]);
    const index = buildWantIndex(wantlist, medians || {});
    if (!index.targets.length) throw new Error('Your Discogs wantlist is empty.');
    context = { config, username: config.username, token: config.token, index };
    contextLoadedAt = now();
    state.update({ wantlist: index.targets.map((target) => ({ releaseId: target.releaseId, releaseIds: target.releaseIds, artist: target.artist, title: target.title, year: target.year, thumb: target.thumb, median: target.median })) });
    return context;
  }
  function zeroWatch(snapshot = state.get()) {
    return Object.entries(snapshot.availability || {}).filter(([, value]) => value && value.status === 'zero').map(([key, value]) => ({
      releaseId: value.releaseId || key, artist: value.artist || '', title: value.title || '', year: value.year || null,
      thumb: value.thumb || null, checkedAt: value.checkedAt || null, url: value.url || `https://www.ebay.nl/sch/i.html?_nkw=${encodeURIComponent(`${value.artist || ''} ${value.title || ''} vinyl`)}`,
    })).sort((a, b) => (b.checkedAt || 0) - (a.checkedAt || 0));
  }
  function publicStatus() {
    refreshDay();
    const cfg = settings(); const snapshot = state.get(); const hasCredentials = !!credentials().clientId && !!credentials().clientSecret;
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
      error: lastError,
      message: !hasCredentials ? 'Add your eBay developer credentials to connect the official Browse API.'
        : (lastPollAt ? `Official ${cfg.marketplace} Browse API · pressing-matched against your Discogs wantlist.` : 'eBay API is configured and ready.'),
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
  function recordFor(listing, resolved, evaluation, target, observedAt) {
    const shipping = listing.shipping;
    return {
      id: `ebay:${listing.itemId}`,
      platform: 'ebay',
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
      lowest: listing.itemPrice,
      currency: listing.currency,
      shipping,
      deliveryCost: listing.deliveryCost,
      importCharges: listing.importCharges,
      shippingSource: shipping == null ? null : 'ebay-api',
      shippingEstimate: shipping == null ? evaluation.shippingEstimate : null,
      shipsFrom: listing.location,
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
      sellerFeedbackPercentage: listing.sellerFeedbackPercentage,
      buyingOptions: listing.buyingOptions,
      bids: listing.bidCount,
      itemEndAt: listing.endAt,
      url: listing.url,
      listingUrl: listing.url,
      provenance: { source: 'ebay-browse-api', marketplace: settings().marketplace, observedAt },
      ts: listing.createdAt && Number.isFinite(Date.parse(listing.createdAt)) ? Date.parse(listing.createdAt) : observedAt,
    };
  }
  async function scanTarget(target, config, runStats) {
    const result = await ensureClient().search({ q: queryFor(target), limit: 10, sort: 'newlyListed' });
    const candidates = result.items.map(normalizeEbayItem).filter((listing) => listing.itemId && listing.itemPrice != null && listing.url && buyingAllowed(listing.raw) && itemAvailable(listing.raw, now()));
    const accepted = [];
    let detailReads = 0;
    for (const summary of candidates) {
      const match = matchCatalogItem(bridgeItem(summary), { targets: [target] });
      if (!match) { runStats.titleRejected += 1; continue; }
      let detail = summary.raw;
      if (detailReads < 3) {
        try { detail = await ensureClient().getItem(summary.itemId); detailReads += 1; } catch (error) { runStats.detailErrors += 1; }
      }
      const listing = normalizeEbayItem({ ...summary.raw, ...detail, localizedAspects: detail.localizedAspects || summary.raw.localizedAspects });
      const configuredCurrency = String(config.currency || 'EUR').toUpperCase();
      if (listing.currency !== configuredCurrency) { runStats.currencyRejected += 1; continue; }
      const metadata = await metadataFor(match.target, config);
      const resolved = resolvePressingMatch(bridgeItem(listing), match, evidenceDetail(listing, detail), metadata);
      if (!resolved.accepted) { runStats.versionRejected += 1; continue; }
      const shippingEstimate = listing.shipping == null ? Math.max(0, Number(config.shippingEstimate) || 0) : listing.shipping;
      const total = listing.itemPrice + shippingEstimate;
      const reference = Number(resolved.reference) || null;
      const discount = reference > 0 ? (reference - total) / reference : null;
      const minDiscount = Number.isFinite(Number(config.minDiscount)) ? Number(config.minDiscount) : 0.5;
      const minReference = Number.isFinite(Number(config.minReference)) ? Number(config.minReference) : 25;
      const evaluation = { reference, discount, shippingEstimate, isDeal: reference >= minReference && total <= reference * (1 - minDiscount) };
      const observedAt = now();
      const record = recordFor(listing, resolved, evaluation, target, observedAt);
      accepted.push(record);
      const fresh = state.markSeen(record.id, { persist: false });
      if (evaluation.isDeal) {
        state.addDeal(record, { persist: false }); runStats.dealsFound += 1;
        if (fresh) runStats.newDeals.push(record);
      }
    }
    const availability = state.observeAvailability(targetIndexKey(target), accepted.length > 0, {
      releaseId: target.releaseId, artist: target.artist, title: target.title, year: target.year, thumb: target.thumb,
      url: `https://www.ebay.nl/sch/i.html?_nkw=${encodeURIComponent(queryFor(target))}`,
      itemIds: accepted.map((record) => record.listingId),
    }, { persist: false });
    if (availability.transition.isRareGem && accepted.length) {
      const gem = { ...accepted[0], id: `ebay-gem:${accepted[0].listingId}:${targetIndexKey(target)}`, rareGem: true, transition: availability.transition };
      state.addGem(gem, { persist: false }); runStats.gemsFound += 1; runStats.newGems.push(gem);
    }
    runStats.listingsFound += accepted.length;
  }
  async function runOnce({ all = false } = {}) {
    if (running) return snapshot();
    running = true; lastError = null; progress = { checked: 0, total: 0, all: !!all }; publish();
    const runStats = { checked: 0, listingsFound: 0, dealsFound: 0, gemsFound: 0, titleRejected: 0, versionRejected: 0, currencyRejected: 0, detailErrors: 0, newDeals: [], newGems: [] };
    try {
      refreshDay();
      if (callsToday >= MAX_DAILY_CALLS - 5) throw new Error('The safe eBay daily request budget is used up. Scanning resumes tomorrow.');
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
  function setEnabled(enabled) { options.writeSettings({ ebayEnabled: !!enabled }); stopped = false; schedule(); if (enabled && !lastPollAt) setTimeout(() => runOnce().catch(() => {}), 0); return snapshot(); }
  function configure(patch = {}) {
    const next = {};
    if (patch.pollMinutes != null) next.ebayPollMinutes = clamp(patch.pollMinutes, 5, 1440, 15);
    if (patch.batchSize != null) next.ebayBatchSize = clamp(patch.batchSize, 1, 25, 5);
    if (patch.marketplace) next.ebayMarketplace = String(patch.marketplace);
    if (patch.deliveryCountry) next.ebayDeliveryCountry = String(patch.deliveryCountry);
    if (patch.postalCode != null) next.ebayPostalCode = String(patch.postalCode).trim();
    if (patch.environment) next.ebayEnvironment = patch.environment === 'sandbox' ? 'sandbox' : 'production';
    options.writeSettings(next); client = null; clientSignature = ''; schedule(); return snapshot();
  }
  function resetClient() { client = null; clientSignature = ''; lastError = null; return snapshot(); }
  return { start, stop, snapshot, runOnce, setEnabled, configure, resetClient };
}

module.exports = { createEbayService, normalizeEbayItem, safeEbayUrl, shippingCost, importCharges, buyingAllowed, itemAvailable, queryFor, MAX_DAILY_CALLS };

if (require.main === module && process.argv.includes('--selftest')) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deal-shark-ebay-service-'));
  let settings = { ebayEnabled: false, ebayPollMinutes: 15, ebayMarketplace: 'EBAY_NL', ebayDeliveryCountry: 'NL' };
  const summary = {
    itemId: 'v1|123|0', title: 'Macho - I’m A Man original 12 inch', itemWebUrl: 'https://www.ebay.nl/itm/123',
    price: { value: '20', currency: 'EUR' }, shippingOptions: [{ shippingCost: { value: '5', currency: 'EUR' } }],
    buyingOptions: ['FIXED_PRICE'], itemOriginDate: new Date().toISOString(), condition: 'Used', image: { imageUrl: 'https://i.ebayimg.com/a.jpg' },
    localizedAspects: [{ name: 'Artist', value: 'Macho' }, { name: 'Catalog Number', value: 'GO 123' }, { name: 'Format', value: '12 inch' }],
  };
  const service = createEbayService({
    stateFile: path.join(dir, 'state.json'), readSettings: () => settings, writeSettings: (patch) => { settings = { ...settings, ...patch }; },
    readConfig: () => ({ username: 'tester', token: 'discogs', currency: 'EUR', minDiscount: 0.5, shippingEstimate: 5 }),
    loadWantlist: async () => [{ id: 1, artist: 'Macho', title: 'I’m A Man', year: 1978 }],
    loadMedians: async () => ({ 1: { median: 80 } }),
    loadReleaseMetadata: async () => ({ year: 1978, title: 'I’m A Man', artist: 'Macho', formats: [{ name: 'Vinyl', descriptions: ['12"', 'Original'] }], labels: [{ name: 'Goody Music', catno: 'GO 123' }] }),
    getCredentials: () => ({ clientId: 'app', clientSecret: 'secret' }),
    clientFactory: () => ({ search: async () => ({ total: 1, items: [summary] }), getItem: async () => ({ ...summary, description: 'Original pressing GO 123' }) }),
  });
  (async () => {
    const result = await service.runOnce({ all: true });
    assert.strictEqual(result.deals.length, 1);
    assert.strictEqual(result.deals[0].platform, 'ebay');
    assert.strictEqual(result.deals[0].shipping, 5);
    assert.strictEqual(result.deals[0].sourceType, 'official_api');
    assert.strictEqual(safeEbayUrl('https://www.ebay.nl/itm/123').startsWith('https://www.ebay.nl/'), true);
    assert.strictEqual(safeEbayUrl('https://ebay.nl.evil.example/itm/123'), null);
    console.log('ebay service selftest: OK');
  })().catch((error) => { console.error(error); process.exitCode = 1; });
}

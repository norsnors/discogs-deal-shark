'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMarktplaatsClient, createMarktplaatsWebClient } = require('./client');
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
const MAX_WEB_DAILY_CALLS = 500;
// The public fallback affords roughly 500 searches a day against a wantlist that is far larger, so
// a plain round-robin cursor leaves the valuable half of the list unchecked for days at a time.
// Targets are ordered by worth, and every batch reserves part of itself for that head while the
// remainder keeps rotating, so the expensive records are covered daily without starving the rest.
const PRIORITY_HEAD_RATIO = 0.25;
const PRIORITY_BATCH_RATIO = 0.4;
const MIN_PRIORITY_HEAD = 25;

function targetWorth(target) {
  const median = Number(target && target.median);
  return Number.isFinite(median) && median > 0 ? median : 0;
}
function orderedTargets(targets) {
  return (Array.isArray(targets) ? targets.slice() : []).sort((a, b) => Number(!!b.discogsRare) - Number(!!a.discogsRare)
    || targetWorth(b) - targetWorth(a)
    || targetIndexKey(a).localeCompare(targetIndexKey(b)));
}
function priorityHeadSize(total) {
  if (!(total > 0)) return 0;
  return Math.min(total, Math.max(MIN_PRIORITY_HEAD, Math.ceil(total * PRIORITY_HEAD_RATIO)));
}
// Pure so the two-lane schedule stays regression-testable outside Electron. The lanes cover
// disjoint ranges — priority owns the worth-ordered head, rotation owns the tail — so no batch
// ever spends two of its scarce requests on the same target. Returns the positions to scan, each
// tagged with the cursor it advances on success.
function planTargets({ total = 0, cursor = 0, priorityCursor = 0, count = 0 } = {}) {
  const size = Math.max(0, Math.trunc(Number(total) || 0));
  const wanted = Math.min(size, Math.max(0, Math.trunc(Number(count) || 0)));
  if (!wanted) return [];
  const head = priorityHeadSize(size);
  const tail = size - head;
  const at = (value, span, offset = 0) => offset + ((((Math.trunc(Number(value) || 0) - offset) % span) + span) % span);
  const plan = [];
  const used = new Set();
  const sweep = (start, span, offset, lane, take) => {
    let pointer = at(start, span, offset);
    for (let step = 0; step < take && plan.length < wanted; step++) {
      if (!used.has(pointer)) { used.add(pointer); plan.push({ index: pointer, lane }); }
      pointer = offset + ((pointer - offset + 1) % span);
    }
  };
  // A one-target batch has nothing to split, and a wantlist small enough to be all head needs no
  // second lane; both degrade to a single rotation over everything so nothing is ever starved.
  if (wanted === 1 || tail <= 0) {
    sweep(cursor, size, 0, 'rotation', wanted);
    return plan;
  }
  const priorityCount = Math.min(wanted - 1, Math.max(1, Math.round(wanted * PRIORITY_BATCH_RATIO)));
  sweep(priorityCursor, head, 0, 'priority', priorityCount);
  sweep(cursor, tail, head, 'rotation', wanted - plan.length);
  return plan;
}

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
    location: item.location && item.location.cityName || null,
    categoryId: item.categoryId || null,
    locale: item.locale || null,
    imageId: imageId(item),
    url: safeMarktplaatsUrl(website && website.href || item.websiteUrl || item.url || (itemId ? `https://link.marktplaats.nl/${itemId}` : '')),
    createdAt,
    attributes: item.attributes || item.attributeValues || null,
    sourceType: item.sourceType === 'public_web' ? 'public_web' : 'official_api',
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
  const webClientFactory = options.webClientFactory || createMarktplaatsWebClient;
  const state = createMarktplaatsState(options.stateFile);
  let client = null;
  let clientSignature = '';
  let timer = null;
  let stopped = false;
  let running = false;
  let nextPollAt = null;
  let lastPollAt = state.get().health.lastPollAt || null;
  let lastError = state.get().health.lastError || null;
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
    const hasCredentials = !!creds.clientId && !!creds.clientSecret;
    const mode = hasCredentials ? 'official_api' : 'public_web';
    const signature = JSON.stringify([mode, creds.clientId, creds.clientSecret]);
    if (!client || signature !== clientSignature) {
      client = hasCredentials
        ? clientFactory({ ...creds, onRequest: recordRequest })
        : webClientFactory({ onRequest: recordRequest });
      clientSignature = signature;
    }
    return client;
  }
  function currentMode() {
    const creds = credentials();
    return creds.clientId && creds.clientSecret ? 'official_api' : 'public_web';
  }
  function dailyLimit() { return currentMode() === 'official_api' ? MAX_DAILY_CALLS : MAX_WEB_DAILY_CALLS; }
  async function loadContext(force = false) {
    const config = options.readConfig() || {};
    if (!force && context && now() - contextLoadedAt < 30 * 60 * 1000 && context.username === config.username && context.token === config.token) return context;
    if (!config.username || !config.token) throw new Error('Add your Discogs username and token first; Marktplaats matching uses that wantlist.');
    const [wantlist, medians, rareTargets] = await Promise.all([
      options.loadWantlist(config),
      options.loadMedians(),
      typeof options.loadRareTargets === 'function' ? options.loadRareTargets() : [],
    ]);
    const index = buildWantIndex(wantlist, medians || {});
    const rareIds = new Set((Array.isArray(rareTargets) ? rareTargets : []).map(String));
    // Worth-first ordering is applied once, here, so the persisted cursors, the batch plan and the
    // wantlist the renderer shows all agree on the same sequence.
    index.targets = orderedTargets(index.targets.map((target) => ({
      ...target,
      discogsRare: (target.releaseIds || [target.releaseId]).some((id) => rareIds.has(String(id))),
    })));
    if (!index.targets.length) throw new Error('Your Discogs wantlist is empty.');
    context = { config, username: config.username, token: config.token, index };
    contextLoadedAt = now();
    state.update({ wantlist: index.targets.map((target) => ({ releaseId: target.releaseId, releaseIds: target.releaseIds, artist: target.artist, title: target.title, year: target.year, thumb: target.thumb, median: target.median, discogsRare: target.discogsRare })) });
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
    const cfg = settings(); const snapshot = state.get(); const mode = currentMode();
    return {
      enabled: cfg.enabled,
      configured: true,
      mode,
      degraded: mode === 'public_web',
      running,
      health: running ? 'scanning' : (lastError ? 'error' : (lastPollAt ? 'live' : (cfg.enabled ? 'idle' : 'disabled'))),
      pollMinutes: cfg.pollMinutes,
      lastPollAt,
      nextPollAt: cfg.enabled ? nextPollAt : null,
      callsToday,
      dailyLimit: dailyLimit(),
      targetCount: context && context.index ? context.index.targets.length : snapshot.wantlist.length,
      cursor: snapshot.cursor || 0,
      progress,
      lastRunStats: snapshot.health && snapshot.health.lastRunStats || null,
      error: lastError,
      message: mode === 'public_web'
        ? (lastPollAt ? 'Experimental public web fallback · fixed-price listings only · lower request budget · pressing-matched against your Discogs wantlist.' : 'Public web fallback is ready without partner credentials. It is slower and may stop if Marktplaats changes the page service.')
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
      sourceType: listing.sourceType,
      listingId: listing.itemId,
      targetKey: targetIndexKey(resolved.target),
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
      categoryId: listing.categoryId,
      priceModel: listing.priceModel,
      url: listing.url,
      listingUrl: listing.url,
      provenance: { source: listing.sourceType === 'public_web' ? 'marktplaats-public-web' : 'marktplaats-api-v2', observedAt },
      ts: listing.createdAt && Number.isFinite(Date.parse(listing.createdAt)) ? Date.parse(listing.createdAt) : observedAt,
    };
  }
  async function scanTarget(target, config, runStats) {
    const cfg = settings();
    const result = await ensureClient().search({ query: queryFor(target), categoryId: cfg.categoryId, postcode: cfg.postcode, distance: cfg.distance, limit: 10 });
    const candidates = result.items.map(normalizeMarktplaatsItem).filter((listing) => listing.itemId && listing.itemPrice != null && listing.url && listing.priceModel === 'fixed' && itemAvailable(listing.raw));
    const accepted = [];
    const detailErrorsBefore = runStats.detailErrors;
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
    // Absence from a partial page or failed detail lookup is not evidence of disappearance.
    const complete = Number.isFinite(result.total) && result.total === result.items.length
      && !result.next && !(result.totalPages > 1) && !(result.errors && result.errors.length)
      && runStats.detailErrors === detailErrorsBefore;
    const targetKey = targetIndexKey(target);
    const targetReleaseIds = new Set((target.releaseIds || [target.releaseId]).filter((id) => id != null).map(String));
    const liveListingIds = new Set(accepted.map((record) => String(record.listingId)));
    const liveDealIds = new Set(accepted.filter((record) => record.alertEligible).map((record) => String(record.listingId)));
    const belongsToTarget = (record) => {
      if (!record) return false;
      if (record.targetKey) return record.targetKey === targetKey;
      const releaseIds = record.releaseIds || [record.releaseId];
      return releaseIds.some((id) => id != null && targetReleaseIds.has(String(id)));
    };
    state.update((current) => ({
      matches: current.matches.filter((record) => !belongsToTarget(record) || !complete || liveListingIds.has(String(record.listingId))),
      deals: current.deals.filter((record) => !belongsToTarget(record) || (!complete && !liveListingIds.has(String(record.listingId))) || liveDealIds.has(String(record.listingId))),
      gems: current.gems.map((record) => {
        if (!belongsToTarget(record)) return record;
        const live = liveListingIds.has(String(record.listingId));
        if (!live && !complete) return record;
        return { ...record, gone: !live, current: { lowest: live ? record.lowest : null, numForSale: live ? 1 : 0, ts: now() } };
      }),
    }), { persist: false });
    if (!complete && !accepted.length) {
      runStats.listingsFound += accepted.length;
      return;
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
    const runStats = { checked: 0, targetsSucceeded: 0, prioritySucceeded: 0, targetErrors: 0, listingsFound: 0, dealsFound: 0, gemsFound: 0, titleRejected: 0, versionRejected: 0, currencyRejected: 0, nonFixedRejected: 0, detailErrors: 0, newDeals: [], newGems: [] };
    try {
      refreshDay();
      if (callsToday >= dailyLimit() - 5) throw new Error('The local Marktplaats request safety budget is used up. Scanning resumes tomorrow.');
      ensureClient();
      const ctx = await loadContext(all);
      const targets = ctx.index.targets;
      const current = state.get();
      const count = all ? targets.length : Math.min(settings().batchSize, targets.length);
      // A full scan walks the worth-ordered list from the top, so the daily budget running out
      // costs the cheapest targets. A batch splits between the high-value head and the rotation.
      const plan = all
        ? targets.map((_target, index) => ({ index, lane: 'rotation' }))
        : planTargets({ total: targets.length, cursor: current.cursor, priorityCursor: current.priorityCursor, count });
      const head = priorityHeadSize(targets.length);
      let lastTargetError = null;
      progress = { checked: 0, total: plan.length, all: !!all };
      for (let step = 0; step < plan.length; step++) {
        if (callsToday >= dailyLimit() - 5) break;
        const { index: cursor, lane } = plan[step];
        const target = targets[cursor];
        progress = { ...progress, checked: step, current: `${target.artist || ''} – ${target.title || ''}` };
        publish();
        let targetSucceeded = false;
        try { await scanTarget(target, ctx.config, runStats); targetSucceeded = true; runStats.targetsSucceeded += 1; }
        catch (error) {
          if (error && (error.status === 401 || error.status === 403 || error.status === 429)) throw error;
          runStats.targetErrors += 1;
          lastTargetError = error;
        }
        runStats.checked += 1;
        if (targetSucceeded && lane === 'priority') runStats.prioritySucceeded += 1;
        progress = { ...progress, checked: step + 1 };
        const health = { ...state.get().health, callDay, callsToday, lastPollAt, lastError, lastRunStats: { ...runStats, newDeals: undefined, newGems: undefined } };
        if (targetSucceeded) {
          // Each lane owns its own cursor so the head keeps rotating independently of the sweep,
          // and the rotation wraps back to the start of the tail rather than to the head.
          const singleRotation = all || count === 1 || head >= targets.length;
          const patch = singleRotation
            ? { cursor: (cursor + 1) % targets.length }
            : lane === 'priority' && head > 0
            ? { priorityCursor: (cursor + 1) % head }
            : { cursor: cursor + 1 >= targets.length ? Math.min(head, Math.max(0, targets.length - 1)) : cursor + 1 };
          state.update({ ...patch, health });
        } else state.update({ health });
      }
      if (plan.length > 0 && runStats.targetsSucceeded === 0) throw lastTargetError || new Error('Every Marktplaats target search failed.');
      lastPollAt = now(); progress = null;
      if (runStats.targetErrors > 0) lastError = `${runStats.targetErrors} of ${runStats.checked} Marktplaats target searches failed; results are incomplete.`;
      state.update({ health: { ...state.get().health, callDay, callsToday, lastPollAt, lastError, lastRunStats: { ...runStats, newDeals: undefined, newGems: undefined } } });
      return publish({ newDeals: runStats.newDeals, newGems: runStats.newGems, runStats: { ...runStats, newDeals: undefined, newGems: undefined } });
    } catch (error) {
      lastError = error && error.message ? error.message : String(error); progress = null;
      state.update({ health: { ...state.get().health, callDay, callsToday, lastPollAt, lastError, lastRunStats: { ...runStats, newDeals: undefined, newGems: undefined } } });
      publish(); throw error;
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
  function resetClient() { client = null; clientSignature = ''; lastError = null; state.update({ health: { ...state.get().health, lastError: null } }); return snapshot(); }
  return { start, stop, snapshot, runOnce, setEnabled, configure, resetClient };
}

module.exports = {
  createMarktplaatsService, normalizeMarktplaatsItem, safeMarktplaatsUrl, fixedPrice, itemAvailable, queryFor,
  orderedTargets, priorityHeadSize, planTargets,
  MAX_DAILY_CALLS, MAX_WEB_DAILY_CALLS, PRIORITY_HEAD_RATIO, PRIORITY_BATCH_RATIO, MIN_PRIORITY_HEAD,
};

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
  let searchItems = [summary];
  let searchError = null;
  let searchTotal = null;
  let credentials = { clientId: 'client', clientSecret: 'secret' };
  const service = createMarktplaatsService({
    stateFile: path.join(dir, 'state.json'), readSettings: () => settings, writeSettings: (patch) => { settings = { ...settings, ...patch }; },
    readConfig: () => config,
    loadWantlist: async () => [{ id: 1, artist: 'Macho', title: 'I’m A Man', year: 1978 }],
    loadMedians: async () => ({ 1: { median: 80 } }),
    loadReleaseMetadata: async () => ({ year: 1978, title: 'I’m A Man', artist: 'Macho', formats: [{ name: 'Vinyl', descriptions: ['12"', 'Original'] }], labels: [{ name: 'Goody Music', catno: 'GO 123' }] }),
    getCredentials: () => credentials,
    clientFactory: () => ({
      mode: 'official_api',
      search: async () => { if (searchError) throw searchError; return { total: searchTotal ?? searchItems.length, items: searchItems }; },
      getAdvertisement: async () => ({ ...summary, attributes: { catalogNumber: 'GO 123', format: '12 inch' } }),
    }),
    webClientFactory: () => ({
      mode: 'public_web',
      search: async () => { if (searchError) throw searchError; return { total: searchTotal ?? searchItems.length, items: searchItems.map((item) => ({ ...item, sourceType: 'public_web' })) }; },
      getAdvertisement: async () => ({ ...summary, sourceType: 'public_web', attributes: { catalogNumber: 'GO 123', format: '12 inch' } }),
    }),
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
    // All returned rows may be unrelated while the old match is still on a later page.
    searchItems = Array.from({ length: 10 }, () => ({}));
    searchTotal = 11;
    const partial = await service.runOnce({ all: true });
    assert.strictEqual(partial.matches.length, 1, 'partial pages preserve earlier matches');
    assert.strictEqual(partial.deals.length, 1, 'partial pages preserve earlier deals');
    searchItems = [summary];
    searchTotal = null;
    const visibleAgain = await service.runOnce({ all: true });
    assert.strictEqual(visibleAgain.newGems.length, 0, 'pagination never creates a false restock');
    searchItems = [];
    const disappeared = await service.runOnce({ all: true });
    assert.strictEqual(disappeared.deals.length, 0, 'a disappeared Marktplaats listing is removed from live deals immediately');
    assert.strictEqual(disappeared.matches.length, 0, 'a disappeared Marktplaats listing is removed from dashboard matches immediately');
    searchItems = [summary];
    const relisted = await service.runOnce({ all: true });
    assert.strictEqual(relisted.newGems.length, 1, 'zero-to-available still creates a rare-gem event');
    searchItems = [];
    const goneAgain = await service.runOnce({ all: true });
    assert.strictEqual(goneAgain.gems.gems[0].gone, true, 'historical marketplace gems are retained but marked gone');
    const lastSuccessfulPollAt = service.snapshot().status.lastPollAt;
    searchError = Object.assign(new Error('Marktplaats upstream unavailable'), { status: 500 });
    await assert.rejects(() => service.runOnce({ all: true }), /upstream unavailable/);
    const failed = service.snapshot();
    assert.strictEqual(failed.status.health, 'error', 'a fully failed Marktplaats batch is not reported as live');
    assert.strictEqual(failed.status.lastPollAt, lastSuccessfulPollAt, 'a failed Marktplaats batch does not advance last successful poll time');
    credentials = {};
    searchError = null;
    searchItems = [summary];
    service.resetClient();
    const fallbackStatus = service.snapshot().status;
    assert.strictEqual(fallbackStatus.configured, true, 'public fallback is usable without partner credentials');
    assert.strictEqual(fallbackStatus.mode, 'public_web');
    assert.strictEqual(fallbackStatus.dailyLimit, MAX_WEB_DAILY_CALLS);
    const fallback = await service.runOnce({ all: true });
    assert.strictEqual(fallback.matches[0].sourceType, 'public_web');
    assert.strictEqual(fallback.matches[0].provenance.source, 'marktplaats-public-web');
    assert.ok(safeMarktplaatsUrl('http://link.marktplaats.nl/m123').startsWith('https://link.marktplaats.nl/'));
    assert.strictEqual(safeMarktplaatsUrl('https://marktplaats.nl.evil.example/m123'), null);
    assert.strictEqual(fixedPrice({ priceModel: { modelType: 'bid', askingPrice: 1000 } }), null);
    // Worth-first ordering plus the reserved priority lane: the small public-fallback budget must
    // reach the expensive records every day instead of crawling the list in wantlist order.
    const worthTargets = orderedTargets([
      { releaseId: 1, artist: 'C', title: 'cheap', median: 5 },
      { releaseId: 2, artist: 'B', title: 'pricey', median: 400 },
      { releaseId: 3, artist: 'A', title: 'gone', median: 20, discogsRare: true },
      { releaseId: 4, artist: 'D', title: 'unknown' },
    ]);
    assert.deepStrictEqual(worthTargets.map((target) => target.releaseId), [3, 2, 1, 4], 'out-of-print targets lead, then the highest sold medians, then unpriced titles');

    const total = 817;
    const head = priorityHeadSize(total);
    assert.strictEqual(head, Math.ceil(total * PRIORITY_HEAD_RATIO));
    assert.strictEqual(priorityHeadSize(10), 10, 'a wantlist smaller than the minimum head is entirely priority');
    assert.strictEqual(priorityHeadSize(0), 0);

    const batch = planTargets({ total, cursor: 600, priorityCursor: 0, count: 5 });
    assert.strictEqual(batch.length, 5);
    assert.deepStrictEqual(batch.filter((entry) => entry.lane === 'priority').map((entry) => entry.index), [0, 1], 'every batch reserves part of itself for the high-value head');
    assert.deepStrictEqual(batch.filter((entry) => entry.lane === 'rotation').map((entry) => entry.index), [600, 601, 602], 'the rest keeps sweeping the tail so cheap targets are not starved');
    assert.strictEqual(new Set(batch.map((entry) => entry.index)).size, batch.length, 'a batch never scans the same target twice');
    assert.ok(planTargets({ total, cursor: 0, priorityCursor: 0, count: 5 })
      .filter((entry) => entry.lane === 'rotation').every((entry) => entry.index >= head), 'a rotation cursor left inside the head is normalised into the tail');
    assert.deepStrictEqual(planTargets({ total, cursor: total - 1, priorityCursor: 0, count: 3 })
      .filter((entry) => entry.lane === 'rotation').map((entry) => entry.index), [total - 1, head], 'the rotation wraps to the start of the tail, never back into the head');
    assert.deepStrictEqual(planTargets({ total, cursor: 600, priorityCursor: 0, count: 1 }), [{ index: 600, lane: 'rotation' }], 'a one-target batch has nothing to split');

    let priorityCursor = 0;
    const seenPriority = new Set();
    for (let run = 0; run < head; run++) {
      const planned = planTargets({ total, cursor: 0, priorityCursor, count: 5 });
      for (const entry of planned.filter((item) => item.lane === 'priority')) {
        seenPriority.add(entry.index);
        priorityCursor = (entry.index + 1) % head;
      }
    }
    assert.strictEqual(seenPriority.size, head, 'the priority cursor covers the whole high-value head well inside a day of batches');

    const small = planTargets({ total: 6, cursor: 5, priorityCursor: 0, count: 4 });
    assert.strictEqual(small.length, 4);
    assert.ok(small.every((entry) => entry.lane === 'rotation'), 'a wantlist smaller than the minimum head is one single lane');
    assert.strictEqual(new Set(small.map((entry) => entry.index)).size, 4, 'a batch never repeats a target');
    assert.deepStrictEqual(planTargets({ total: 3, cursor: 0, priorityCursor: 0, count: 9 }).map((entry) => entry.index).sort(), [0, 1, 2], 'a batch larger than the wantlist stops at one pass');
    assert.deepStrictEqual(planTargets({ total: 0, cursor: 0, priorityCursor: 0, count: 5 }), []);
    assert.deepStrictEqual(planTargets({ total: 10, cursor: 0, priorityCursor: 0, count: 0 }), []);
    assert.ok(planTargets({ total: 10, cursor: 0, priorityCursor: 0, count: 3 }).every((entry) => entry.lane === 'rotation'), 'an all-priority wantlist needs no separate lane');
    // Full coverage: neither lane may strand a target, whatever the cursors start at.
    let coverCursor = 7; let coverPriority = 3; const covered = new Set();
    for (let run = 0; run < 400; run++) {
      for (const entry of planTargets({ total, cursor: coverCursor, priorityCursor: coverPriority, count: 5 })) {
        covered.add(entry.index);
        if (entry.lane === 'priority') coverPriority = (entry.index + 1) % head;
        else coverCursor = entry.index + 1 >= total ? head : entry.index + 1;
      }
    }
    assert.strictEqual(covered.size, total, 'every target is eventually reached by one of the two lanes');

    // End to end: a scheduled batch must actually walk both lanes and advance both cursors.
    const batchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deal-shark-marktplaats-batch-'));
    const batchSize = 5;
    const batchWants = Array.from({ length: 200 }, (_unused, index) => ({
      id: 100 + index, artist: `Artist${index + 1}`, title: `Title${index + 1}`, year: 1980,
    }));
    // Deliberately cheapest-first, so a run that respects wantlist order would never reach the top.
    const batchMedians = Object.fromEntries(batchWants.map((want, index) => [want.id, { median: index + 1 }]));
    const searched = [];
    const batchService = createMarktplaatsService({
      stateFile: path.join(batchDir, 'state.json'),
      readSettings: () => ({ marktplaatsEnabled: false, marktplaatsPollMinutes: 30, marktplaatsBatchSize: batchSize }),
      writeSettings: () => {},
      readConfig: () => ({ username: 'tester', token: 'discogs', currency: 'EUR', minDiscount: 0.5, minReference: 100, shippingEstimate: 5 }),
      loadWantlist: async () => batchWants,
      loadMedians: async () => batchMedians,
      loadRareTargets: async () => ['150'],
      loadReleaseMetadata: async () => ({ formats: [{ name: 'Vinyl', descriptions: ['12"'] }], labels: [] }),
      getCredentials: () => ({}),
      webClientFactory: () => ({
        mode: 'public_web',
        search: async (input) => { searched.push(String(input.query)); return { total: 0, items: [] }; },
        getAdvertisement: async () => ({}),
      }),
    });
    const firstBatch = await batchService.runOnce();
    assert.strictEqual(searched.length, batchSize, 'a scheduled run stays inside the configured batch size');
    assert.ok(searched[0].includes('Artist51'), 'the out-of-print target leads the worth-ordered list and is hunted first');
    assert.ok(searched[1].includes('Artist200'), 'the priority lane then takes the highest sold medians, not the wantlist order');
    assert.strictEqual(firstBatch.status.lastRunStats.prioritySucceeded, 2);
    assert.ok(searched.slice(2).every((query) => !query.includes('Artist200')), 'the rotation lane starts past the priority head instead of duplicating it');
    const afterFirst = JSON.parse(fs.readFileSync(path.join(batchDir, 'state.json'), 'utf8'));
    assert.ok(afterFirst.priorityCursor > 0 && afterFirst.cursor > 0, 'both lanes persist their own resume point');
    await batchService.runOnce();
    assert.strictEqual(searched.length, batchSize * 2);
    assert.strictEqual(new Set(searched).size, batchSize * 2, 'consecutive batches never re-search the same target');
    batchService.stop();

    // Exercise persisted cursors through two complete single-target rotations, including
    // both an all-head list and a list with a separate priority head and tail.
    for (const size of [3, 30]) {
      const rotationQueries = [];
      const rotationService = createMarktplaatsService({
        stateFile: path.join(batchDir, 'rotation-' + size + '.json'),
        readSettings: () => ({ marktplaatsEnabled: false, marktplaatsBatchSize: 1 }),
        writeSettings: () => {},
        readConfig: () => ({ username: 'tester', token: 'dummy' }),
        loadWantlist: async () => Array.from({ length: size }, (_, id) => ({ id: id + 1, artist: 'Artist' + id, title: 'Title' + id })),
        loadMedians: async () => ({}),
        loadReleaseMetadata: async () => ({}),
        getCredentials: () => ({}),
        webClientFactory: () => ({ mode: 'public_web',
          search: async ({ query }) => { rotationQueries.push(query); return { total: 0, items: [] }; },
          getAdvertisement: async () => ({}),
        }),
      });
      for (let run = 0; run < size * 2; run++) await rotationService.runOnce();
      assert.strictEqual(new Set(rotationQueries.slice(0, size)).size, size);
      assert.deepStrictEqual(rotationQueries.slice(size), rotationQueries.slice(0, size), 'single-target batches repeat the whole wantlist after wrapping');
      rotationService.stop();
    }
    console.log('marktplaats service selftest: OK');
  })().catch((error) => { console.error(error); process.exitCode = 1; });
}

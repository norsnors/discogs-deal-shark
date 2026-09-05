'use strict';

const { createVintedClient } = require('./client');
const {
  buildWantIndex,
  matchCatalogItem,
  normalizeCatalogItem,
  evaluateListing,
  vintedConditionProfile,
  conditionSuggestionReference,
  estimateDiscogsResale,
  DEFAULT_GOOD_PRICE_DISCOUNT,
  targetIndexKey,
  resolvePressingMatch,
} = require('./policy');
const { createVintedState } = require('./state');

const CONTEXT_TTL_MS = 60 * 60 * 1000;
const MAX_CATCHUP_PAGES = 5;
const LIVE_DEAL_TTL_MS = 48 * 60 * 60 * 1000;
const BACKFILL_BATCH_SIZE = 5;
const BACKFILL_ROUND_DELAY_MS = 15 * 1000;

function clamp(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

function asTimestamp(value, fallback = Date.now()) {
  if (value == null || value === '') return fallback;
  const number = Number(value);
  if (Number.isFinite(number)) return number > 0 && number < 1e12 ? number * 1000 : number;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function queryUrl(target) {
  const search = encodeURIComponent(`${target.artist || ''} ${target.title || ''}`.trim());
  return `https://www.vinted.nl/catalog?search_text=${search}&catalog_ids=3041`;
}

function createVintedService(options = {}) {
  if (!options.stateFile) throw new Error('Vinted service needs a state file.');
  if (typeof options.readSettings !== 'function' || typeof options.writeSettings !== 'function') throw new Error('Vinted service needs settings adapters.');
  if (typeof options.readConfig !== 'function' || typeof options.loadWantlist !== 'function') throw new Error('Vinted service needs Discogs wantlist adapters.');
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const setTimer = options.setTimer || setTimeout;
  const clearTimer = options.clearTimer || clearTimeout;
  const emit = typeof options.emit === 'function' ? options.emit : () => {};
  const state = createVintedState(options.stateFile);
  const clientFactory = options.clientFactory || createVintedClient;
  let client = null;
  let timer = null;
  let stopped = false;
  let running = false;
  let nextPollAt = null;
  let context = null;
  let contextLoadedAt = 0;
  let lastPollAt = state.get().health && state.get().health.lastPollAt || null;
  let lastDeepHuntAt = state.get().health && state.get().health.lastDeepHuntAt || null;
  let lastError = null;
  let lastClientCount = 0;
  let requestTimes = [];
  let lastRunStats = state.get().health && state.get().health.lastRunStats || null;
  const releaseMetadataCache = new Map();
  const itemDetailCache = new Map();

  function backfillStatus(snapshot = state.get()) {
    const value = snapshot && snapshot.health && snapshot.health.backfill;
    return {
      active: !!(value && value.active),
      cursor: Math.max(0, Number(value && value.cursor) || 0),
      checked: Math.max(0, Number(value && value.checked) || 0),
      total: Math.max(0, Number(value && value.total) || 0),
      listingsFound: Math.max(0, Number(value && value.listingsFound) || 0),
      dealsFound: Math.max(0, Number(value && value.dealsFound) || 0),
      gemsFound: Math.max(0, Number(value && value.gemsFound) || 0),
      completedKeys: Array.from(new Set(Array.isArray(value && value.completedKeys) ? value.completedKeys.map(String).filter(Boolean) : [])).slice(0, 10000),
      startedAt: value && value.startedAt || null,
      completedAt: value && value.completedAt || null,
      cancelledAt: value && value.cancelledAt || null,
      lastTarget: value && value.lastTarget || null,
    };
  }

  function hasScheduledWork() {
    return settings().enabled || backfillStatus().active;
  }

  function settings() {
    const source = options.readSettings() || {};
    return {
      enabled: source.vintedEnabled === true,
      pollSeconds: clamp(source.vintedPollSeconds, 10, 300, 15),
      deepHuntSeconds: clamp(source.vintedDeepHuntSeconds, 30, 3600, 60),
    };
  }

  function recordClientStatus(status) {
    if (!status || typeof status !== 'object') return;
    const count = Number(status.requestCount) || 0;
    if (count > lastClientCount) {
      const ts = Number(status.lastRequestAt) || now();
      for (let i = lastClientCount; i < count; i++) requestTimes.push(ts);
      lastClientCount = count;
    }
    requestTimes = requestTimes.filter((ts) => ts > now() - 60 * 60 * 1000);
  }

  function ensureClient() {
    if (!client) {
      client = clientFactory({
        minGapMs: 1000,
        onStatus: recordClientStatus,
      });
    }
    return client;
  }

  function zeroWatch(snapshot) {
    return Object.entries(snapshot.availability || {})
      .filter(([, record]) => record && record.status === 'zero')
      .map(([key, record]) => ({
        releaseId: record.releaseId ?? key,
        artist: record.artist || '',
        title: record.title || '',
        year: record.year || null,
        thumb: record.thumb || null,
        checkedAt: record.checkedAt || null,
        url: record.url || queryUrl(record),
      }))
      .sort((a, b) => (b.checkedAt || 0) - (a.checkedAt || 0));
  }

  function publicStatus() {
    const cfg = settings();
    const backfill = backfillStatus();
    const { completedKeys: _completedKeys, ...publicBackfill } = backfill;
    const clientStatus = client && typeof client.status === 'function' ? client.status() : null;
    recordClientStatus(clientStatus);
    let health = cfg.enabled ? 'idle' : 'disabled';
    if (running) health = 'scanning';
    else if (clientStatus && (clientStatus.state === 'challenged' || clientStatus.state === 'cooldown')) health = 'backoff';
    else if (lastError) health = 'error';
    else if (backfill.active) health = 'backfill';
    else if (lastPollAt) health = 'live';
    const targetCount = context && context.index ? context.index.targets.length : (state.get().wantlist || []).length;
    const referenceCount = context && context.index ? context.index.targets.filter((target) => target.median > 0).length : null;
    const coverage = referenceCount == null ? '' : ` · ${referenceCount} with a Discogs sold median`;
    const rejected = lastRunStats && Number(lastRunStats.versionRejected) > 0
      ? ` · ${lastRunStats.versionRejected} unverified version${lastRunStats.versionRejected === 1 ? '' : 's'} ignored`
      : '';
    return {
      enabled: cfg.enabled,
      running,
      health,
      pollSeconds: cfg.pollSeconds,
      deepHuntSeconds: cfg.deepHuntSeconds,
      lastPollAt,
      lastDeepHuntAt,
      nextPollAt: (cfg.enabled || backfill.active) ? nextPollAt : null,
      requestsLastHour: requestTimes.length,
      blockedUntil: clientStatus && clientStatus.blockedUntil || null,
      targetCount,
      referenceCount,
      lastRunStats,
      backfill: publicBackfill,
      message: health === 'backoff'
        ? 'Vinted asked us to slow down. Requests are paused automatically.'
        : (backfill.active
            ? `Existing-offer backfill · ${backfill.checked}/${backfill.total || targetCount || '?'} titles checked · ${backfill.listingsFound} compatible listings found.`
        : (!cfg.enabled && lastPollAt
            ? `Manual scan complete · ${targetCount || 0} pressing-aware wantlist targets${coverage}${rejected} · background sniper is off.`
            : (lastPollAt ? `Newest feed active · ${targetCount || 0} pressing-aware wantlist targets${coverage}${rejected}.` : null))),
      error: lastError,
    };
  }

  function snapshot(extra = {}) {
    const current = state.get();
    const liveCutoff = now() - LIVE_DEAL_TTL_MS;
    return {
      status: publicStatus(),
      // Vinted has no supported live-listing API. A deal not observed again for 48 hours is no
      // longer presented as live; targeted hunts can refresh observedAt without re-alerting it.
      deals: (current.deals || []).filter((record) => asTimestamp(record.observedAt ?? record.ts, 0) >= liveCutoff),
      gems: { ts: current.updatedAt || null, gems: current.gems || [], zeroWatch: zeroWatch(current) },
      ...extra,
    };
  }

  function publish(extra) {
    const value = snapshot(extra);
    try { emit(value); } catch { /* the scheduler must survive a closed renderer */ }
    return value;
  }

  async function loadContext(force = false) {
    const config = options.readConfig() || {};
    if (!force && context && now() - contextLoadedAt < CONTEXT_TTL_MS
      && context.config.username === config.username && context.config.token === config.token) return context;
    if (!config.username || !config.token) throw new Error('Add your Discogs username and token first; Vinted matching uses that wantlist.');
    const wantlist = await options.loadWantlist(config);
    const medians = typeof options.loadMedians === 'function' ? (await options.loadMedians()) : {};
    const index = buildWantIndex(wantlist, medians || {});
    const rareIds = new Set((typeof options.loadRareTargets === 'function' ? (await options.loadRareTargets()) : []).map(String));
    index.targets = index.targets.map((target) => ({
      ...target,
      discogsRare: (target.releaseIds || [target.releaseId]).some((id) => rareIds.has(String(id))),
    }));
    if (!index.targets.length) throw new Error('Your Discogs wantlist is empty.');
    context = { config, wantlist, index };
    contextLoadedAt = now();
    const publicWantlist = index.targets.map((target) => ({
      key: targetIndexKey(target), releaseId: target.releaseId, releaseIds: target.releaseIds,
      artist: target.artist, title: target.title, year: target.year, thumb: target.thumb, median: target.median, discogsRare: target.discogsRare,
    }));
    state.update({ wantlist: publicWantlist }, { persist: true });
    return context;
  }

  function listingRecord(item, match, evaluation, ts = now(), freshListing = true) {
    const listing = normalizeCatalogItem(item);
    const target = match.target;
    const subtotal = listing.totalItemPrice != null
      ? listing.totalItemPrice
      : (listing.price == null ? null : listing.price + (listing.serviceFee || 0));
    return {
      id: `vinted:${listing.itemId}`,
      platform: 'vinted',
      listingId: listing.itemId,
      releaseId: target.releaseId,
      releaseIds: target.releaseIds || [target.releaseId],
      artist: target.artist,
      title: target.title,
      year: target.year,
      thumb: listing.photoUrl || target.thumb || null,
      listingTitle: listing.rawTitle,
      itemCondition: listing.status == null ? null : String(listing.status),
      itemPrice: listing.price,
      serviceFee: listing.serviceFee || 0,
      lowest: subtotal,
      currency: listing.currency || 'EUR',
      shipping: null,
      shippingEstimate: evaluation.shippingEstimate,
      reference: evaluation.reference,
      referenceSource: evaluation.referenceSource,
      referenceGrade: evaluation.referenceGrade || null,
      discount: evaluation.discount,
      dealTier: evaluation.dealTier || 'shark',
      conditionProxyGrade: evaluation.conditionProxyGrade || null,
      conditionProxySource: evaluation.conditionProxySource || null,
      resaleFeeRate: evaluation.resaleFeeRate ?? null,
      resaleNet: evaluation.resaleNet ?? null,
      resaleMargin: evaluation.resaleMargin ?? null,
      resaleRoi: evaluation.resaleRoi ?? null,
      numForSale: 1,
      matchScore: match.score,
      pressingVerified: true,
      pressingEvidence: evaluation.target && evaluation.target.pressingEvidence || [],
      conditionConfirmed: false,
      freshListing: !!freshListing,
      observedAt: ts,
      url: listing.url,
      listingUrl: listing.url,
      ts: asTimestamp(listing.createdAt, ts),
    };
  }

  function gemRecord(item, match, evaluation, ts = now(), freshListing = true) {
    return {
      ...listingRecord(item, match, evaluation, ts, freshListing),
      id: `vinted-gem:${normalizeCatalogItem(item).itemId}:${targetIndexKey(match.target)}`,
      rareReason: 'targeted-zero-to-available',
    };
  }

  function targetMetadata(target, itemIds = []) {
    return {
      releaseId: target.releaseId,
      releaseIds: target.releaseIds || [target.releaseId],
      artist: target.artist,
      title: target.title,
      year: target.year,
      thumb: target.thumb,
      median: target.median,
      url: queryUrl(target),
      itemIds,
    };
  }

  async function pressingMetadata(target, ctx) {
    const output = {};
    const pressings = Array.isArray(target.pressings) && target.pressings.length ? target.pressings : [target];
    for (const pressing of pressings) {
      const key = String(pressing.releaseId);
      if (!releaseMetadataCache.has(key)) {
        let metadata = null;
        try {
          metadata = typeof options.loadReleaseMetadata === 'function'
            ? await options.loadReleaseMetadata(pressing.releaseId, ctx.config)
            : null;
        } catch { metadata = null; }
        // A transient Discogs failure must not make this pressing unverifiable for the rest of the
        // desktop session. Cache only positive metadata; a later poll may safely retry.
        if (metadata) releaseMetadataCache.set(key, metadata);
      }
      if (releaseMetadataCache.get(key)) output[key] = releaseMetadataCache.get(key);
    }
    return output;
  }

  async function itemDetails(listing) {
    const key = String(listing.itemId);
    const cached = itemDetailCache.get(key);
    if (cached && now() - cached.ts < 24 * 60 * 60 * 1000) return cached.value;
    let value = {};
    try { value = listing.url ? await ensureClient().itemPage(listing.url) : {}; }
    catch (error) {
      if (error && (error.code === 'CHALLENGE' || error.code === 'RATE_LIMITED' || error.code === 'COOLDOWN')) throw error;
      // A transient HTTP/network failure is not evidence about the pressing. Do not turn it into
      // a 24-hour negative cache; a later poll should be allowed to try again.
      return {};
    }
    itemDetailCache.set(key, { ts: now(), value });
    return value;
  }

  async function resolveVersion(listing, match, ctx) {
    const metadata = await pressingMetadata(match.target, ctx);
    let decision = resolvePressingMatch(listing, match, {}, metadata);
    // Explicit contradictions are already decisive and do not justify an item-page fetch. A title
    // that looks valid is not final, however: sellers often put 7-inch/12-inch only in the item
    // description. Re-read every initially accepted candidate with those details before alerting.
    if (['reissue-conflict', 'color-conflict', 'original-conflict', 'format-size-conflict', 'compilation-conflict'].includes(decision.reason)) return { ...decision, details: null };
    if (decision.reason === 'metadata-unavailable') return { ...decision, details: null };
    const details = await itemDetails(listing);
    decision = resolvePressingMatch(listing, match, details, metadata);
    return { ...decision, details };
  }

  async function processItems(items, ctx, scanOptions = {}) {
    const cfg = ctx.config || {};
    const minDiscount = Number.isFinite(Number(cfg.minDiscount)) ? Number(cfg.minDiscount) : 0.5;
    const goodPriceDiscount = Number.isFinite(Number(cfg.vintedGoodPriceDiscount)) ? Number(cfg.vintedGoodPriceDiscount) : DEFAULT_GOOD_PRICE_DISCOUNT;
    const shippingEstimate = Number.isFinite(Number(cfg.shippingEstimate)) ? Number(cfg.shippingEstimate) : 5;
    const minReference = Number.isFinite(Number(cfg.minReference)) ? Number(cfg.minReference) : 0;
    const newDeals = [];
    const newGems = [];
    const ids = [];
    const compatible = [];
    const batchSeen = new Set();
    let titleMatches = 0;
    let versionRejected = 0;
    let reissueRejected = 0;
    for (const raw of Array.isArray(items) ? items : []) {
      const listing = normalizeCatalogItem(raw);
      if (!listing.itemId) continue;
      const match = matchCatalogItem(listing, ctx.index);
      if (!match) continue;
      titleMatches += 1;
      const pressing = await resolveVersion(listing, match, ctx);
      if (!pressing.accepted) {
        versionRejected += 1;
        if (['reissue-conflict', 'color-conflict', 'original-conflict', 'format-size-conflict', 'format-size-unverified', 'compilation-conflict', 'release-title-not-primary'].includes(pressing.reason)) {
          reissueRejected += 1;
          // If a seller edits a formerly valid item into an explicit incompatible version, do not
          // leave the old pressing card behind as if it were still buyable.
          state.removeListing(listing.itemId, { persist: false });
        }
        continue;
      }
      const resolvedMatch = { ...match, target: pressing.target, pressing };
      const subtotal = listing.totalItemPrice != null ? listing.totalItemPrice : (listing.price == null ? 'na' : listing.price + (listing.serviceFee || 0));
      const seenKey = `${listing.itemId}:${resolvedMatch.target.releaseId}:${subtotal}`;
      if (batchSeen.has(seenKey)) continue;
      batchSeen.add(seenKey);
      ids.push(seenKey);
      const unseen = !state.hasSeen(seenKey);
      const condition = vintedConditionProfile(listing, pressing.details || {});
      const strictEvaluation = evaluateListing(listing, resolvedMatch, { minDiscount, shippingEstimate, reference: pressing.reference });
      let evaluation = {
        ...strictEvaluation,
        dealTier: strictEvaluation.isDeal ? 'shark' : null,
        conditionProxyGrade: condition && condition.grade,
        conditionProxySource: condition && condition.source,
      };
      // A Vinted "Heel goed" copy is closest to Discogs VG+, but is not confirmed play-grading.
      // The old 50%-under-sold-median rule remains the Shark tier. This second tier catches a
      // genuinely good cross-market price against Discogs's matching condition value, while exact
      // pressing evidence, buyer protection and estimated shipping all remain mandatory inputs.
      if (!strictEvaluation.isDeal && condition && condition.eligible && typeof options.loadPriceSuggestion === 'function') {
        let suggestion = null;
        try { suggestion = await options.loadPriceSuggestion(resolvedMatch.target.releaseId, ctx.config); }
        catch { suggestion = null; }
        const conditionReference = conditionSuggestionReference(suggestion, condition);
        if (conditionReference > 0) {
          const goodPriceEvaluation = evaluateListing(listing, resolvedMatch, {
            minDiscount: goodPriceDiscount,
            shippingEstimate,
            reference: conditionReference,
            referenceSource: 'condition-suggestion',
          });
          evaluation = {
            ...goodPriceEvaluation,
            dealTier: goodPriceEvaluation.isDeal ? 'good-price' : null,
            referenceGrade: condition.grade,
            conditionProxyGrade: condition.grade,
            conditionProxySource: condition.source,
          };
          if (goodPriceEvaluation.isDeal) {
            const resale = estimateDiscogsResale(conditionReference, goodPriceEvaluation.total);
            if (resale) evaluation = {
              ...evaluation,
              resaleFeeRate: resale.feeRate,
              resaleNet: resale.net,
              resaleMargin: resale.margin,
              resaleRoi: resale.roi,
            };
          }
        }
      }
      compatible.push({ raw, listing, match: resolvedMatch, evaluation, pressing });
      const qualifies = evaluation.isDeal && (evaluation.reference || 0) >= minReference;
      if (qualifies) {
        const deal = listingRecord(listing, resolvedMatch, evaluation, now(), scanOptions.freshListing !== false);
        state.addDeal(deal, { persist: false });
        if (unseen) newDeals.push(deal);
      } else state.removeDeal(listing.itemId, { persist: false });
      // A broad newest-feed match may complete a zero -> available transition first observed by
      // Deep Hunt. Absence from the broad feed alone is never treated as zero.
      const key = targetIndexKey(resolvedMatch.target);
      const previous = state.get().availability[key];
      if (scanOptions.transitionAvailability !== false && previous && previous.status === 'zero') {
        const observation = state.observeAvailability(key, true, targetMetadata(resolvedMatch.target, [listing.itemId]), { persist: false });
        if (observation.transition.isRareGem) {
          const gem = gemRecord(listing, resolvedMatch, evaluation, now(), scanOptions.freshListing !== false);
          state.addGem(gem, { persist: false });
          newGems.push(gem);
        }
      }
    }
    state.markSeenBatch(ids, { persist: false });
    state.save(state.get());
    return { newDeals, newGems, inspected: ids.length, titleMatches, versionRejected, reissueRejected, compatible };
  }

  async function broadPoll(ctx) {
    const before = state.get();
    const watermark = before.watermark && before.watermark.id;
    const first = await ensureClient().catalog({ page: 1, perPage: 96, order: 'newest_first' });
    const pages = [first];
    let foundWatermark = !watermark;
    if (watermark && !first.items.some((item) => String(normalizeCatalogItem(item).itemId) === String(watermark))) {
      for (let page = 2; page <= MAX_CATCHUP_PAGES; page++) {
        const result = await ensureClient().catalog({ page, perPage: 96, order: 'newest_first' });
        pages.push(result);
        if (result.items.some((item) => String(normalizeCatalogItem(item).itemId) === String(watermark))) { foundWatermark = true; break; }
        if (result.items.length < 96) break;
      }
    } else if (watermark) foundWatermark = true;
    const candidates = [];
    outer: for (const page of pages) for (const item of page.items) {
      if (watermark && String(normalizeCatalogItem(item).itemId) === String(watermark)) break outer;
      candidates.push(item);
    }
    // First run intentionally evaluates the visible page so the dashboard is immediately useful.
    const processed = await processItems(candidates, ctx, { freshListing: true });
    const top = first.items.length ? normalizeCatalogItem(first.items[0]).itemId : null;
    if (top) state.setWatermark(top, now());
    return { ...processed, pages: pages.length, foundWatermark, feedItems: pages.reduce((sum, page) => sum + page.items.length, 0) };
  }

  function orderedTargets(ctx) {
    return ctx.index.targets.slice().sort((a, b) => Number(!!b.discogsRare) - Number(!!a.discogsRare)
      || (b.median || 0) - (a.median || 0)
      || targetIndexKey(a).localeCompare(targetIndexKey(b)));
  }

  async function huntTarget(ctx, target) {
    const result = await ensureClient().catalog({ searchText: `${target.artist} ${target.title}`, page: 1, perPage: 96, order: 'newest_first' });
    const matches = result.items
      .map((item) => ({ item, match: matchCatalogItem(item, [target]) }))
      .filter((entry) => entry.match);
    const processed = await processItems(matches.map((entry) => entry.item), ctx, { freshListing: false, transitionAvailability: false });
    const compatible = processed.compatible;
    const observation = state.observeAvailability(targetIndexKey(target), compatible.length > 0, targetMetadata(compatible[0] ? compatible[0].match.target : target, compatible.map((entry) => entry.listing.itemId)), { persist: false });
    if (observation.transition.isRareGem && compatible.length) {
      const first = compatible[0];
      const gem = gemRecord(first.listing, first.match, first.evaluation, now(), false);
      state.addGem(gem, { persist: false });
      if (!processed.newGems.some((item) => item.id === gem.id)) processed.newGems.push(gem);
    }
    lastDeepHuntAt = now();
    return { ...processed, target: targetIndexKey(target), found: compatible.length, titleMatches: matches.length };
  }

  async function deepHunt(ctx) {
    const targets = orderedTargets(ctx);
    const current = state.get();
    const cursor = Number(current.health && current.health.deepHuntCursor) || 0;
    const result = await huntTarget(ctx, targets[cursor % targets.length]);
    const health = state.get().health || {};
    state.update({ health: { ...health, deepHuntCursor: (cursor + 1) % targets.length, lastDeepHuntAt } });
    return result;
  }

  async function runBackfillBatch(ctx) {
    const targets = orderedTargets(ctx);
    let progress = backfillStatus();
    const validKeys = new Set(targets.map(targetIndexKey));
    const completedKeys = progress.completedKeys.filter((key) => validKeys.has(key));
    progress = { ...progress, completedKeys, cursor: completedKeys.length, checked: completedKeys.length, total: targets.length };
    if (progress.active && progress.completedKeys.length >= targets.length) {
      progress = { ...progress, active: false, completedAt: now() };
      const health = state.get().health || {};
      state.update({ health: { ...health, backfill: progress, lastDeepHuntAt } });
    }
    const output = { newDeals: [], newGems: [], inspected: 0, titleMatches: 0, versionRejected: 0, reissueRejected: 0, found: 0, target: null };
    let processedTargets = 0;
    while (progress.active && progress.cursor < targets.length && processedTargets < BACKFILL_BATCH_SIZE) {
      const completed = new Set(progress.completedKeys);
      const target = targets.find((candidate) => !completed.has(targetIndexKey(candidate)));
      if (!target) {
        progress = { ...progress, active: false, completedAt: now() };
        break;
      }
      const result = await huntTarget(ctx, target);
      output.newDeals.push(...result.newDeals);
      output.newGems.push(...result.newGems);
      output.inspected += result.inspected;
      output.titleMatches += result.titleMatches;
      output.versionRejected += result.versionRejected;
      output.reissueRejected += result.reissueRejected;
      output.found += result.found;
      output.target = result.target;
      processedTargets += 1;
      // Cancellation may arrive while the network request is in flight. Preserve that newer flag,
      // while still advancing past the title whose completed result was already processed.
      const latestProgress = backfillStatus();
      const nextCompletedKeys = Array.from(new Set([...latestProgress.completedKeys.filter((key) => validKeys.has(key)), result.target]));
      progress = {
        ...latestProgress,
        active: latestProgress.active,
        cursor: nextCompletedKeys.length,
        checked: nextCompletedKeys.length,
        total: targets.length,
        completedKeys: nextCompletedKeys,
        listingsFound: latestProgress.listingsFound + result.found,
        dealsFound: latestProgress.dealsFound + result.newDeals.length,
        gemsFound: latestProgress.gemsFound + result.newGems.length,
        lastTarget: result.target,
      };
      if (progress.completedKeys.length >= targets.length) progress = { ...progress, active: false, completedAt: now() };
      const health = state.get().health || {};
      state.update({ health: { ...health, backfill: progress, lastDeepHuntAt } });
      publish();
      // Cancel is cooperative: finish the in-flight request, then stop before the next title.
      progress = backfillStatus();
    }
    return { ...output, checked: progress.checked, total: targets.length, active: progress.active };
  }

  function schedule(delayMs) {
    if (timer) clearTimer(timer);
    timer = null;
    if (stopped || !hasScheduledWork()) { nextPollAt = null; return; }
    const delay = Math.max(0, Number(delayMs) || 0);
    nextPollAt = now() + delay;
    timer = setTimer(() => { timer = null; runOnce({ scheduled: true }).catch(() => {}); }, delay);
  }

  async function runOnce(runOptions = {}) {
    if (running) return snapshot();
    running = true;
    nextPollAt = null;
    lastError = null;
    publish();
    let delay = settings().pollSeconds * 1000;
    try {
      const ctx = await loadContext(!!runOptions.refreshWantlist);
      const cfgAtStart = settings();
      const backfillAtStart = backfillStatus().active;
      // A one-off backfill should spend its request budget on the existing catalogue. When the
      // background sniper is enabled, keep interleaving the newest feed so fresh deals retain
      // priority. An explicit manual scan still performs both parts.
      const backfillOnly = backfillAtStart && !cfgAtStart.enabled && !runOptions.forceDeep;
      const broad = backfillOnly
        ? { newDeals: [], newGems: [], inspected: 0, titleMatches: 0, versionRejected: 0, reissueRejected: 0, pages: 0, foundWatermark: true, feedItems: 0 }
        : await broadPoll(ctx);
      let deep = null;
      if (backfillStatus().active) deep = await runBackfillBatch(ctx);
      // If cancellation arrived while the broad request was in flight, stop at that cooperative
      // boundary. The normal sniper can resume its own Deep Hunt on the next scheduled cycle.
      else if (!backfillAtStart && (runOptions.forceDeep || !lastDeepHuntAt || now() - lastDeepHuntAt >= settings().deepHuntSeconds * 1000)) deep = await deepHunt(ctx);
      if (backfillStatus().active) delay = Math.min(delay, BACKFILL_ROUND_DELAY_MS);
      lastPollAt = now();
      lastRunStats = {
        pages: broad.pages,
        feedItems: broad.feedItems,
        inspected: broad.inspected,
        titleMatches: broad.titleMatches,
        versionRejected: broad.versionRejected,
        reissueRejected: broad.reissueRejected,
        caughtUp: broad.foundWatermark,
        deepTarget: deep && deep.target || null,
        backfillChecked: deep && deep.checked || null,
        backfillTotal: deep && deep.total || null,
      };
      const health = state.get().health || {};
      state.update({ health: { ...health, lastPollAt, lastDeepHuntAt, lastRunStats } });
      running = false;
      if (hasScheduledWork()) schedule(delay);
      return publish({
        newDeals: [...broad.newDeals, ...(deep ? deep.newDeals : [])],
        newGems: [...broad.newGems, ...(deep ? deep.newGems : [])],
      });
    } catch (error) {
      const deliberatelyStopped = !hasScheduledWork() && error && error.code === 'CLOSED';
      lastError = deliberatelyStopped ? null : (error && error.message ? error.message : String(error));
      const retryAfter = Number(error && error.retryAfterMs) || 0;
      delay = Math.max(delay, retryAfter);
      running = false;
      if (hasScheduledWork()) schedule(delay);
      return publish();
    }
  }

  function start() {
    stopped = false;
    if (hasScheduledWork()) schedule(0);
    return snapshot();
  }

  function stop() {
    stopped = true;
    if (timer) clearTimer(timer);
    timer = null;
    nextPollAt = null;
    if (client && typeof client.close === 'function') client.close();
    client = null;
    lastClientCount = 0;
    context = null;
    contextLoadedAt = 0;
  }

  function setEnabled(enabled) {
    options.writeSettings({ vintedEnabled: !!enabled });
    stopped = false;
    lastError = null;
    if (enabled) schedule(0);
    else if (!backfillStatus().active) {
      if (timer) clearTimer(timer);
      timer = null;
      nextPollAt = null;
      if (client && typeof client.close === 'function') client.close();
      client = null;
      lastClientCount = 0;
      context = null;
      contextLoadedAt = 0;
    }
    return publish();
  }

  function startBackfill() {
    const current = state.get();
    const health = current.health || {};
    const estimatedTotal = context && context.index ? context.index.targets.length : (current.wantlist || []).length;
    const previous = backfillStatus(current);
    const resume = previous.completedKeys.length > 0 && previous.completedKeys.length < (previous.total || estimatedTotal) && !previous.completedAt;
    state.update({
      health: {
        ...health,
        backfill: resume ? {
          ...previous,
          active: true,
          cancelledAt: null,
        } : {
          active: true,
          cursor: 0,
          checked: 0,
          total: estimatedTotal,
          listingsFound: 0,
          dealsFound: 0,
          gemsFound: 0,
          completedKeys: [],
          startedAt: now(),
          completedAt: null,
          cancelledAt: null,
          lastTarget: null,
        },
      },
    });
    stopped = false;
    lastError = null;
    schedule(0);
    return publish();
  }

  function cancelBackfill() {
    const current = state.get();
    const health = current.health || {};
    const progress = backfillStatus(current);
    state.update({ health: { ...health, backfill: { ...progress, active: false, cancelledAt: now() } } });
    if (!settings().enabled) {
      if (timer) clearTimer(timer);
      timer = null;
      nextPollAt = null;
      if (!running && client && typeof client.close === 'function') client.close();
      if (!running) client = null;
    }
    return publish();
  }

  function configure(values = {}) {
    const patch = {};
    if (values.pollSeconds != null) patch.vintedPollSeconds = clamp(values.pollSeconds, 10, 300, 15);
    if (values.deepHuntSeconds != null) patch.vintedDeepHuntSeconds = clamp(values.deepHuntSeconds, 30, 3600, 60);
    options.writeSettings(patch);
    if (hasScheduledWork()) schedule(settings().pollSeconds * 1000);
    return publish();
  }

  return { start, stop, runOnce, setEnabled, configure, startBackfill, cancelBackfill, snapshot, refreshWantlist: () => loadContext(true) };
}

module.exports = { createVintedService, clamp, asTimestamp, queryUrl, LIVE_DEAL_TTL_MS, BACKFILL_BATCH_SIZE, BACKFILL_ROUND_DELAY_MS };

if (require.main === module && process.argv.includes('--selftest')) {
  const assert = require('assert');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'deal-shark-vinted-service-')), 'state.json');
  let clock = 1_800_000_000_000;
  let feed = [];
  const fakeClient = {
    async catalog(input) { return { items: input.searchText ? feed : feed, total: feed.length, fetchedAt: clock }; },
    status() { return { state: 'ready', requestCount: 0, lastRequestAt: null }; },
    async itemPage(url) {
      return String(url).includes('/items/56')
        ? { found: true, description: 'Formato: singolo 7 pollici. Catalogo TEST 001.' }
        : { found: true, description: 'Original pressing TEST 001' };
    },
    close() {},
  };
  let persistedSettings = { vintedEnabled: false, vintedPollSeconds: 15, vintedDeepHuntSeconds: 60 };
  const service = createVintedService({
    stateFile,
    now: () => clock,
    readSettings: () => persistedSettings,
    writeSettings: (patch) => { persistedSettings = { ...persistedSettings, ...patch }; },
    readConfig: () => ({ username: 'test', token: 'secret', minDiscount: 0.5, shippingEstimate: 5 }),
    loadWantlist: async () => [{ releaseId: 10, artist: 'Macho', title: 'I’m a Man' }],
    loadMedians: async () => ({ 10: { median: 100 } }),
    loadReleaseMetadata: async () => ({
      id: 10,
      year: 1983,
      formats: [{ name: 'Vinyl', descriptions: ['12\"', '45 RPM'] }],
      labels: [{ name: 'Test Records', catno: 'TEST 001' }],
    }),
    clientFactory: () => fakeClient,
  });
  (async () => {
    let result = await service.runOnce({ forceDeep: true });
    assert.strictEqual(result.deals.length, 0);
    assert.strictEqual(result.gems.zeroWatch.length, 1, 'empty targeted search establishes a zero watch');
    clock += 61_000;
    feed = [{ id: 55, title: 'Macho - I’m a Man 12 inch vinyl', price: { amount: '20', currency_code: 'EUR' }, service_fee: { amount: '2' }, url: 'https://www.vinted.nl/items/55' }];
    result = await service.runOnce({ forceDeep: true });
    assert.strictEqual(result.deals.length, 1, 'new matching bargain becomes a deal');
    assert.strictEqual(result.gems.gems.length, 1, 'zero to available becomes a rare gem');
    assert.strictEqual(result.status.enabled, false, 'manual scan does not silently enable background polling');
    clock += 61_000;
    feed = [
      { id: 55, title: 'Macho - I’m a Man 12 inch vinyl', price: { amount: '10', currency_code: 'EUR' }, service_fee: { amount: '2' }, url: 'https://www.vinted.nl/items/55' },
      { id: 55, title: 'Macho - I’m a Man 12 inch vinyl', price: { amount: '10', currency_code: 'EUR' }, service_fee: { amount: '2' }, url: 'https://www.vinted.nl/items/55' },
    ];
    result = await service.runOnce({ forceDeep: true });
    assert.strictEqual(result.newDeals.length, 1, 'a duplicated feed row still emits one price-drop signal');
    assert.strictEqual(result.deals[0].itemPrice, 10);
    assert.strictEqual(result.gems.gems.length, 1, 'available to available does not duplicate a rare gem');
    clock += LIVE_DEAL_TTL_MS + 1;
    assert.strictEqual(service.snapshot().deals.length, 0, 'deals not re-observed for 48 hours leave the live view');
    result = await service.runOnce({ forceDeep: true });
    assert.strictEqual(result.deals.length, 1, 'a targeted hunt refreshes a still-visible listing');
    assert.strictEqual(result.newDeals.length, 0, 'refreshing a still-visible listing does not re-alert it');
    clock += 61_000;
    feed = [{ id: 55, title: 'Macho - I’m a Man 12 inch vinyl Reissue', price: { amount: '10', currency_code: 'EUR' }, service_fee: { amount: '2' }, url: 'https://www.vinted.nl/items/55' }];
    result = await service.runOnce({ forceDeep: true });
    assert.strictEqual(result.deals.length, 0, 'an explicit incompatible pressing edit removes the old deal card');
    assert.strictEqual(result.gems.gems.length, 0, 'an explicit incompatible pressing edit removes the old rare-gem card');
    clock += 61_000;
    feed = [{ id: 56, title: 'Macho - I’m a Man original TEST 001', price: { amount: '10', currency_code: 'EUR' }, service_fee: { amount: '2' }, url: 'https://www.vinted.nl/items/56' }];
    result = await service.runOnce({ forceDeep: true });
    assert.strictEqual(result.deals.length, 0, 'a title that initially looks like the wanted 12-inch is rejected when its description says 7-inch');
    assert.strictEqual(result.status.lastRunStats.versionRejected > 0, true, 'the description-only size conflict is counted as a rejected version');
    service.stop();

    const elvinStateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'deal-shark-vinted-elvin-')), 'state.json');
    const elvinClient = {
      async catalog() {
        return {
          items: [{
            id: 6199330482,
            title: 'Disco 12" Elvin - Luggi, Luggi, Ludwig',
            price: { amount: '35', currency_code: 'EUR' },
            total_item_price: { amount: '37.45', currency_code: 'EUR' },
            service_fee: { amount: '2.45', currency_code: 'EUR' },
            status: 'Heel goed',
            url: 'https://www.vinted.nl/items/6199330482-disco-12-elvin-luggi-luggi-ludwig',
          }],
          total: 1,
          fetchedAt: clock,
        };
      },
      async itemPage() {
        return { description: 'Disco e cover in ottimo stato. https://www.discogs.com/release/122472-Elvin-Luggi-Luggi-Ludwig' };
      },
      status() { return { state: 'ready', requestCount: 0, lastRequestAt: null }; },
      close() {},
    };
    const elvinService = createVintedService({
      stateFile: elvinStateFile,
      now: () => clock,
      readSettings: () => ({ vintedEnabled: false, vintedPollSeconds: 120, vintedDeepHuntSeconds: 60 }),
      writeSettings: () => {},
      readConfig: () => ({ username: 'test', token: 'secret', minDiscount: 0.5, shippingEstimate: 5 }),
      loadWantlist: async () => [{ releaseId: 122472, artist: 'Elvin', title: 'Luggi, Luggi, Ludwig', year: 1986 }],
      loadMedians: async () => ({ 122472: { median: 46.24 } }),
      loadPriceSuggestion: async () => ({ ladder: { 'Very Good Plus (VG+)': 52.325 } }),
      loadReleaseMetadata: async () => ({
        id: 122472,
        year: 1986,
        formats: [{ name: 'Vinyl', descriptions: ['12"', 'Maxi-Single', '45 RPM'] }],
        labels: [{ name: 'Bellaphon', catno: '120·05·005' }],
      }),
      clientFactory: () => elvinClient,
    });
    const elvinResult = await elvinService.runOnce({ forceDeep: true });
    assert.strictEqual(elvinResult.deals.length, 1, 'Elvin at €35 in Vinted Heel goed now triggers a good-price alert');
    assert.deepStrictEqual(
      {
        tier: elvinResult.deals[0].dealTier,
        reference: elvinResult.deals[0].reference,
        grade: elvinResult.deals[0].referenceGrade,
        total: elvinResult.deals[0].lowest + elvinResult.deals[0].shippingEstimate,
        resaleNet: Number(elvinResult.deals[0].resaleNet.toFixed(2)),
        resaleMargin: Number(elvinResult.deals[0].resaleMargin.toFixed(2)),
        resaleRoi: Number(elvinResult.deals[0].resaleRoi.toFixed(3)),
      },
      { tier: 'good-price', reference: 52.325, grade: 'Very Good Plus (VG+)', total: 42.45, resaleNet: 47.62, resaleMargin: 5.17, resaleRoi: 0.122 },
    );
    elvinService.stop();

    const backfillSize = BACKFILL_BATCH_SIZE + 2;
    const backfillStateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'deal-shark-vinted-backfill-')), 'state.json');
    const backfillWants = Array.from({ length: backfillSize }, (_, index) => ({
      releaseId: index + 1,
      artist: `Band${index + 1}`,
      title: `Record${index + 1}`,
    }));
    const backfillMedians = Object.fromEntries(backfillWants.map((want) => [want.releaseId, { median: 100 }]));
    let targetedCalls = 0;
    let broadCalls = 0;
    const scheduledDelays = [];
    const backfillClient = {
      async catalog(input) {
        if (!input.searchText) {
          broadCalls += 1;
          return { items: [], total: 0, fetchedAt: clock };
        }
        targetedCalls += 1;
        const number = Number(String(input.searchText).match(/Band(\d+)/)?.[1]);
        return {
          items: [{ id: 1000 + number, title: `Band${number} - Record${number} CAT${String(number).padStart(4, '0')}`, price: { amount: '10', currency_code: 'EUR' }, url: `https://www.vinted.nl/items/${1000 + number}` }],
          total: 1,
          fetchedAt: clock,
        };
      },
      status() { return { state: 'ready', requestCount: targetedCalls, lastRequestAt: clock }; },
      close() {},
    };
    const backfillService = createVintedService({
      stateFile: backfillStateFile,
      now: () => clock,
      setTimer: (_callback, delay) => { scheduledDelays.push(delay); return { fake: true }; },
      clearTimer: () => {},
      readSettings: () => ({ vintedEnabled: false, vintedPollSeconds: 120, vintedDeepHuntSeconds: 60 }),
      writeSettings: () => {},
      readConfig: () => ({ username: 'test', token: 'secret', minDiscount: 0.5, shippingEstimate: 5 }),
      loadWantlist: async () => backfillWants,
      loadMedians: async () => backfillMedians,
      loadReleaseMetadata: async (releaseId) => ({
        id: releaseId,
        formats: [{ name: 'Vinyl', descriptions: ['12\"'] }],
        labels: [{ name: 'Backfill Records', catno: `CAT${String(releaseId).padStart(4, '0')}` }],
      }),
      clientFactory: () => backfillClient,
    });
    let backfillResult = backfillService.startBackfill();
    assert.strictEqual(backfillResult.status.backfill.active, true, 'backfill can start while the background sniper is disabled');
    backfillResult = await backfillService.runOnce();
    assert.strictEqual(backfillResult.status.backfill.checked, BACKFILL_BATCH_SIZE, 'one run processes a bounded backfill batch');
    assert.strictEqual(backfillResult.status.backfill.active, true, 'a larger backfill remains resumable after the first batch');
    assert.strictEqual(backfillResult.deals.length, BACKFILL_BATCH_SIZE);
    assert.strictEqual(scheduledDelays.at(-1), BACKFILL_ROUND_DELAY_MS, 'backfill schedules the next bounded batch without waiting for a slow polling preference');
    backfillResult = backfillService.cancelBackfill();
    assert.strictEqual(backfillResult.status.backfill.active, false);
    backfillResult = backfillService.startBackfill();
    assert.strictEqual(backfillResult.status.backfill.checked, BACKFILL_BATCH_SIZE, 'resuming preserves the completed backfill cursor');
    backfillMedians[backfillSize].median = 1000;
    backfillMedians[backfillSize - 1].median = 900;
    backfillResult = await backfillService.runOnce({ refreshWantlist: true });
    assert.strictEqual(backfillResult.status.backfill.checked, backfillSize);
    assert.strictEqual(backfillResult.status.backfill.active, false, 'backfill completes after every target was checked');
    assert.strictEqual(backfillResult.deals.length, backfillSize);
    assert.strictEqual(targetedCalls, backfillSize, 'completed target keys prevent repeats or skips when priorities reorder during resume');
    assert.strictEqual(broadCalls, 0, 'backfill-only mode reserves its Vinted requests for existing-listing searches');
    backfillService.startBackfill();
    backfillResult = backfillService.cancelBackfill();
    assert.strictEqual(backfillResult.status.backfill.active, false, 'a user can cancel a backfill without enabling background polling');
    backfillService.stop();

    let releaseBroad;
    let signalBroadStarted;
    let cancelTargetedCalls = 0;
    const broadStarted = new Promise((resolve) => { signalBroadStarted = resolve; });
    const cancelService = createVintedService({
      stateFile: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'deal-shark-vinted-cancel-')), 'state.json'),
      now: () => clock,
      setTimer: () => ({ fake: true }),
      clearTimer: () => {},
      readSettings: () => ({ vintedEnabled: true, vintedPollSeconds: 120, vintedDeepHuntSeconds: 60 }),
      writeSettings: () => {},
      readConfig: () => ({ username: 'test', token: 'secret', minDiscount: 0.5, shippingEstimate: 5 }),
      loadWantlist: async () => backfillWants.slice(0, 1),
      loadMedians: async () => backfillMedians,
      loadReleaseMetadata: async (releaseId) => ({
        id: releaseId,
        formats: [{ name: 'Vinyl', descriptions: ['12\"'] }],
        labels: [{ name: 'Backfill Records', catno: `CAT${String(releaseId).padStart(4, '0')}` }],
      }),
      clientFactory: () => ({
        async catalog(input) {
          if (input.searchText) {
            cancelTargetedCalls += 1;
            return { items: [], total: 0, fetchedAt: clock };
          }
          signalBroadStarted();
          await new Promise((resolve) => { releaseBroad = resolve; });
          return { items: [], total: 0, fetchedAt: clock };
        },
        status() { return { state: 'ready', requestCount: 0, lastRequestAt: null }; },
        close() {},
      }),
    });
    cancelService.startBackfill();
    const cancellingRun = cancelService.runOnce();
    await broadStarted;
    cancelService.cancelBackfill();
    releaseBroad();
    const cancelledResult = await cancellingRun;
    assert.strictEqual(cancelledResult.status.backfill.active, false);
    assert.strictEqual(cancelTargetedCalls, 0, 'cancelling during a broad poll does not start another targeted hunt');
    cancelService.stop();
    console.log('vinted/service selftest: all assertions passed');
  })().catch((error) => { console.error(error); process.exitCode = 1; });
}

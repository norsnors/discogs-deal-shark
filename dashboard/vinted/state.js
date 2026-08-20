'use strict';

const fs = require('fs');
const path = require('path');
const { rareGemTransition } = require('./policy');

// Version 3 also verifies vinyl size and rejects compilation listings for non-compilation wants.
// Older marketplace-derived records may therefore carry an unsafe median and must be re-observed.
const VERSION = 3;
const DEFAULT_CAPS = Object.freeze({ deals: 500, gems: 250, seenIds: 50000, availability: 10000 });
const SECRET_KEY = /^(?:raw|rawResponse|rawPayload|rawBody|rawData|cookie|cookies|set-cookie|authorization|token|access[_-]?token|refresh[_-]?token|headers?|session)$/i;

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

// State is deliberately a public, display-oriented projection. This strips accidental response
// objects, cookies and auth material before anything can be written to disk.
function sanitize(value, depth = 0) {
  if (value == null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth > 8) return null;
  if (Array.isArray(value)) return value.map((entry) => sanitize(entry, depth + 1)).filter((entry) => entry !== undefined);
  if (typeof value !== 'object') return undefined;
  const output = {};
  for (const [key, entry] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) continue;
    const clean = sanitize(entry, depth + 1);
    if (clean !== undefined) output[key] = clean;
  }
  return output;
}

function finiteTimestamp(value, fallback = Date.now()) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function recordId(record, fallback = null) {
  if (!record || typeof record !== 'object') return fallback;
  const id = record.id ?? record.itemId ?? record.listingId ?? record.item_id;
  return id == null ? fallback : String(id);
}

function capRecords(records, cap) {
  const byId = new Map();
  for (const value of Array.isArray(records) ? records : []) {
    const clean = sanitize(value);
    if (!clean || typeof clean !== 'object') continue;
    const id = recordId(clean, null);
    if (id == null) continue;
    byId.set(id, clean);
  }
  return Array.from(byId.values())
    .sort((a, b) => finiteTimestamp(b.ts ?? b.updatedAt ?? b.lastSeenAt ?? b.createdAt, 0) - finiteTimestamp(a.ts ?? a.updatedAt ?? a.lastSeenAt ?? a.createdAt, 0))
    .slice(0, cap);
}

function normalizeState(input, caps) {
  const incoming = input && typeof input === 'object' ? sanitize(input) : {};
  const storedVersion = Number(incoming.version) || 0;
  const legacy = storedVersion < VERSION;
  // Keep the harmless wantlist projection during migration, but force every marketplace-derived
  // field to be observed again under the strict pressing policy.
  const source = legacy ? { wantlist: Array.isArray(incoming.wantlist) ? incoming.wantlist : [] } : incoming;
  const availability = source.availability && typeof source.availability === 'object' && !Array.isArray(source.availability)
    ? Object.fromEntries(Object.entries(source.availability).slice(-caps.availability)) : {};
  const seenIds = Array.from(new Set((Array.isArray(source.seenIds) ? source.seenIds : []).map((id) => String(id)).filter(Boolean))).slice(-caps.seenIds);
  return {
    version: VERSION,
    updatedAt: finiteTimestamp(source.updatedAt, Date.now()),
    watermark: source.watermark && typeof source.watermark === 'object' ? {
      id: source.watermark.id == null ? null : String(source.watermark.id),
      seenAt: finiteTimestamp(source.watermark.seenAt, 0),
    } : null,
    seenIds,
    deals: capRecords(source.deals, caps.deals),
    gems: capRecords(source.gems, caps.gems),
    availability,
    wantlist: Array.isArray(source.wantlist) ? source.wantlist.slice(0, 10000) : [],
    health: source.health && typeof source.health === 'object' ? source.health : null,
  };
}

function createVintedState(filePath, options = {}) {
  if (!filePath) throw new Error('createVintedState needs a file path.');
  const target = path.resolve(String(filePath));
  const caps = {
    deals: Math.max(1, Number(options.dealsCap ?? options.deals ?? DEFAULT_CAPS.deals) || DEFAULT_CAPS.deals),
    gems: Math.max(1, Number(options.gemsCap ?? options.gems ?? DEFAULT_CAPS.gems) || DEFAULT_CAPS.gems),
    seenIds: Math.max(1, Number(options.seenCap ?? options.seenIds ?? DEFAULT_CAPS.seenIds) || DEFAULT_CAPS.seenIds),
    availability: Math.max(1, Number(options.availabilityCap ?? DEFAULT_CAPS.availability) || DEFAULT_CAPS.availability),
  };
  fs.mkdirSync(path.dirname(target), { recursive: true });
  let state;

  function read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
      return normalizeState(parsed, caps);
    } catch (error) {
      if (error && error.code === 'ENOENT') return normalizeState({}, caps);
      // Keep a recoverable copy of a corrupt state file, then let the app start with a clean
      // state. No network/session material is copied here; this is only the local public state.
      try { fs.copyFileSync(target, `${target}.corrupt-${Date.now()}`); } catch { /* best effort */ }
      return normalizeState({}, caps);
    }
  }

  state = read();

  function write() {
    state = normalizeState(state, caps);
    state.updatedAt = Date.now();
    const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(temporary, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 });
    try {
      fs.renameSync(temporary, target);
    } catch (error) {
      try { fs.unlinkSync(temporary); } catch { /* preserve the original error */ }
      throw error;
    }
  }

  function get() { return clone(state); }

  function save(next = state) {
    state = normalizeState(next, caps);
    write();
    return get();
  }

  function update(patchOrUpdater, options = {}) {
    const current = get();
    const patch = typeof patchOrUpdater === 'function' ? patchOrUpdater(current) : patchOrUpdater;
    if (patch && typeof patch === 'object') state = normalizeState({ ...current, ...sanitize(patch) }, caps);
    if (options.persist !== false) write();
    return get();
  }

  function hasSeen(id) {
    return id != null && state.seenIds.includes(String(id));
  }

  function markSeen(id, ts = Date.now(), options = {}) {
    if (id == null) return false;
    const key = String(id);
    const existed = hasSeen(key);
    state.seenIds = state.seenIds.filter((entry) => entry !== key);
    state.seenIds.push(key);
    if (state.seenIds.length > caps.seenIds) state.seenIds.splice(0, state.seenIds.length - caps.seenIds);
    if (options.persist !== false) write();
    return !existed;
  }

  function markSeenBatch(ids, options = {}) {
    let added = 0;
    for (const id of Array.isArray(ids) ? ids : []) if (markSeen(id, options.ts, { persist: false })) added += 1;
    if (options.persist !== false) write();
    return added;
  }

  function setWatermark(id, seenAt = Date.now(), options = {}) {
    if (id == null) return get().watermark;
    state.watermark = { id: String(id), seenAt: finiteTimestamp(seenAt, Date.now()) };
    if (options.persist !== false) write();
    return clone(state.watermark);
  }

  function addRecord(kind, record, options = {}) {
    if (kind !== 'deals' && kind !== 'gems') throw new Error(`Unknown Vinted state collection: ${kind}`);
    const clean = sanitize(record);
    const id = recordId(clean, null);
    if (!clean || id == null) return null;
    clean.id = id;
    const existing = state[kind].filter((entry) => recordId(entry, null) !== id);
    state[kind] = capRecords([clean, ...existing], caps[kind]);
    if (options.persist !== false) write();
    return clone(clean);
  }

  function removeFrom(kind, listingId, options = {}) {
    if (kind !== 'deals' && kind !== 'gems') throw new Error(`Unknown Vinted state collection: ${kind}`);
    if (listingId == null) return 0;
    const key = String(listingId);
    const before = state[kind].length;
    state[kind] = state[kind].filter((record) => String(record.listingId ?? record.itemId ?? '') !== key);
    const removed = before - state[kind].length;
    if (removed && options.persist !== false) write();
    return removed;
  }

  function removeListing(listingId, options = {}) {
    const removed = removeFrom('deals', listingId, { persist: false }) + removeFrom('gems', listingId, { persist: false });
    if (removed && options.persist !== false) write();
    return removed;
  }

  function observeAvailability(targetKey, found, metadata = {}, options = {}) {
    const key = String(targetKey || '').trim();
    if (!key) throw new Error('Availability observations need a target key.');
    const previous = state.availability[key] || { status: 'unknown', checkedAt: null };
    const currentStatus = found ? 'available' : 'zero';
    const transition = rareGemTransition(previous, { status: currentStatus });
    const record = sanitize({
      ...previous,
      ...metadata,
      status: currentStatus,
      checkedAt: Date.now(),
      itemIds: Array.isArray(metadata.itemIds) ? metadata.itemIds.map(String).slice(0, 200) : (previous.itemIds || []),
    });
    state.availability[key] = record;
    const entries = Object.entries(state.availability);
    if (entries.length > caps.availability) {
      entries.sort((a, b) => finiteTimestamp(a[1].checkedAt, 0) - finiteTimestamp(b[1].checkedAt, 0));
      for (const [oldKey] of entries.slice(0, entries.length - caps.availability)) delete state.availability[oldKey];
    }
    if (options.persist !== false) write();
    return { previous: clone(previous), current: clone(record), transition };
  }

  return {
    file: target,
    caps: { ...caps },
    get,
    save,
    update,
    hasSeen,
    markSeen,
    markSeenBatch,
    setWatermark,
    addDeal: (record, options) => addRecord('deals', record, options),
    addGem: (record, options) => addRecord('gems', record, options),
    removeDeal: (listingId, options) => removeFrom('deals', listingId, options),
    removeListing,
    observeAvailability,
  };
}

module.exports = {
  VERSION,
  DEFAULT_CAPS,
  sanitize,
  normalizeState,
  createVintedState,
};

if (require.main === module && process.argv.includes('--selftest')) {
  const assert = require('assert');
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddw-vinted-state-'));
  const file = path.join(dir, 'vinted-state.json');
  const state = createVintedState(file, { dealsCap: 2, gemsCap: 2, seenCap: 3 });
  assert.strictEqual(state.markSeen('a'), true);
  assert.strictEqual(state.markSeen('a'), false);
  state.markSeenBatch(['b', 'c', 'd']);
  assert.deepStrictEqual(state.get().seenIds, ['b', 'c', 'd']);
  state.addDeal({ id: 'vinted:1', title: 'Safe', cookie: 'must-not-persist' });
  state.update({ health: { accessToken: 'also-secret', rawResponse: { payload: true }, state: 'live' } });
  state.addDeal({ id: 'vinted:2', ts: 2 });
  state.addDeal({ id: 'vinted:3', listingId: 3, ts: 3 });
  assert.strictEqual(state.get().deals.length, 2);
  state.addGem({ id: 'vinted-gem:3', listingId: 3 });
  assert.strictEqual(state.removeListing(3), 2, 'a listing invalidated by new pressing evidence is removed from deals and gems');
  assert.strictEqual(state.get().deals.length, 1);
  assert.strictEqual(state.get().gems.length, 0);
  const first = state.observeAvailability('macho::im a man', false, { title: 'I am a Man' });
  assert.strictEqual(first.transition.isRareGem, false);
  const second = state.observeAvailability('macho::im a man', true, { itemIds: [44] });
  assert.strictEqual(second.transition.isRareGem, true);
  const persisted = fs.readFileSync(file, 'utf8');
  assert.ok(!persisted.includes('must-not-persist') && !persisted.includes('cookie') && !persisted.includes('also-secret') && !persisted.includes('rawResponse'), 'state never persists session or raw-response fields');
  const reopened = createVintedState(file, { dealsCap: 2, gemsCap: 2, seenCap: 3 });
  assert.strictEqual(reopened.get().gems.length, 0);
  assert.strictEqual(reopened.get().availability['macho::im a man'].status, 'available');
  const legacyFile = path.join(dir, 'vinted-state-v2.json');
  fs.writeFileSync(legacyFile, JSON.stringify({
    version: 2,
    seenIds: ['unsafe'],
    deals: [{ id: 'vinted:air-mail-reissue', reference: 440 }],
    gems: [{ id: 'vinted-gem:air-mail-reissue' }],
    availability: { 'air mail::flash in your mind': { status: 'available' } },
    watermark: { id: '99', seenAt: 1 },
    wantlist: [{ releaseId: 345216, artist: 'Air Mail', title: 'Flash In Your Mind' }],
  }));
  const migrated = createVintedState(legacyFile);
  assert.strictEqual(migrated.get().version, VERSION);
  assert.deepStrictEqual(migrated.get().seenIds, [], 'title-only seen ids are cleared so listings can be judged again');
  assert.deepStrictEqual(migrated.get().deals, [], 'title-only deals are removed during pressing-aware migration');
  assert.deepStrictEqual(migrated.get().gems, [], 'title-only gems are removed during pressing-aware migration');
  assert.deepStrictEqual(migrated.get().availability, {}, 'title-only availability transitions are rebuilt');
  assert.strictEqual(migrated.get().watermark, null, 'the feed is replayed under the new pressing policy');
  assert.strictEqual(migrated.get().wantlist.length, 1, 'the harmless wantlist projection survives migration');
  console.log('vinted/state selftest: all assertions passed');
}

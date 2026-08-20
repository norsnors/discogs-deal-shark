'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { rareGemTransition } = require('../vinted/policy');

const VERSION = 2;
const SECRET_KEY = /^(?:raw|rawResponse|rawPayload|authorization|token|access[_-]?token|refresh[_-]?token|headers?|appKey|secret)$/i;

function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
function sanitize(value, depth = 0) {
  if (value == null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
  if (depth > 8 || typeof value !== 'object') return undefined;
  if (Array.isArray(value)) return value.map((entry) => sanitize(entry, depth + 1)).filter((entry) => entry !== undefined);
  return Object.fromEntries(Object.entries(value).filter(([key]) => !SECRET_KEY.test(key)).map(([key, entry]) => [key, sanitize(entry, depth + 1)]).filter(([, entry]) => entry !== undefined));
}
function timestamp(value, fallback = Date.now()) { const n = Number(value); return Number.isFinite(n) ? n : fallback; }
function recordId(record) { return record && String(record.id ?? record.itemId ?? record.listingId ?? ''); }
function cap(records, limit) {
  const map = new Map();
  for (const raw of Array.isArray(records) ? records : []) {
    const clean = sanitize(raw); const id = recordId(clean); if (id) map.set(id, clean);
  }
  return [...map.values()].sort((a, b) => timestamp(b.ts ?? b.observedAt, 0) - timestamp(a.ts ?? a.observedAt, 0)).slice(0, limit);
}
function normalize(input = {}) {
  const value = sanitize(input) || {};
  return {
    version: VERSION,
    updatedAt: timestamp(value.updatedAt),
    cursor: Math.max(0, Number(value.cursor) || 0),
    seenIds: [...new Set((Array.isArray(value.seenIds) ? value.seenIds : []).map(String))].slice(-50000),
    deals: cap(value.deals, 500),
    matches: cap(value.matches, 1000),
    gems: cap(value.gems, 250),
    availability: value.availability && typeof value.availability === 'object' && !Array.isArray(value.availability) ? value.availability : {},
    wantlist: Array.isArray(value.wantlist) ? value.wantlist.slice(0, 10000) : [],
    health: value.health && typeof value.health === 'object' ? value.health : {},
  };
}

function createTraderaState(filePath) {
  if (!filePath) throw new Error('createTraderaState needs a file path.');
  const target = path.resolve(String(filePath));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  let state;
  try { state = normalize(JSON.parse(fs.readFileSync(target, 'utf8'))); } catch { state = normalize({}); }
  function write() {
    state = normalize(state); state.updatedAt = Date.now();
    const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(temp, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temp, target);
  }
  function get() { return clone(state); }
  function update(patch, options = {}) {
    const value = typeof patch === 'function' ? patch(get()) : patch;
    if (value && typeof value === 'object') state = normalize({ ...state, ...sanitize(value) });
    if (options.persist !== false) write();
    return get();
  }
  function add(kind, record, options = {}) {
    if (!['deals', 'matches', 'gems'].includes(kind)) throw new Error(`Unknown Tradera collection: ${kind}`);
    const clean = sanitize(record); const id = recordId(clean); if (!id) return null;
    state[kind] = cap([clean, ...state[kind].filter((entry) => recordId(entry) !== id)], kind === 'matches' ? 1000 : (kind === 'deals' ? 500 : 250));
    if (options.persist !== false) write();
    return clone(clean);
  }
  function markSeen(id, options = {}) {
    const key = String(id || ''); if (!key) return false;
    const fresh = !state.seenIds.includes(key);
    state.seenIds = [...state.seenIds.filter((entry) => entry !== key), key].slice(-50000);
    if (options.persist !== false) write();
    return fresh;
  }
  function observeAvailability(key, found, metadata = {}, options = {}) {
    const id = String(key || ''); if (!id) throw new Error('Availability needs a target key.');
    const previous = state.availability[id] || { status: 'unknown' };
    const current = sanitize({ ...previous, ...metadata, status: found ? 'available' : 'zero', checkedAt: Date.now() });
    state.availability[id] = current;
    if (options.persist !== false) write();
    return { previous: clone(previous), current: clone(current), transition: rareGemTransition(previous, current) };
  }
  return { file: target, get, update, save: (value) => { state = normalize(value); write(); return get(); }, addDeal: (r, o) => add('deals', r, o), addMatch: (r, o) => add('matches', r, o), addGem: (r, o) => add('gems', r, o), markSeen, observeAvailability };
}

module.exports = { VERSION, sanitize, normalize, createTraderaState };

if (require.main === module && process.argv.includes('--selftest')) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deal-shark-tradera-state-'));
  const file = path.join(dir, 'state.json');
  const state = createTraderaState(file);
  assert.strictEqual(state.markSeen('one'), true);
  assert.strictEqual(state.markSeen('one'), false);
  state.addDeal({ id: 'tradera:1', rawPayload: { appKey: 'never' }, lowest: 10 });
  state.addMatch({ id: 'tradera:2', alertEligible: false, lowest: 20 });
  state.observeAvailability('a', false);
  assert.strictEqual(state.observeAvailability('a', true).transition.isRareGem, true);
  const disk = fs.readFileSync(file, 'utf8');
  assert.ok(!disk.includes('never') && !disk.includes('appKey'));
  assert.strictEqual(state.get().matches.length, 1);
  console.log('tradera state selftest: OK');
}

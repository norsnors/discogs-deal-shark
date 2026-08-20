'use strict';

const assert = require('assert');

const ALL_SCAN_SOURCES = Object.freeze(['discogs', 'vinted', 'ebay', 'tradera']);

function publicStates(states) {
  return Object.fromEntries(ALL_SCAN_SOURCES.map((source) => [source, { ...states[source] }]));
}

async function runAllScans({ runners = {}, onUpdate = () => {}, now = Date.now } = {}) {
  const startedAt = now();
  const states = Object.fromEntries(ALL_SCAN_SOURCES.map((source) => [source, { status: 'queued' }]));
  const results = {};
  const publish = () => {
    try { onUpdate({ running: true, startedAt, sources: publicStates(states) }); } catch { /* UI updates are best effort */ }
  };
  publish();

  await Promise.all(ALL_SCAN_SOURCES.map(async (source) => {
    const entry = runners[source];
    const run = typeof entry === 'function' ? entry : entry && entry.run;
    const skipReason = entry && typeof entry === 'object' ? entry.skipReason : null;
    if (skipReason || typeof run !== 'function') {
      states[source] = { status: 'skipped', reason: skipReason || 'Not available' };
      publish();
      return;
    }

    states[source] = { status: 'running', startedAt: now() };
    publish();
    try {
      const result = await run();
      results[source] = result;
      if (result && result.postponed) {
        states[source] = { status: 'skipped', reason: 'Waiting for the cloud Discogs scan', completedAt: now() };
      } else {
        states[source] = { status: 'done', completedAt: now() };
      }
    } catch (error) {
      states[source] = { status: 'error', error: error && error.message ? error.message : String(error), completedAt: now() };
    }
    publish();
  }));

  const failures = ALL_SCAN_SOURCES.filter((source) => states[source].status === 'error');
  const skipped = ALL_SCAN_SOURCES.filter((source) => states[source].status === 'skipped');
  const completedAt = now();
  const outcome = { ok: failures.length === 0, startedAt, completedAt, sources: publicStates(states), results, failures, skipped };
  try { onUpdate({ running: false, ...outcome, results: undefined }); } catch { /* UI updates are best effort */ }
  return outcome;
}

module.exports = { ALL_SCAN_SOURCES, runAllScans };

if (require.main === module && process.argv.includes('--selftest')) {
  (async () => {
    let active = 0; let maxActive = 0; const updates = [];
    const runner = (value, fail = false) => async () => {
      active += 1; maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      if (fail) throw new Error(`${value} failed`);
      return { value };
    };
    const result = await runAllScans({
      runners: {
        discogs: runner('discogs'),
        vinted: runner('vinted'),
        ebay: runner('ebay', true),
        tradera: { skipReason: 'credentials missing' },
      },
      onUpdate: (update) => updates.push(update),
    });
    assert.ok(maxActive >= 2, 'available sources start concurrently');
    assert.strictEqual(result.results.discogs.value, 'discogs');
    assert.strictEqual(result.sources.vinted.status, 'done');
    assert.strictEqual(result.sources.ebay.status, 'error');
    assert.strictEqual(result.sources.tradera.status, 'skipped');
    assert.deepStrictEqual(result.failures, ['ebay']);
    assert.ok(updates.some((update) => update.sources.discogs.status === 'running'));
    assert.strictEqual(updates.at(-1).running, false);
    console.log('all-scan selftest: OK');
  })().catch((error) => { console.error(error); process.exitCode = 1; });
}

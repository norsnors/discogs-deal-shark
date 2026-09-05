'use strict';

const assert = require('assert');

const ALL_SCAN_SOURCES = Object.freeze(['discogs', 'vinted', 'ebay', 'tradera', 'marktplaats']);
const DEFAULT_IDLE_TIMEOUT_MS = 90 * 60 * 1000;

function publicStates(states) {
  return Object.fromEntries(ALL_SCAN_SOURCES.map((source) => [source, { ...states[source] }]));
}

async function waitForIdle({
  isRunning,
  timeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
  pollMs = 250,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  label = 'Marketplace scan',
} = {}) {
  if (typeof isRunning !== 'function') throw new Error('waitForIdle needs an isRunning function');
  const startedAt = now();
  while (await isRunning()) {
    if (now() - startedAt >= timeoutMs) throw new Error(`${label} did not finish within ${Math.round(timeoutMs / 60000)} minutes`);
    await sleep(pollMs);
  }
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
    const unavailableReason = entry && typeof entry === 'object' ? entry.unavailableReason : null;
    const detail = entry && typeof entry === 'object' ? entry.detail : null;
    if (unavailableReason) {
      states[source] = { status: 'unconfigured', reason: unavailableReason };
      publish();
      return;
    }
    if (skipReason || typeof run !== 'function') {
      states[source] = { status: 'skipped', reason: skipReason || 'Not available' };
      publish();
      return;
    }

    states[source] = { status: 'running', startedAt: now(), ...(detail ? { detail } : {}) };
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
  const unavailable = ALL_SCAN_SOURCES.filter((source) => states[source].status === 'unconfigured');
  const completedAt = now();
  const outcome = { ok: failures.length === 0, startedAt, completedAt, sources: publicStates(states), results, failures, skipped, unavailable };
  try { onUpdate({ running: false, ...outcome, results: undefined }); } catch { /* UI updates are best effort */ }
  return outcome;
}

module.exports = { ALL_SCAN_SOURCES, DEFAULT_IDLE_TIMEOUT_MS, waitForIdle, runAllScans };

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
        tradera: { unavailableReason: 'API credentials needed' },
        marktplaats: runner('marktplaats'),
      },
      onUpdate: (update) => updates.push(update),
    });
    assert.ok(maxActive >= 2, 'available sources start concurrently');
    assert.strictEqual(result.results.discogs.value, 'discogs');
    assert.strictEqual(result.sources.vinted.status, 'done');
    assert.strictEqual(result.sources.ebay.status, 'error');
    assert.strictEqual(result.sources.tradera.status, 'unconfigured');
    assert.strictEqual(result.sources.marktplaats.status, 'done');
    assert.deepStrictEqual(result.failures, ['ebay']);
    assert.deepStrictEqual(result.unavailable, ['tradera']);
    assert.ok(updates.some((update) => update.sources.discogs.status === 'running'));
    assert.strictEqual(updates.at(-1).running, false);

    let runningPolls = 0;
    await waitForIdle({
      isRunning: () => runningPolls < 2,
      sleep: async () => { runningPolls += 1; },
    });
    assert.strictEqual(runningPolls, 2, 'an existing scan is awaited instead of skipped');

    let clock = 0;
    await assert.rejects(() => waitForIdle({
      isRunning: () => true,
      timeoutMs: 10,
      now: () => clock,
      sleep: async () => { clock += 10; },
      label: 'Vinted scan',
    }), /Vinted scan did not finish/);
    console.log('all-scan selftest: OK');
  })().catch((error) => { console.error(error); process.exitCode = 1; });
}

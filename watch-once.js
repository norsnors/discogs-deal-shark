'use strict';
/*
 * watch-once.js — sweep the wantlist (once, or repeatedly within a time budget), then exit.
 *
 * This is the "GitHub Actions" model (vs watcher.js, the always-on loop). GitHub deprioritizes
 * public-repo schedule crons hard: a `*\/15` cron fires every ~60–90 min in practice (measured),
 * with night gaps up to ~4 h — so a single sweep per tick means hours of detection latency for a
 * just-listed copy. RUN_BUDGET_MINUTES counters that: with it set, one job keeps sweeping
 * BACK-TO-BACK (emailing after every sweep) until the budget is spent, so the sparse ticks still
 * yield near-continuous ~14-min coverage. Unset/0 = the original single sweep (local use).
 *
 * State (history, alert memory, suggestions, cursor) lives in state/ and is carried between runs
 * via the Actions cache. Detected deals are emailed (Resend) and written to deals.json (committed
 * by the workflow so the desktop dashboard can read it). 💎 rare gems are emailed the MOMENT they
 * are found, not after the sweep — they're the most time-critical alert there is.
 *
 * Env (set as GitHub Secrets): DISCOGS_TOKEN, DISCOGS_USERNAME, RESEND_API_KEY, MAIL_TO,
 * MAIL_FROM, SLICE_SIZE, RUN_BUDGET_MINUTES. Run: `node watch-once.js`.
 */

const fs = require('fs');
const path = require('path');
const engine = require('./engine');
const { makeClient } = require('./discogs');
const { makeStore } = require('./store');
const { makeMailer } = require('./mailer');
const { makeTelegram } = require('./telegram');
const { processRelease, loadConfig, zeroWatch } = require('./watcher');
const { flushPendingAlerts } = require('./delivery');

const STATE_DIR = path.join(__dirname, 'state');
const cursorFile = () => path.join(STATE_DIR, 'cursor.json');
const readCursor = () => { try { return JSON.parse(fs.readFileSync(cursorFile(), 'utf8')); } catch { return { wantlistAt: 0, wantlist: [] }; } };
const writeCursor = (c) => fs.writeFileSync(cursorFile(), JSON.stringify(c));

function assessSweepHealth(total, checked, failed, samples = []) {
  const failureLimit = Math.max(3, Math.ceil(total * 0.2));
  if (checked === 0 || failed >= failureLimit) {
    const detail = samples.length ? ` Examples: ${samples.join('; ')}` : '';
    return { ok: false, failureLimit, message: `Sweep unhealthy: ${checked}/${total} releases succeeded and ${failed} failed.${detail}` };
  }
  return { ok: true, failureLimit };
}

async function main() {
  const config = loadConfig();
  if (!config.username) { console.error('Missing DISCOGS_USERNAME / config.username.'); process.exit(1); }

  fs.mkdirSync(STATE_DIR, { recursive: true });
  const store = makeStore(STATE_DIR);

  // Seed REAL sales-history medians committed from local scans. They live at the repo root (the
  // state/ dir is gitignored, so it can't carry them to GitHub) and are NOT in the Actions cache, so
  // checkout always brings the freshest committed copy. With them, emailed deals are judged against
  // true market value instead of Discogs's often-inflated VG+ suggestion; without them, nothing
  // changes (processRelease falls back to the suggestion). Read-only here — the cloud never scrapes them.
  try {
    const sm = JSON.parse(fs.readFileSync(path.join(__dirname, 'soldmedians.json'), 'utf8'));
    const n = sm && typeof sm === 'object' ? Object.keys(sm).length : 0;
    if (n) { store.primeSoldMedians(sm); console.log(`Loaded ${n} committed sold-medians (real-market references).`); }
  } catch { /* none committed yet -> suggestion fallback (unchanged behaviour) */ }

  // Restore warm-up counts + alert dedupe from the committed seed for any release the Actions cache
  // lost (eviction after 7d unused / under the 10 GB cap). Without this, a wiped cache resets every
  // release to "cold" (~4 sweeps of no alerts) AND wipes dedupe (a one-time re-flood). The cache,
  // when present, is always the fresher copy — primeSeed only fills releases it doesn't already have.
  try {
    const seed = JSON.parse(fs.readFileSync(path.join(__dirname, 'state-seed.json'), 'utf8'));
    const restored = store.primeSeed(seed);
    if (restored) console.log(`Cache miss recovery: re-seeded warm-up/dedupe for ${restored} release(s) from state-seed.json.`);
  } catch { /* no seed committed yet, or cache already warm -> nothing to recover */ }

  // Same recovery for the 💎 gem feed: if the Actions cache was evicted, state/gems.json is empty
  // and this run would otherwise commit an EMPTY gems.json — erasing the dashboard's rare-gem
  // history. The committed copy restores it (only into an empty store; the cache stays fresher).
  try {
    const g = JSON.parse(fs.readFileSync(path.join(__dirname, 'gems.json'), 'utf8'));
    if (g && Array.isArray(g.gems)) store.primeGems(g.gems);
  } catch { /* not committed yet */ }

  // Same recovery for the 💸 deal feed: without it a cache eviction would publish an EMPTY
  // deals.json, erasing every previously-emailed deal from the dashboard in one sweep.
  try {
    const d = JSON.parse(fs.readFileSync(path.join(__dirname, 'deals.json'), 'utf8'));
    store.primeDeals(d);
  } catch { /* not committed yet */ }

  const client = makeClient({ token: config.token, userAgent: config.userAgent });
  const mailer = makeMailer(config.email);
  // Telegram = the redundant push channel: best-effort (a failure only logs — email keeps the
  // loud non-zero-exit guard) and sent INDEPENDENTLY of the email result, so a spam-foldered or
  // failed mail still buzzes the phone.
  const telegram = makeTelegram(config.telegram);
  const sliceSize = config.sliceSize || 50;

  // Deliverability guard: the Resend SANDBOX sender (onboarding@resend.dev) is testing-only — Resend
  // flags it as spam-prone and only delivers to your own verified address. For a tool whose whole
  // value is "an email arrives", a spam-foldered mail = silent total failure. Warn loudly here; the
  // real fix is verifying a sending domain in Resend (see README "Email deliverability").
  if (mailer.enabled && mailer.provider === 'resend' && /onboarding@resend\.dev/i.test(config.email.from || '')) {
    console.warn('⚠ Using the Resend SANDBOX sender (onboarding@resend.dev) — high spam risk. Verify a domain in Resend and set MAIL_FROM. See README.');
  }

  // Multi-sweep budget: 0/unset = one sweep and exit (the original model). With a budget (the
  // Actions workflow sets ~50 min), keep sweeping back-to-back — each sweep re-ranks, re-checks and
  // EMAILS — until the next sweep wouldn't fit. This is what turns GitHub's sparse cron ticks
  // (~1/hour in practice, despite the */15 request) into near-continuous coverage.
  const budgetMs = Math.max(0, parseFloat(process.env.RUN_BUDGET_MINUTES) || 0) * 60_000;
  const runStart = Date.now();
  const cur = readCursor();
  let sweepNo = 0;
  let lastSweepMs = 0;
  let emailError = null;
  let sweepError = null;

  async function deliver(ids = null, force = false) {
    const r = await flushPendingAlerts({ store, mailer, telegram, ids, force });
    if (r.emailSent) console.log(`Delivered ${r.emailSent} pending alert(s) by email.`);
    if (r.telegramSent) console.log(`Delivered ${r.telegramSent} pending alert(s) by Telegram.`);
    for (const e of r.emailErrors) { emailError = new Error(e.error); console.log(`Pending ${e.kind} email FAILED:`, e.error); }
    for (const e of r.telegramErrors) console.log(`Pending ${e.kind} Telegram push failed:`, e.error);
    return r;
  }
  // Retry detections left pending by an earlier provider outage or process restart.
  await deliver();

  for (;;) {
    sweepNo++;

    // Refresh the wantlist at most every wantlistRefreshMs (it changes rarely).
    if (!cur.wantlist || !cur.wantlist.length || Date.now() - (cur.wantlistAt || 0) > config.wantlistRefreshMs) {
      cur.wantlist = await client.getWantlist(config.username);
      cur.wantlistAt = Date.now();
      writeCursor(cur);
      console.log(`Refreshed wantlist: ${cur.wantlist.length} releases.`);
    }
    const N = cur.wantlist.length;
    if (!N) { console.log('Empty wantlist — nothing to do.'); writeCursor(cur); publishDeals(store, cur.wantlist); return; }

    const now = Date.now();
    const take = Math.min(sliceSize, N);
    // Priority sweep: rank every release by how urgently it deserves a re-check (staleness +
    // recent activity + rarity) and take the top `take`. This spends each sweep's API budget on the
    // releases most likely to surface a JUST-LISTED bargain, while staleness still guarantees full
    // coverage over time. (Replaces the old blind round-robin cursor.) In budget mode a small
    // recheck floor stops a tiny wantlist from being hammered back-to-back within one run.
    const minRecheckMs = config.minRecheckMs || (budgetMs > 0 ? 3 * 60_000 : 0);
    const ranked = cur.wantlist
      .map((rel) => ({ rel, score: engine.releaseWatchScore(store.getHistory(rel.releaseId), now, { recentMs: minRecheckMs }) }))
      .filter((x) => x.score >= 0)
      .sort((a, b) => b.score - a.score);
    if (!ranked.length && budgetMs > 0) {
      // Everything was checked within the recheck floor (small wantlist) — wait it out instead of
      // re-burning the API on releases we just saw, unless the budget is nearly spent anyway.
      if (Date.now() - runStart + 60_000 > budgetMs) break;
      await new Promise((r) => setTimeout(r, 60_000));
      continue;
    }
    const slice = (ranked.length ? ranked.map((x) => x.rel) : cur.wantlist).slice(0, take);
    writeCursor(cur); // persist the wantlist cache (selection no longer needs a cursor index)
    const sweepStart = Date.now();
    console.log(`[sweep ${sweepNo}] Checking the ${slice.length} highest-priority of ${N} (mode=${config.mode}, email=${mailer.enabled ? mailer.provider : 'off'}, telegram=${telegram.enabled ? 'on' : 'off'}).`);

    const deals = [];
    const dealPending = new Map();
    let gemCount = 0;
    let checked = 0;
    let failed = 0;
    const failureSamples = [];
    for (const rel of slice) {
      try {
        const { deal, gem, pending } = await processRelease(rel, { client, store, engine, config });
        if (deal) {
          deals.push(deal);
          const p = pending.find((item) => item.kind === 'deal');
          if (p) dealPending.set(deal.id, p.id);
        }
        if (gem) {
          gemCount++;
          console.log(`  GEM 💎 ${gem.artist} – ${gem.title}  first copy for sale at ${gem.currency} ${gem.lowest} (was 0 for sale)`);
          // 💎 Sent the MOMENT it's found — a truly rare copy can sell within the hour, so it must
          // not wait out the rest of a ~14-min sweep. Sent separately from the deals email so the
          // subject line screams the event. A send failure doesn't abort the sweep (the gem is
          // already saved for the dashboard); it fails the run loudly at the end instead.
          const gemIds = pending.filter((item) => item.kind === 'gem').map((item) => item.id);
          if (gemIds.length) await deliver(gemIds, true);
        }
        checked++;
      } catch (e) {
        failed++;
        if (failureSamples.length < 3) failureSamples.push(`${rel.releaseId}: ${e.message}`);
        console.log(`  release ${rel.releaseId} error: ${e.message}`);
      }
    }

    const coverage = take >= N ? 'Full wantlist every sweep.' : `Full wantlist covered every ~${Math.ceil(N / take)} sweeps.`;
    console.log(`[sweep ${sweepNo}] Checked ${checked}; failed ${failed}. Deals: ${deals.length}. Rare gems: ${gemCount}. (${coverage})`);

    // Lead with the strongest diamond: the email subject + first card come from deals[0], so order
    // best-first (just-listed + real-sold-price + biggest discount rank highest).
    deals.sort((a, b) => engine.dealValueScore(b) - engine.dealValueScore(a));

    if (deals.length) {
      for (const d of deals) console.log(`  DEAL${d.freshListing ? ' 🆕just-listed' : ''} ${d.artist} – ${d.title}  ${d.currency} ${d.lowest} (${Math.round(d.discount * 100)}% off${d.suspicious ? ', ⚠maybe<VG+' : ''})`);
      const ids = deals.map((d) => dealPending.get(d.id)).filter(Boolean);
      if (ids.length) await deliver(ids, true);
    }

    // Publish after every sweep so the committed files are as fresh as possible whenever the job
    // ends (the workflow commits once, after the last sweep).
    publishDeals(store, cur.wantlist);
    const health = assessSweepHealth(slice.length, checked, failed, failureSamples);
    if (!health.ok) { sweepError = new Error(health.message); break; }

    if (emailError) break; // stop sweeping — the loud non-zero exit below is the alert
    lastSweepMs = Date.now() - sweepStart;
    // Continue only if a next sweep (assumed ~as long as this one) still fits the budget.
    if (!budgetMs || Date.now() - runStart + lastSweepMs > budgetMs) break;
    console.log(`[sweep ${sweepNo}] took ${(lastSweepMs / 60_000).toFixed(1)} min — budget allows another sweep.`);
  }

  // Turn a silent email failure into a LOUD one: exit non-zero so the GitHub Actions step fails and
  // GitHub's built-in "your workflow failed" notification reaches you. For a tool whose core output IS
  // the email, a swallowed send error means you simply stop getting deals and never find out. The
  // deals are already saved to deals.json above, so the dashboard still updates regardless.
  if (emailError) throw new Error(`A deal/gem email failed to send: ${emailError.message}`);
  if (sweepError) throw sweepError;
}

// Write deals.json + gems.json (for the dashboard) + state-seed.json (durable warm-up/dedupe backup)
// at the repo root; the workflow commits all three. The seed is a tiny digest that's stable
// run-to-run once releases warm up, so it adds almost no git churn — but it lets a future run rebuild
// warm-up + dedupe if the Actions cache is ever evicted (the cache is the only other place that state
// lives). gems.json also carries the zero-stock WATCH list (wantlist releases with 0 copies for sale)
// so the dashboard's 💎 tab can show what's being waited on, not just what already appeared.
function stampLatestObservation(items, store, { markGone = false } = {}) {
  return items.map((item) => {
    const obs = store.lastObservation(item.releaseId);
    if (!obs || !(obs.ts > (item.ts || 0))) return item;
    const next = { ...item, current: { lowest: obs.lowest ?? null, numForSale: obs.numForSale ?? null, ts: obs.ts } };
    // A gem is a historical 0 -> first-copy event, but its card must describe whether a copy is
    // buyable NOW. Persist this in the cloud feed instead of relying only on the dashboard's
    // best-effort browser verification (which can be blocked by Cloudflare or overwritten on poll).
    if (markGone && typeof obs.numForSale === 'number') next.gone = obs.numForSale === 0;
    return next;
  });
}

function publishDeals(store, wantlist) {
  // Stamp each deal with the release's LATEST observation (already in the store — zero extra API
  // calls). A deal card is a moment-in-time alert; the best ones sell within hours, after which the
  // card shows a price that no longer exists. With `current` the dashboard can mark a deal whose
  // copy is gone (current lowest is above the alerted price, or nothing for sale) as "likely sold"
  // instead of silently advertising a dead price.
  const deals = stampLatestObservation(store.getDeals(200), store);
  fs.writeFileSync(path.join(__dirname, 'deals.json'), JSON.stringify(deals));
  try {
    const gems = stampLatestObservation(store.getGems(100), store, { markGone: true });
    fs.writeFileSync(path.join(__dirname, 'gems.json'), JSON.stringify({ ts: Date.now(), gems, zeroWatch: zeroWatch(store, wantlist) }));
  } catch (e) { console.log('Could not write gems.json:', e.message); }
  try { fs.writeFileSync(path.join(__dirname, 'state-seed.json'), JSON.stringify(store.exportSeed())); }
  catch (e) { console.log('Could not write state-seed.json:', e.message); }
}

module.exports = { main, publishDeals, assessSweepHealth, stampLatestObservation };

if (require.main === module && process.argv.includes('--selftest')) {
  const assert = require('assert');
  assert.ok(assessSweepHealth(50, 41, 9).ok, 'isolated API failures are tolerated');
  assert.ok(!assessSweepHealth(50, 40, 10).ok, '20% failures make the workflow fail loudly');
  assert.ok(!assessSweepHealth(2, 0, 2).ok, 'a sweep with zero successful checks is unhealthy');
  const fakeStore = { lastObservation: () => ({ ts: 200, lowest: null, numForSale: 0 }) };
  const [soldGem] = stampLatestObservation([{ releaseId: 457105, ts: 100, lowest: 79.99, numForSale: 1 }], fakeStore, { markGone: true });
  assert.strictEqual(soldGem.gone, true, 'a gem whose latest cloud observation is zero is marked gone');
  assert.deepStrictEqual(soldGem.current, { lowest: null, numForSale: 0, ts: 200 }, 'a gem carries its latest cloud observation');
  const relistedStore = { lastObservation: () => ({ ts: 300, lowest: 85, numForSale: 1 }) };
  const [relistedGem] = stampLatestObservation([{ ...soldGem, gone: true }], relistedStore, { markGone: true });
  assert.strictEqual(relistedGem.gone, false, 'a later relist clears the gone flag again');
  console.log('watch-once selftest: all assertions passed');
} else if (require.main === module) {
  main().catch((e) => { console.error('watch-once FAILED:', e.stack || e); process.exit(1); });
}

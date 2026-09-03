'use strict';
/*
 * One read-only Tradera REST v4 slice for GitHub Actions.
 *
 * Cloudflare dispatches watch.yml every 15 minutes. This short job rotates through a small wantlist
 * batch independently of the longer Discogs sweep. The first successful run is a warm-up: current
 * listings are learned without historical alerts. A persistent outbox makes Resend failures retryable.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeClient } = require('./discogs');
const { makeMailer, renderTraderaDealsEmail, renderTraderaGemsEmail } = require('./mailer');
const { loadConfig } = require('./watcher');
const { createTraderaService, safeTraderaUrl } = require('./dashboard/tradera/service');

const STATE_DIR = path.join(__dirname, 'state');
const STATE_FILE = path.join(STATE_DIR, 'tradera-state.json');
const OUTBOX_FILE = path.join(STATE_DIR, 'tradera-email-pending.json');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function loadOutbox(file = OUTBOX_FILE) {
  const value = readJson(file, {});
  const entries = Array.isArray(value.entries) ? value.entries : [];
  const deduped = new Map();
  for (const entry of entries) {
    if (!entry || !['deal', 'gem'].includes(entry.kind) || !entry.record || !entry.record.id) continue;
    deduped.set(`${entry.kind}:${entry.record.id}`, { kind: entry.kind, record: entry.record });
  }
  return { version: 1, entries: [...deduped.values()] };
}

function saveOutbox(outbox, file = OUTBOX_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ version: 1, entries: outbox.entries || [] })}\n`, { encoding: 'utf8', mode: 0o600 });
}

function notificationEligible(kind, record) {
  if (!record || record.platform !== 'tradera' || record.pressingVerified !== true) return false;
  if (kind === 'deal' && record.alertEligible !== true) return false;
  return !!safeTraderaUrl(record.url || record.listingUrl, record.listingId);
}

function enqueueNotifications(outbox, deals, gems) {
  const map = new Map((outbox.entries || []).map((entry) => [`${entry.kind}:${entry.record.id}`, entry]));
  for (const [kind, records] of [['deal', deals], ['gem', gems]]) {
    for (const record of Array.isArray(records) ? records : []) {
      if (notificationEligible(kind, record)) map.set(`${kind}:${record.id}`, { kind, record });
    }
  }
  outbox.entries = [...map.values()];
  return outbox;
}

async function flushOutbox(outbox, mailer, file = OUTBOX_FILE) {
  const sendKind = async (kind, renderer) => {
    const selected = outbox.entries.filter((entry) => entry.kind === kind);
    if (!selected.length) return 0;
    await mailer.send(renderer(selected.map((entry) => entry.record)));
    const sent = new Set(selected.map((entry) => `${entry.kind}:${entry.record.id}`));
    outbox.entries = outbox.entries.filter((entry) => !sent.has(`${entry.kind}:${entry.record.id}`));
    saveOutbox(outbox, file);
    return selected.length;
  };
  const deals = await sendKind('deal', renderTraderaDealsEmail);
  const gems = await sendKind('gem', renderTraderaGemsEmail);
  return { deals, gems };
}

function cloudSettings(env = process.env) {
  return {
    traderaEnabled: false,
    traderaBatchSize: Number(env.TRADERA_BATCH_SIZE) || 10,
  };
}

function wasWarmedUp(stateFile = STATE_FILE) {
  const state = readJson(stateFile, {});
  return !!(state.health && state.health.lastPollAt);
}

function readMedians(file = path.join(__dirname, 'soldmedians.json')) {
  const value = readJson(file, {});
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

async function main() {
  const appId = String(process.env.TRADERA_APP_ID || '').trim();
  const appKey = String(process.env.TRADERA_APP_KEY || '').trim();
  if (!appId || !appKey) {
    console.log('Tradera cloud email skipped: add TRADERA_APP_ID and TRADERA_APP_KEY GitHub Secrets to enable it.');
    return;
  }

  const config = loadConfig();
  if (!config.username || !config.token) throw new Error('Tradera cloud matching needs DISCOGS_USERNAME and DISCOGS_TOKEN.');
  const mailer = makeMailer(config.email);
  if (!mailer.enabled) throw new Error('Tradera cloud matching is configured, but email is not: add RESEND_API_KEY and MAIL_TO.');

  fs.mkdirSync(STATE_DIR, { recursive: true });
  const warm = wasWarmedUp();
  const outbox = loadOutbox();
  const retried = await flushOutbox(outbox, mailer);
  if (retried.deals || retried.gems) console.log(`Retried ${retried.deals} Tradera deal email item(s) and ${retried.gems} rare-find item(s).`);

  const discogs = makeClient({ token: config.token, userAgent: config.userAgent });
  let settings = cloudSettings();
  const service = createTraderaService({
    stateFile: STATE_FILE,
    readSettings: () => settings,
    writeSettings: (patch) => { settings = { ...settings, ...patch }; },
    readConfig: () => config,
    loadWantlist: () => discogs.getWantlist(config.username),
    loadMedians: () => readMedians(),
    loadReleaseMetadata: (releaseId) => discogs.getRelease(releaseId),
    getCredentials: () => ({ appId, appKey }),
  });

  const result = await service.runOnce({ all: false });
  const deals = Array.isArray(result.newDeals) ? result.newDeals : [];
  const gems = Array.isArray(result.newGems) ? result.newGems : [];
  if (!warm) {
    console.log(`Tradera warm-up complete: learned ${deals.length} existing deal(s) and ${gems.length} existing rare-find transition(s); no historical email sent.`);
    return;
  }

  enqueueNotifications(outbox, deals, gems);
  saveOutbox(outbox);
  const sent = await flushOutbox(outbox, mailer);
  console.log(`Tradera slice complete: ${result.runStats.checked} wantlist target(s), ${sent.deals} new deal email item(s), ${sent.gems} rare-find email item(s).`);
}

async function selftest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deal-shark-tradera-mail-'));
  const file = path.join(dir, 'outbox.json');
  const record = {
    id: 'tradera:1', listingId: '1', platform: 'tradera', pressingVerified: true, alertEligible: true,
    artist: 'A', title: 'B', itemPrice: 10, nativeItemPrice: 110, nativeCurrency: 'SEK',
    shipping: null, shippingEstimate: 5, currency: 'EUR', reference: 40,
    discount: 0.625, url: 'https://www.tradera.com/item/1',
  };
  const rejected = { ...record, id: 'tradera:2', listingId: '2', pressingVerified: false };
  const outbox = enqueueNotifications({ version: 1, entries: [] }, [record, rejected], []);
  enqueueNotifications(outbox, [record], []);
  assert.strictEqual(outbox.entries.length, 1, 'only strict records are queued and duplicates collapse');
  saveOutbox(outbox, file);
  assert.strictEqual(loadOutbox(file).entries.length, 1, 'outbox survives a process restart');

  let attempts = 0;
  const failingMailer = { async send() { attempts += 1; throw new Error('temporary'); } };
  await assert.rejects(() => flushOutbox(loadOutbox(file), failingMailer, file), /temporary/);
  assert.strictEqual(loadOutbox(file).entries.length, 1, 'a failed send stays queued');
  const sentSubjects = [];
  const goodMailer = { async send(mail) { sentSubjects.push(mail.subject); } };
  await flushOutbox(loadOutbox(file), goodMailer, file);
  assert.strictEqual(loadOutbox(file).entries.length, 0, 'a successful send clears the queue');
  assert.ok(sentSubjects[0].includes('Tradera deal'), 'the queue uses the Tradera renderer');

  const stateFile = path.join(dir, 'state.json');
  assert.strictEqual(wasWarmedUp(stateFile), false, 'missing state is a warm-up run');
  fs.writeFileSync(stateFile, JSON.stringify({ health: { lastPollAt: 123 } }));
  assert.strictEqual(wasWarmedUp(stateFile), true, 'a prior completed scan enables new-listing email');
  assert.strictEqual(cloudSettings({ TRADERA_BATCH_SIZE: '12' }).traderaEnabled, false, 'cloud scan cannot leave a background timer');
  assert.strictEqual(attempts, 1);
  console.log('watch-tradera-once selftest: OK');
}

module.exports = { loadOutbox, saveOutbox, notificationEligible, enqueueNotifications, flushOutbox, cloudSettings, wasWarmedUp, readMedians };

if (require.main === module) {
  const run = process.argv.includes('--selftest') ? selftest : main;
  run().catch((error) => { console.error(error && error.stack || error); process.exitCode = 1; });
}

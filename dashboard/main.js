'use strict';
/*
 * main.js — Electron main process for the Discogs Deal dashboard.
 *
 * Two ways to get deals:
 *   1. PASSIVE (default) — read the deals the cloud watcher already found:
 *        • GitHub Actions: read the committed deals.json (public repo: raw CDN, no token).
 *        • Live server:    watcher.js's token-protected /api/* endpoints.
 *      Can read a configured GitHub repository without exposing its token to the renderer.
 *   2. ACTIVE — the "Scan now" button runs a full local sweep of the whole wantlist right here
 *      (using the watcher's own engine + your local config.json token) and shows every current
 *      bargain immediately. See runScrape().
 *
 * All network I/O lives in this main process (Node fetch), so tokens never reach the renderer
 * and there are no CORS concerns. The renderer talks to us over IPC (see preload.js).
 */

const { app, BrowserWindow, ipcMain, shell, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { scanMinDiscount, parseMoney, evaluateScanPreliminary } = require('./scan-policy');
const { filterRealMedians } = require('./git-policy');
const { makeMedianPublisher } = require('./median-publisher');
const { dedupeGems, cloudBusyFromRun, estimateScanEta } = require('./runtime-policy');
const { makeListingHistory } = require('./listing-history');
const { normalizeScoutOptions, normalizeSearchResult, suggestionSnapshot, scoutScore, sortScoutResults } = require('./scout-policy');
const { normalizeCityDigOptions, looksLikeVinyl, normalizeInventoryListing, matchTaxonomies } = require('./city-dig-policy');
const { CITY_DIG_CITIES } = require('./city-dig-data');

// Preserve settings for users upgrading from Deal Watcher. Electron derives a new user-data folder
// from productName; switching blindly would make an upgraded app look like a clean install. Fresh
// installs use the new Deal Shark folder, while an existing legacy profile remains authoritative.
const DEFAULT_USER_DATA_DIR = app.getPath('userData');
const APP_DATA_DIR = app.getPath('appData');
const LEGACY_USER_DATA_DIRS = app.isPackaged
  ? [path.join(APP_DATA_DIR, 'Discogs Deal Watcher')]
  : [path.join(APP_DATA_DIR, 'discogs-deal-dashboard'), path.join(APP_DATA_DIR, 'Electron')];
const PROFILE_MARKERS = ['settings.json', 'config.json', 'last-scan.json', 'last-scout.json', 'last-city-dig.json', 'push-status.json', 'state'];
function hasDashboardProfile(directory) {
  return PROFILE_MARKERS.some((name) => fs.existsSync(path.join(directory, name)));
}
if (!hasDashboardProfile(DEFAULT_USER_DATA_DIR)) {
  const legacyProfile = LEGACY_USER_DATA_DIRS.find(hasDashboardProfile);
  if (legacyProfile) app.setPath('userData', legacyProfile);
}

// Where the watcher's pure modules (engine/discogs/store/watcher.js) live:
//   • dev run  — one level up, in the project checkout.
//   • packaged — bundled into the app's resources/ via electron-builder extraResources.
const WATCHER_DIR = app.isPackaged
  ? path.join(process.resourcesPath, 'watcher')
  : path.join(__dirname, '..');

// Where the USER's own data lives — config.json (Discogs creds), the state/ cache, sold-medians:
//   • dev run  — the project folder (shared with the cloud watcher; the soldmedians git push works).
//   • packaged — the OS per-user app-data dir (Program Files is read-only). The first-run setup
//     wizard writes config.json there. Computed lazily because app.getPath needs the app ready.
function dataDir() { return app.isPackaged ? app.getPath('userData') : WATCHER_DIR; }
function configPath() { return path.join(dataDir(), 'config.json'); }
function stateDir() { return path.join(dataDir(), 'state'); }

// Exact per-copy history is a dashboard enhancement. If its separate cache is corrupt/unwritable,
// scans still run normally; the core deal state and notifications must never depend on this UI data.
let listingHistoryStore = null;
let listingHistoryDisabled = false;
function observeListings(releaseId, listings, totalCount, ts = Date.now()) {
  if (listingHistoryDisabled || !Array.isArray(listings)) return {};
  try {
    if (!listingHistoryStore) listingHistoryStore = makeListingHistory(stateDir());
    const complete = totalCount != null && Number.isFinite(Number(totalCount)) && Number(totalCount) <= listings.length;
    return listingHistoryStore.observeRelease(releaseId, listings, { ts, complete });
  } catch (error) {
    listingHistoryDisabled = true;
    console.warn('Listing history disabled for this session:', error.message || error);
    return {};
  }
}

const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'settings.json');
// Defaults for a fresh, shareable install: no cloud is configured, so the LOCAL SCAN is the deal
// source out of the box (it works with just a Discogs token — no GitHub/server needed). Anyone
// running their own cloud watcher can point this at their repo/server in Settings.
const DEFAULT_SETTINGS = {
  sourceType: 'scan',        // 'scan' (local, default) | 'github' | 'server'
  githubRepo: '',
  githubBranch: 'main',
  githubToken: '',
  apiBase: '',
  token: '',
  autoPushMedians: true, // dev/owner only: after a scan, commit+push soldmedians.json for the cloud
  autoScanOnLaunchHours: 1, // re-scan while the app is open whenever the last scan is older than this many hours (also gates the launch scan). 0 = off
};

function readSettings() {
  try {
    const settings = { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE(), 'utf8')) };
    if (String(settings.githubRepo).toLowerCase() === 'norsnors/discogs-deal-watcher') {
      settings.githubRepo = 'norsnors/discogs-deal-shark';
    }
    return settings;
  }
  catch { return { ...DEFAULT_SETTINGS }; }
}
function writeSettings(s) {
  fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(s, null, 2));
}

function withTimeout(ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, done: () => clearTimeout(t) };
}

// The last push outcome, PERSISTED — a failed push used to flash in the scan-status line for a few
// seconds and vanish, while the cloud silently kept judging deals against stale references for
// weeks. The topbar badge reads this file so a failure stays visible until a push succeeds.
const PUSH_STATUS_FILE = () => path.join(app.getPath('userData'), 'push-status.json');
function readPushStatus() { try { return JSON.parse(fs.readFileSync(PUSH_STATUS_FILE(), 'utf8')); } catch { return null; } }
function writePushStatus(st) { try { fs.writeFileSync(PUSH_STATUS_FILE(), JSON.stringify(st)); } catch { /* best effort */ } }

// Publish from a detached temporary worktree based on the latest origin/main. This guarantees the
// dashboard can commit ONLY soldmedians.json: the developer's current branch, staged files and local
// code commits are never touched or pushed. Per-release timestamps merge concurrent cloud/local data.
let medianPublisher = null;
function localRealMedians() {
  try { return filterRealMedians(JSON.parse(fs.readFileSync(path.join(stateDir(), 'soldmedians.json'), 'utf8'))); }
  catch { return {}; }
}
async function autoPushSoldMedians(input = null) {
  try {
    const medians = input || localRealMedians();
    if (!medianPublisher) medianPublisher = makeMedianPublisher({ repoDir: WATCHER_DIR });
    return await medianPublisher.publish(medians);
  } catch (e) {
    const msg = (e && (e.stderr || e.message)) ? String(e.stderr || e.message) : String(e);
    const firstLine = msg.split('\n').map((l) => l.trim()).find(Boolean) || 'git failed';
    return { ok: false, pushed: false, reason: firstLine.slice(0, 200) };
  }
}

// Live-server mode (watcher.js on Fly/locally): token-protected /api/* endpoints.
async function serverGet(s, pathname) {
  const base = (s.apiBase || '').replace(/\/+$/, '');
  if (!base) throw new Error('No server URL set — open Settings.');
  const to = withTimeout(12_000);
  try {
    const res = await fetch(base + pathname, { headers: s.token ? { authorization: 'Bearer ' + s.token } : {}, signal: to.signal });
    if (res.status === 401) throw new Error('Unauthorized — check the dashboard token in Settings.');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally { to.done(); }
}

// GitHub mode (watch-once.js via Actions): read a committed JSON file (deals.json / gems.json).
//  - public repo (no token): raw CDN — no auth, no 60-req/hour API limit.
//  - private repo (token):   authenticated Contents API.
// Returns null when the file isn't committed yet (nothing found so far).
async function githubFile(s, name) {
  const repo = (s.githubRepo || '').trim().replace(/^https?:\/\/github\.com\//, '').replace(/\/+$/, '');
  if (!repo) throw new Error('No GitHub repo (owner/name) set — open Settings.');
  const branch = (s.githubBranch || 'main').trim();
  const to = withTimeout(12_000);
  try {
    let res;
    if (s.githubToken) {
      res = await fetch(`https://api.github.com/repos/${repo}/contents/${name}?ref=${branch}`, {
        headers: { Accept: 'application/vnd.github.raw', authorization: 'Bearer ' + s.githubToken },
        signal: to.signal,
      });
    } else {
      res = await fetch(`https://raw.githubusercontent.com/${repo}/${branch}/${name}?t=${Date.now()}`, {
        cache: 'no-store', signal: to.signal,
      });
    }
    if (res.status === 404) return null; // not committed yet
    if (res.status === 401 || res.status === 403) throw new Error('GitHub auth failed — check the access token in Settings.');
    if (!res.ok) throw new Error('GitHub HTTP ' + res.status);
    return await res.json();
  } finally { to.done(); }
}
const githubDeals = async (s) => (await githubFile(s, 'deals.json')) || [];

async function getDeals(limit) {
  const s = readSettings();
  const src = s.sourceType || 'scan';
  if (src === 'server') return serverGet(s, '/api/deals?limit=' + (limit || 200));
  if (src === 'github') return githubDeals(s);
  // 'scan' (default for a fresh install): no cloud — show whatever the last local scan found.
  const last = lastScan();
  return (last && Array.isArray(last.deals)) ? last.deals : [];
}
async function getStatus() {
  const s = readSettings();
  const src = s.sourceType || 'scan';
  if (src === 'server') return serverGet(s, '/api/status');
  if (src === 'github') return { sourceType: 'github', repo: s.githubRepo };
  const last = lastScan();
  return { sourceType: 'scan', wantlistSize: (last && last.wantlistTotal != null) ? last.wantlistTotal : '—' };
}

// 💎 Rare gems (0-for-sale -> first copy) + the zero-stock watch list, for the dashboard's Rare tab.
// Shape everywhere: { ts, gems: [...], zeroWatch: [...] }.
//   • github — the committed gems.json (written by watch-once.js next to deals.json).
//   • server — the live /api/gems endpoint.
//   • scan   — the LOCAL store's accumulated gems (state/gems.json, appended by runScrape) + the
//              zero-stock watch list saved with the last scan.
async function getGems() {
  const s = readSettings();
  const src = s.sourceType || 'scan';
  if (src === 'server') {
    const r = await serverGet(s, '/api/gems?limit=100');
    if (r && Array.isArray(r.gems)) r.gems = dedupeGems(r.gems);
    return r;
  }
  if (src === 'github') {
    const g = await githubFile(s, 'gems.json');
    return g && typeof g === 'object' ? { ts: g.ts || null, gems: dedupeGems(g.gems), zeroWatch: g.zeroWatch || [] } : { ts: null, gems: [], zeroWatch: [] };
  }
  let gems = [];
  try { gems = dedupeGems(JSON.parse(fs.readFileSync(path.join(stateDir(), 'gems.json'), 'utf8'))).slice(0, 100); } catch { /* no gems yet */ }
  // Retro-enrich: a gem stores the recent-sales list known at DETECTION time, which is null for
  // anything detected before the Discogs login was done (or while the median sat in the weekly
  // cache without a sales list). Join the CURRENT store's sales onto each card so old gems light
  // up as soon as a later scan has read the sales-history page.
  try {
    const sm = JSON.parse(fs.readFileSync(path.join(stateDir(), 'soldmedians.json'), 'utf8'));
    gems = gems.map((g) => {
      const e = sm[g.releaseId];
      if (e && Array.isArray(e.sales) && e.sales.length && !(Array.isArray(g.recentSales) && g.recentSales.length)) {
        return { ...g, recentSales: e.sales };
      }
      return g;
    });
  } catch { /* no medians yet */ }
  // "No longer listed" from the SCAN's own observation history: if the latest observation for a
  // gem's release counts 0 for sale (recorded after the gem fired), the copy is gone — mark it
  // here so the card shows it ALWAYS, not only when the best-effort live verify happens to
  // succeed (a Cloudflare hiccup used to leave a sold gem posing as buyable). The live verify
  // can still overrule in both directions with fresher data (a relist un-marks it).
  try {
    const hist = JSON.parse(fs.readFileSync(path.join(stateDir(), 'history.json'), 'utf8'));
    gems = gems.map((g) => {
      const obs = hist[g.releaseId];
      const latest = Array.isArray(obs) && obs.length ? obs[obs.length - 1] : null;
      if (latest && latest.numForSale === 0 && latest.ts > (g.ts || 0)) return { ...g, gone: true };
      return g;
    });
  } catch { /* no history yet */ }
  const last = lastScan();
  return { ts: last ? last.ts : null, gems, zeroWatch: (last && last.zeroWatch) || [] };
}

// ---------------------------------------------------------------------------
// Service health — "is the cloud watcher actually RUNNING right now?"
// ---------------------------------------------------------------------------
// getStatus()/getDeals() only confirm the SOURCE is reachable (the raw CDN can hand back a
// deals.json that's days stale and look perfectly "connected"). This is the real heartbeat:
//   • GitHub mode — query the Actions runs API for the last scheduled sweep: when it fired and
//     whether it succeeded. A 'failure' conclusion is meaningful — watch-once.js exits non-zero
//     precisely when the deal EMAIL fails to send (the product), so a red badge = "you've stopped
//     getting deal mails". Works unauthenticated on the public repo (deals.json comes from the raw
//     CDN, a different host, so this is the only api.github.com traffic — polled slowly to stay
//     under the 60-req/hr unauthenticated limit).
//   • Server mode — read the live /api/status sweep timestamp.
const CRON_WORKFLOW = 'watch.yml'; // the sweep workflow file — health/cron info reads THIS workflow's runs only

// Which GitHub repo hosts the cloud cron? Settings (github mode) first; failing that, a dev/owner
// run can derive it from the local checkout's origin remote (the dashboard lives inside the watcher
// repo) — that's what lets the cron pill work in the default local-scan mode with zero setup.
let repoFromGit; // undefined = not probed yet; null = probed, none found
async function cronRepo(s) {
  const set = (s.githubRepo || '').trim().replace(/^https?:\/\/github\.com\//, '').replace(/\/+$/, '');
  if (set) return set;
  if (repoFromGit !== undefined) return repoFromGit;
  if (app.isPackaged) { repoFromGit = null; return null; } // packaged installs have no checkout/remote
  try {
    const url = await git(['remote', 'get-url', 'origin'], 10_000);
    const m = String(url).match(/github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?$/);
    repoFromGit = m ? m[1] : null;
  } catch { repoFromGit = null; }
  return repoFromGit;
}

async function githubHealth(s) {
  const repo = (s.githubRepo || '').trim().replace(/^https?:\/\/github\.com\//, '').replace(/\/+$/, '');
  if (!repo) throw new Error('No GitHub repo (owner/name) set — open Settings.');
  const to = withTimeout(12_000);
  try {
    const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    if (s.githubToken) headers.authorization = 'Bearer ' + s.githubToken;
    // Scoped to the sweep workflow's runs (a build-mac run can't shadow the heartbeat), and a few of
    // them: the extra runs feed the cron pill's fire history + real-cadence estimate at no extra
    // request cost (still ONE api.github.com call per poll). Fetch extra (15) because we drop the
    // 'cancelled' runs below and still want ~6 real ones to show.
    const res = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/${CRON_WORKFLOW}/runs?per_page=15`, { headers, signal: to.signal });
    // 403/429 with no remaining budget = the unauthenticated rate limit, NOT a real outage — say so
    // so the UI keeps the last-known state instead of falsely flipping to "down".
    if (res.status === 403 || res.status === 429) {
      const remaining = res.headers.get('x-ratelimit-remaining');
      if (remaining === '0' || !s.githubToken) return { mode: 'github', repo, ok: false, rateLimited: true };
    }
    if (res.status === 404) return { mode: 'github', repo, ok: false, notFound: true };
    if (res.status === 401) throw new Error('GitHub auth failed — check the access token in Settings.');
    if (!res.ok) throw new Error('GitHub HTTP ' + res.status);
    const j = await res.json();
    const mapRun = (run) => ({
      startedAt: Date.parse(run.run_started_at || run.created_at) || null,
      updatedAt: Date.parse(run.updated_at) || null,
      status: run.status,         // queued | in_progress | completed
      conclusion: run.conclusion, // success | failure | cancelled | null (while running)
      url: run.html_url,
      runNumber: run.run_number,
      event: run.event,           // schedule | workflow_dispatch | ...
    });
    // Drop 'cancelled' runs: these are Worker pokes (workflow_dispatch) that queued behind a live
    // budget run and got bumped by the next poke without ever executing — real churn, but they did
    // NO work (no sweep, no email), so surfacing them as "recent runs" just looks alarming. The
    // heartbeat + tooltip + cadence should reflect runs that actually ran (or are running).
    const runs = (j.workflow_runs || []).map(mapRun).filter((r) => r.conclusion !== 'cancelled');
    return { mode: 'github', repo, ok: true, run: runs[0] || null, recent: runs };
  } finally { to.done(); }
}

async function getServiceHealth() {
  const s = readSettings();
  const src = s.sourceType || 'scan';
  if (src === 'scan') {
    // Local-scan mode: the "service" is your own ⚡ Scan now — but the OWNER's cloud cron still
    // exists next door, so when a repo is derivable (settings, or the checkout's git remote) the
    // cron heartbeat rides along for the topbar's cron pill. Best-effort: no repo / no network →
    // plain local health, exactly as before.
    const last = lastScan();
    const out = { mode: 'local', ok: true, lastScanAt: (last && last.ts) ? last.ts : null };
    try {
      const repo = await cronRepo(s);
      if (repo) out.cron = await githubHealth({ ...s, githubRepo: repo });
    } catch { /* cron info is a bonus, never a failure */ }
    return out;
  }
  if (src === 'server') {
    try { return { mode: 'server', ok: true, apiBase: s.apiBase, status: await serverGet(s, '/api/status') }; }
    catch (e) { return { mode: 'server', ok: false, apiBase: s.apiBase, error: e.message }; }
  }
  try { return await githubHealth(s); }
  catch (e) { return { mode: 'github', ok: false, repo: s.githubRepo, error: e.message }; }
}

// Is the cloud sweep (GitHub Actions watch.yml) running RIGHT NOW? Load-bearing for the local
// scan: Discogs meters the API budget PER TOKEN (verified live 2026-07-18 — with the dashboard
// fully idle, the token's used-counter sat at ~53/min while a cloud budget run swept from GitHub's
// datacenter IP). The cloud run and a local scan therefore share ONE 60/min budget; running both
// concurrently makes each see remaining<=1 and 429s, and both crawl at a handful of calls per
// minute (a 13-min scan balloons to hours — seen live). So runScrape postpones a scan while a
// cloud run is active instead of fighting it. Fail-OPEN: any error (offline, GitHub rate limit,
// no repo derivable) returns null and the scan just runs — same spirit as the cron Worker.
async function cloudScanActive() {
  try {
    const s = readSettings();
    const repo = await cronRepo(s);
    if (!repo) return null;
    const h = await githubHealth({ ...s, githubRepo: repo });
    const run = h && h.ok ? h.run : null;
    return cloudBusyFromRun(run);
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// "Scan now" — a full local sweep of the entire wantlist, on demand.
// ---------------------------------------------------------------------------
// Reuses the watcher's own pure modules (engine + discogs client + store) and your local
// config.json (the Discogs token). Unlike the cloud watcher's paced, warm-up-gated alerting,
// this is a deliberate "show me everything cheap right now" scan: it lists EVERY release whose
// cheapest copy currently sits >= minDiscount under its VG+ suggested price (or its own usual
// lowest). No email, no warm-up, no new-low dedupe. Cancellable; emits progress to the renderer.
let scrapeAbort = false;
let scrapeRunning = false;
let scoutAbort = false;
let scoutRunning = false;
let cityDigAbort = false;
let cityDigRunning = false;
const SUGGESTION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RELEASE_META_TTL_MS = 180 * 24 * 60 * 60 * 1000;
const RARE_COOLDOWN_MS = 12 * 60 * 60 * 1000; // per-release cooldown between rare-gem alerts (mirrors the cloud watcher)
const QUICK_SCAN_SIZE = 250; // a quick scan checks only the top-N highest-priority releases (by watch-score)
const LAST_SCAN_FILE = () => path.join(app.getPath('userData'), 'last-scan.json');

function loadWatcher() {
  // Pure, dependency-light modules from the watcher project. Wrapped so a packaged build that
  // can't see ../ fails with a clear message instead of a cryptic require error.
  try {
    return {
      engine: require(path.join(WATCHER_DIR, 'engine.js')),
      makeClient: require(path.join(WATCHER_DIR, 'discogs.js')).makeClient,
      makeStore: require(path.join(WATCHER_DIR, 'store.js')).makeStore,
      loadConfig: require(path.join(WATCHER_DIR, 'watcher.js')).loadConfig,
    };
  } catch (e) {
    // Packaged builds bundle these into resources/watcher (see electron-builder extraResources); a
    // dev run reads them from the project one level up. Either way, a failure here is a broken install.
    throw new Error('Could not load the watcher engine (' + WATCHER_DIR + '). Reinstall the app. ' + e.message);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DISCOGS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// In-page extractor: pull the "Last Sold / Low / Median / High" sales-history block off the
// release page. Discogs renders it in plain text once Cloudflare clears (verified live).
// FALLBACK ONLY (see SALES_HISTORY_EXTRACT below, the preferred source) — kept so median/low/high
// still work anonymously for anyone who hasn't done the one-time Discogs login.
const SOLD_EXTRACT = `(() => {
  const t = document.body ? document.body.innerText : '';
  const g = (re) => { const m = t.match(re); return m ? m[1] : null; };
  return {
    median: g(/Median:\\s*[^\\d-]{0,4}([\\d.,]+)/i),
    low: g(/Low:\\s*[^\\d-]{0,4}([\\d.,]+)/i),
    high: g(/High:\\s*[^\\d-]{0,4}([\\d.,]+)/i),
    lastSold: g(/Last Sold:\\s*([^\\n\\t]+)/i),
    challenged: /just a moment|checking your browser|enable javascript/i.test((document.title || '') + ' ' + t.slice(0, 300)),
    len: t.length,
  };
})()`;

const SALES_HISTORY_URL = (releaseId) => `https://www.discogs.com/sell/history/${Number(releaseId)}`;

// Sales History page (/sell/history/{id}): the SAME aggregate Median/Low/High/Last-Sold stats AND
// the full per-sale table (date, condition, price) in one navigation — strictly better than the old
// release-page scrape above, because it also gives the sale-by-sale list the rare-gem display wants
// (a much better value signal for a rare/appreciating record than one blended median). BUT it
// requires being logged in to Discogs — an anonymous request redirects to login.discogs.com
// (verified live 2026-07-13). The hidden cfWin uses Electron's default (persistent, no explicit
// partition) session — the SAME session the one-time "Log in to Discogs" window uses (see
// startDiscogsLogin) — so once the user logs in once, this works from then on with no further
// action; until then loadReleaseData falls back to SOLD_EXTRACT (median only, no login needed).
// Table markup verified live: `tr.sales-history-row` per sale, with `td[data-header="Order Date:"]`
// (ISO yyyy-mm-dd), `td[data-header="Media:"]`, and `td.price` — the price in the ACCOUNT's
// currency, NOT `td.converted_price` (the seller's native listing currency, which varies row to
// row, e.g. CHF/USD) — using the account-currency column keeps every sale directly comparable
// without doing our own FX conversion. If Discogs changes this markup, the symptom is every gem
// falling back to the old median-only display; recheck the selectors here.
const SALES_HISTORY_EXTRACT = `(() => {
  const t = document.body ? document.body.innerText : '';
  const g = (re) => { const m = t.match(re); return m ? m[1] : null; };
  const rows = [...document.querySelectorAll('tr.sales-history-row')];
  const sales = rows.map((tr) => {
    const dateEl = tr.querySelector('td[data-header="Order Date:"]');
    const mediaEl = tr.querySelector('td[data-header="Media:"]');
    const priceEl = tr.querySelector('td.price');
    return {
      date: dateEl ? dateEl.textContent.trim() : null,
      media: mediaEl ? mediaEl.textContent.trim() : null,
      priceText: priceEl ? priceEl.textContent.trim() : null,
    };
  }).filter((s) => s.date && s.priceText);
  return {
    median: g(/([\\d.,]+)\\s*Median\\b/i),
    low: g(/([\\d.,]+)\\s*Low\\b/i),
    high: g(/([\\d.,]+)\\s*High\\b/i),
    lastSold: g(/Last sold on\\s*([^\\n\\t]+)/i),
    sales,
    loginRequired: /login\\.discogs\\.com/.test(location.href),
    challenged: /just a moment|checking your browser|enable javascript/i.test((document.title || '') + ' ' + t.slice(0, 300)),
    len: t.length,
  };
})()`;

// Map one raw sell_item JSON copy to our trimmed shape. Defined ONCE and embedded into both the
// in-page fetch and the fallback body-parse extractors below, so the two can never drift apart.
//
// Shipping from the JSON: a copy carries `shipping.shippingPrice` (seller base rate) and
// `shipping.buyerShippingPrice` (what WE pay to ship to our location). We prefer the buyer price,
// fall back to the base rate, and honour a single-item free-shipping threshold. **BUT, verified
// live (June 2026): for an ANONYMOUS request the entire `shipping` object — and the buyer* price
// fields — come back null** (Discogs only computes buyer shipping for a known/logged-in
// destination). That's why every scanned copy used to show the €5 estimate. The REAL shipping is
// instead joined on by itemId from the rendered marketplace page (see SHIP_EXTRACT below), which
// DOES show IP-geolocated shipping to us anonymously. This mapping is kept (correct + free when a
// session ever IS logged in), but in practice `shippingSource` here is null and the page provides
// the number. `shippingSource`: 'buyer'|'base'|null (the page join later sets 'page').
const MAP_SELL_ITEM = `(it) => {
  const sh = it.shipping || {};
  const p = it.price || {};
  const amount = (p.amount != null) ? p.amount : null;
  let shipping = (sh.buyerShippingPrice != null) ? sh.buyerShippingPrice
    : ((sh.shippingPrice != null) ? sh.shippingPrice : null);
  const shippingSource = (sh.buyerShippingPrice != null) ? 'buyer'
    : ((sh.shippingPrice != null) ? 'base' : null);
  if (shipping != null && sh.freeShippingMin != null && amount != null && amount >= sh.freeShippingMin) shipping = 0;
  return {
    itemId: it.itemId || null,
    media: it.mediaCondition || null,
    sleeve: it.sleeveCondition || null,
    price: amount,
    currency: p.currencyCode || null,
    shipping: shipping,
    shippingSource: shippingSource,
    shipsFrom: it.seller ? it.seller.shipsFrom : null,
    sellerRating: it.seller ? it.seller.rating : null,
    allowsOffers: !!it.allowsOffers,
  };
}`;

// In-page fetch of the REAL per-copy marketplace listings. The modern Discogs marketplace is
// backed by a clean JSON endpoint (/api/shop-page-api/sell_item) that returns each copy's exact
// media + sleeve condition, price and shipping — the data the official API hides. We run this
// fetch INSIDE the Cloudflare-cleared window (same-origin + cf_clearance cookie), so it succeeds
// where a plain cloud/datacenter fetch would 403. Far more robust than scraping listing HTML.
const LISTINGS_FETCH = (releaseId, currency) => `(async () => {
  try {
    const u = 'https://www.discogs.com/api/shop-page-api/sell_item?release=' + ${Number(releaseId)}
      + '&sort=price&sortOrder=ascending&count=100&offset=0&currency=' + ${JSON.stringify(String(currency || 'EUR'))};
    const res = await fetch(u, { headers: { Accept: 'application/json' }, credentials: 'include' });
    if (!res.ok) return { error: 'http_' + res.status };
    const ct = res.headers.get('content-type') || '';
    if (!/json/i.test(ct)) return { error: 'not_json' }; // Cloudflare HTML challenge, not the API
    const j = await res.json();
    const items = (j.items || []).map(${MAP_SELL_ITEM});
    return { items: items, totalCount: (j.totalCount != null ? j.totalCount : items.length) };
  } catch (e) { return { error: String((e && e.message) || e) }; }
})()`;

// The same listings endpoint as a plain URL — for the FALLBACK strategy: navigate the window
// straight to it and read the JSON body (the exact flow proven by the public Discogs scraper —
// a direct GET of this URL returns JSON once cf_clearance is set). Robust if the in-page fetch is
// ever blocked (e.g. a stricter CSP/referer check) while a top-level navigation still works.
const SELL_ITEM_URL = (releaseId, currency) =>
  `https://www.discogs.com/api/shop-page-api/sell_item?release=${Number(releaseId)}&sort=price&sortOrder=ascending&count=100&offset=0&currency=${encodeURIComponent(String(currency || 'EUR'))}`;

// Read + parse the JSON body of the sell_item endpoint after navigating to it directly.
const PARSE_BODY = `(() => {
  try {
    const t = document.body ? document.body.innerText : '';
    if (/just a moment|checking your browser|enable javascript/i.test((document.title || '') + ' ' + t.slice(0, 300))) return { error: 'cloudflare' };
    const j = JSON.parse(t);
    const items = (j.items || []).map(${MAP_SELL_ITEM});
    return { items: items, totalCount: (j.totalCount != null ? j.totalCount : items.length) };
  } catch (e) { return { error: 'parse_' + String((e && e.message) || e) }; }
})()`;

// The classic marketplace page (/sell/release/{id}) for the REAL per-copy shipping. The sell_item
// JSON returns a null shipping object for anonymous requests, but this rendered page DOES show
// shipping — geolocated to our (NL residential) IP — in every listing row (verified live: rows
// like "+€20.00 shipping"). Each row links to /sell/item/{itemId}, so we scrape { itemId: shipping }
// and join it onto the JSON copies by itemId. Selectors used (`tr.shortcut_navigable`, `.item_shipping`,
// `a[href*="/sell/item/"]`) are the long-stable classic-marketplace markup. Returns 0 for free
// shipping and omits rows with no parseable number (those keep null → estimate fallback, honestly).
const SELL_PAGE_URL = (releaseId, currency) =>
  `https://www.discogs.com/sell/release/${Number(releaseId)}?currency=${encodeURIComponent(String(currency || 'EUR'))}&sort=price%2Casc&limit=100`;
const SHIP_EXTRACT = `(() => {
  const rows = [...document.querySelectorAll('tr.shortcut_navigable')];
  const map = {};
  for (const tr of rows) {
    const link = tr.querySelector('a[href*="/sell/item/"]');
    const idm = link ? (link.getAttribute('href').match(/\\/sell\\/item\\/(\\d+)/) || [])[1] : null;
    if (!idm) continue;
    const shipEl = tr.querySelector('.item_shipping');
    let ship = null;
    if (shipEl) {
      const t = shipEl.textContent.trim();
      if (/free/i.test(t)) ship = 0;
      else { const m = t.replace(/,/g, '.').match(/(\\d+(?:\\.\\d+)?)/); if (m) ship = parseFloat(m[1]); }
    }
    if (ship != null && isFinite(ship)) map[idm] = ship;
  }
  // The ready flag lets the poller stop as soon as the sell page has rendered (Cloudflare cleared),
  // even for a release with zero current listings (rowCount 0) -- otherwise it would spin the
  // full retry budget waiting for rows that will never appear.
  const t = document.body ? document.body.innerText : '';
  const challenged = /just a moment|checking your browser|enable javascript/i.test((document.title || '') + ' ' + t.slice(0, 300));
  return { map: map, rowCount: rows.length, ready: !challenged && t.length > 1200 };
})()`;

// Poll an in-page check, FAST-FIRST then backing off, instead of paying a fixed leading sleep.
// Returns the first result for which ok(result) is true, or null after the retry budget. Once
// cf_clearance is warm a page is ready almost immediately, so the first (zero-delay) check usually
// wins — that's where the per-candidate seconds come from vs the old `sleep(1000); check` loops.
// All waiting is local DOM polling (executeJavaScript), so it adds no network load on Discogs.
async function waitFor(cfWin, script, ok, { tries = 20, step = 400, max = 1500 } = {}) {
  let delay = 0;
  for (let i = 0; i < tries; i++) {
    if (scrapeAbort) return null;
    if (delay) await sleep(delay);
    const r = await cfWin.webContents.executeJavaScript(script).catch(() => null);
    if (ok(r)) return r;
    delay = Math.min(max, delay + step); // 0, 400, 800, 1200, 1500, 1500, ...
  }
  return null;
}

// Read a release's REAL data from a hidden (real Chromium, residential IP) window:
//   (1) its sold-median (Last Sold / Low / Median / High, anonymous release-page scrape) — ONLY
//       when we need it, and
//   (2) its per-copy marketplace listings (condition/price via the same-origin sell_item JSON)
//       joined with REAL per-copy shipping (scraped from the rendered sell page).
// The Cloudflare JS challenge clears in this window; the cf_clearance cookie persists across
// navigations (and across candidates in one scan), so only the first load pays the wait.
//
// opts.needSold === false skips the release-page navigation entirely. The sold-median moves slowly
// (it's sales HISTORY) and is cached weekly, so on a repeat scan we already have it — skipping that
// whole navigation is the single biggest per-candidate saving (and one fewer hit on Discogs). The
// sell page is same-origin for the JSON fetch AND carries the shipping rows, so condition + price +
// shipping all come from ONE navigation; the release page is loaded only on a sold-median cache miss.
//
// This is the MEDIAN-ONLY path, used for every candidate confirmation and warm-up probe — it's
// anonymous (no login needed) and deliberately does NOT touch the Sales History page. The much
// slower, login-gated per-sale scrape (fetchSalesHistory, below) is reserved for rare gems only,
// run as a separate step AFTER a scan has identified them — see the gem enrichment pass in
// runScrape. Don't merge that logic back in here; that's what made every candidate/warm-up probe
// pay for a sales-history navigation it didn't need.
async function loadReleaseData(cfWin, releaseId, currency, opts = {}) {
  const needSold = opts.needSold !== false;
  let sold = null;
  let cleared = false;

  if (needSold) {
    await cfWin.loadURL(`https://www.discogs.com/release/${releaseId}`, { userAgent: DISCOGS_UA }).catch(() => {});
    const r2 = await waitFor(cfWin, SOLD_EXTRACT, (x) => x && !x.challenged && x.len > 1500);
    if (r2) {
      cleared = true;
      sold = { median: parseMoney(r2.median), low: parseMoney(r2.low), high: parseMoney(r2.high), lastSold: r2.lastSold || null, sales: [], ts: Date.now() };
    }
  }

  // Warm-up path: the caller only wants the sold-median (coverage builder). Skip the sell page +
  // listings entirely — that's the bulk of the per-release work and it's irrelevant here.
  if (opts.soldOnly) return { cleared, sold, listings: null, listingsError: null, totalCount: null, shippingJoined: 0 };

  // Sell page: real per-copy shipping (DOM rows) AND, same-origin, the structured listings JSON.
  await cfWin.loadURL(SELL_PAGE_URL(releaseId, currency), { userAgent: DISCOGS_UA }).catch(() => {});
  const shipRes = await waitFor(cfWin, SHIP_EXTRACT, (x) => x && (x.rowCount > 0 || x.ready));
  if (shipRes) cleared = true; // the sell page cleared CF even if the release page wasn't loaded/cleared
  const shipMap = shipRes ? (shipRes.map || {}) : null;

  // Per-copy condition + price via the same-origin JSON fetch (robust structured data, no selectors).
  // Strategy 1: in-page fetch on the sell page we're already on. Two tries only — when the in-page
  // fetch fails it's structural (CSP/challenge), not transient, so extra retries just delayed the
  // fallback by ~1.5s per candidate.
  let lr = null;
  for (let i = 0; i < 2; i++) {
    if (scrapeAbort) break;
    lr = await cfWin.webContents.executeJavaScript(LISTINGS_FETCH(releaseId, currency)).catch((e) => ({ error: String((e && e.message) || e) }));
    if (lr && Array.isArray(lr.items)) break;
    await sleep(500);
  }
  // Strategy 2 (fallback): navigate straight to the JSON URL and read the body (the scraper's flow).
  if (!(lr && Array.isArray(lr.items))) {
    await cfWin.loadURL(SELL_ITEM_URL(releaseId, currency), { userAgent: DISCOGS_UA, extraHeaders: 'Accept: application/json' }).catch(() => {});
    const r = await waitFor(cfWin, PARSE_BODY, (x) => x && (Array.isArray(x.items) || (x.error && x.error !== 'cloudflare')), { tries: 8, step: 500 });
    if (r) lr = r;
  }

  // Join the REAL per-copy shipping onto the JSON copies by itemId. The JSON's shipping is null
  // anonymously; the rendered sell page shows IP-geolocated shipping to us. Best-effort: any miss
  // leaves shipping null → the dashboard's estimate fallback kicks in.
  let shippingJoined = 0;
  if (lr && Array.isArray(lr.items) && lr.items.length && shipMap) {
    for (const it of lr.items) {
      const k = it.itemId != null ? String(it.itemId) : null;
      if (it.shipping == null && k && shipMap[k] != null) { it.shipping = shipMap[k]; it.shippingSource = 'page'; shippingJoined++; }
    }
  }

  return {
    cleared,
    sold,
    listings: lr && Array.isArray(lr.items) ? lr.items : null,
    listingsError: lr && lr.error ? lr.error : (lr && Array.isArray(lr.items) ? null : 'no_result'),
    totalCount: lr ? lr.totalCount : null,
    shippingJoined,
  };
}

// Fetch the Sales History page (per-sale date/media/price list) for ONE release. GEM-ONLY: this is
// the slow, login-gated navigation (an anonymous request redirects to login.discogs.com), so it's
// only ever called from the post-scan gem-enrichment pass in runScrape — never from the general
// candidate/warm-up pipeline, which uses the plain anonymous median above. Returns null when not
// logged in / the page didn't clear, in which case the caller keeps whatever median-only reference
// it already had. Raw (untrimmed) sales list — the caller applies engine.recentSales.
async function fetchSalesHistory(cfWin, releaseId) {
  await cfWin.loadURL(SALES_HISTORY_URL(releaseId), { userAgent: DISCOGS_UA }).catch(() => {});
  const r = await waitFor(cfWin, SALES_HISTORY_EXTRACT, (x) => x && (x.loginRequired || (!x.challenged && x.len > 800)));
  if (!r || r.loginRequired || r.challenged) return null;
  return {
    median: parseMoney(r.median), low: parseMoney(r.low), high: parseMoney(r.high), lastSold: r.lastSold || null,
    sales: (r.sales || []).map((s) => ({ date: s.date, media: s.media, price: parseMoney(s.priceText) })).filter((s) => s.price != null),
    salesChecked: true,
    ts: Date.now(),
  };
}

// One-time Discogs login — unlocks the Sales History page (SALES_HISTORY_EXTRACT above) so the
// 💎 rare-gem display can show real recent sales instead of just the aggregate median. The hidden
// cfWin used everywhere else in this file opens with no explicit `partition`, which means it's
// Electron's DEFAULT session — persistent to disk under userData, same as this login window. So a
// one-time visible login here leaves the cookie in place for every future hidden cfWin, with no
// partition wiring needed. The USER logs in themselves in their own real window (credentials, 2FA,
// all theirs) — this code never sees a password, only whether a known logged-in cookie shows up.
let discogsLoginWin = null;
async function isDiscogsLoggedIn() {
  try {
    const cookies = await session.defaultSession.cookies.get({ url: 'https://www.discogs.com', name: 'ck_username' });
    return cookies.length > 0;
  } catch { return false; }
}
function startDiscogsLogin() {
  return new Promise((resolve) => {
    if (discogsLoginWin) { try { discogsLoginWin.focus(); } catch { /* already gone */ } resolve({ started: false }); return; }
    discogsLoginWin = new BrowserWindow({ width: 480, height: 720, title: 'Log in to Discogs', webPreferences: { images: true } });
    discogsLoginWin.loadURL('https://www.discogs.com/login', { userAgent: DISCOGS_UA }).catch(() => {});
    let settled = false;
    const finish = async (closedByUser) => {
      if (settled) return;
      clearInterval(poll);
      const loggedIn = await isDiscogsLoggedIn();
      settled = true;
      try { if (!closedByUser && discogsLoginWin && !discogsLoginWin.isDestroyed()) discogsLoginWin.close(); } catch { /* already closing */ }
      discogsLoginWin = null;
      resolve({ started: true, loggedIn });
    };
    const poll = setInterval(async () => {
      if (await isDiscogsLoggedIn()) finish(false);
    }, 2000);
    discogsLoginWin.on('closed', () => finish(true));
  });
}

async function runScrape(win, opts = {}) {
  if (scrapeRunning) throw new Error('A scan is already running.');
  if (scoutRunning) throw new Error('A Scout scan is already running. Stop it before scanning your wantlist.');
  if (cityDigRunning) throw new Error('City Dig is already scanning a store inventory. Stop it first.');
  // Shared-budget guard: never sweep while the cloud scan is sweeping (see cloudScanActive above) —
  // the caller (renderer) shows why and retries once the cloud run is done.
  const cloudBusy = await cloudScanActive();
  if (cloudBusy) return { postponed: true, cloudBusy };
  scrapeRunning = true;
  scrapeAbort = false;
  const send = (m) => { try { win.webContents.send('scrape:progress', m); } catch { /* window gone */ } };
  let cfWin = null;
  try {
    const { engine, makeClient, makeStore, loadConfig } = loadWatcher();
    const config = loadConfig(configPath());
    if (!config.token) throw new Error('No Discogs token configured — open Settings → Discogs account.');
    if (!config.username) throw new Error('No Discogs username configured — open Settings → Discogs account.');

    const store = makeStore(stateDir());
    const scanThreshold = scanMinDiscount(config);
    // Same conservative pacing as the cloud (1100ms ≈ 54.5/min). This used to be 1050ms (~57/min)
    // to shave ~35s off a sweep, but that runs remaining≈2-3 against the 60/min budget — during a
    // 2-calls-per-release stretch (stale price suggestions) jitter dips it to 1 and the client's
    // near-empty-window guard 60s-stalls, wiping out the gain several times over (measured live
    // 2026-07-18: repeated burst/60s-stall cycles with no external contention).
    const client = makeClient({ token: config.token, userAgent: config.userAgent, minIntervalMs: 1100 });
    const SOLD_TTL_MS = 7 * 24 * 60 * 60 * 1000; // sold-median changes slowly; reuse the weekly cache
    // Checked once per scan: gates the POST-scan gem sales-history enrichment pass only (below) —
    // it no longer affects the candidate/warm-up median freshness check, which stays anonymous.
    const discogsLoggedIn = await isDiscogsLoggedIn();

    send({ phase: 'wantlist', checked: 0, total: 0, found: 0 });
    const wantlist = await client.getWantlist(config.username);
    const wantlistTotal = wantlist.length;

    // Quick scan: check only the highest-PRIORITY releases — ranked by engine.releaseWatchScore
    // (staleness + recent activity + rarity), the same signal the cloud sweep uses — instead of the
    // whole wantlist. This is the only way under the ~13-min API rate-limit floor: it trades coverage
    // (quiet/low-priority releases are skipped THIS run and roll into the next) for a ~4-5 min scan.
    // A full scan (opts.quick falsy) still checks every release.
    const now = Date.now();
    const work = opts.quick
      ? wantlist
        .map((rel) => ({ rel, score: engine.releaseWatchScore(store.getHistory(rel.releaseId), now) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, QUICK_SCAN_SIZE)
        .map((x) => x.rel)
      : wantlist;
    const total = work.length;

    // Create the hidden Cloudflare-clearing window NOW and pre-warm it in the background, so the
    // cf_clearance cookie is already set by the time the first candidate needs it (the wait overlaps
    // the early API calls instead of stalling the first confirmation).
    cfWin = new BrowserWindow({ show: false, width: 1200, height: 900, webPreferences: { images: false } });
    cfWin.loadURL('https://www.discogs.com/', { userAgent: DISCOGS_UA }).catch(() => {});

    const deals = [];
    // Near-misses: candidates that LOOKED cheap (passed the Phase-1 prelim) but were rejected in
    // confirmation — no VG+ copy, or a VG+ copy that isn't cheap enough. Surfaced (opt-in) in the
    // dashboard with the reason, so "why isn't release X showing?" is answerable without a script.
    const nearMisses = [];
    const scrapedThisRun = new Set(); // releases whose median we (re)scraped this run — lets a full-median refresh skip them in the warm-up (no double scrape)
    let priced = 0;          // candidates run through the browser (Phase 2)
    let candidateCount = 0;  // candidates discovered so far (Phase 1)
    let confirmed = 0;
    let droppedNoVgPlus = 0;
    let unconfirmed = 0;
    let realShip = 0; // confirmed deals carrying REAL per-copy shipping (joined from the page, not estimated)
    let cfFailed = 0; // candidates where Cloudflare never cleared — surfaced in the done line, retried next scan
    const marketUrl = (id) => `${engine.releaseMarketUrl(id)}?sort=price%2Casc&limit=25&currency=${config.currency}`;

    // Confirm ONE candidate through the browser: read the REAL data the official API hides — the
    // sales-history median (only when not cached) AND every copy's actual media condition + price +
    // shipping — then pick the CHEAPEST copy that is VG+ or better and judge the discount against
    // THAT copy. A release whose only cheap copies are worn (sub-VG+) is dropped, so a scan deal is a
    // copy we've CONFIRMED is VG+, not a price guess.
    async function confirmCandidate(c) {
      const cachedSold = store.getSoldMedian(c.rel.releaseId);
      // Reuse a fresh cached median (the weekly TTL) — the median is sales HISTORY, it moves too
      // slowly for a same-week re-scrape to change the verdict, and skipping the release-page
      // navigation is the single biggest per-candidate saving. (A full-median scan used to ignore
      // the TTL and re-scrape EVERYTHING every run — that's what made a full scan take 30-60 min
      // even right after a previous one.) A release the interleaved warm-up ALREADY scraped this
      // run is fresh by definition — don't pay the navigation twice in one scan. Purely median-TTL
      // based — whether the cache carries gem sales-history (salesChecked) is irrelevant here.
      const soldFresh = scrapedThisRun.has(c.rel.releaseId)
        ? !!cachedSold
        : !!(cachedSold && cachedSold.median != null && cachedSold.ts && (Date.now() - cachedSold.ts < SOLD_TTL_MS));

      let data = { cleared: false, sold: null, listings: null };
      try { data = await loadReleaseData(cfWin, c.rel.releaseId, config.currency, { needSold: !soldFresh }); } catch { /* leave defaults */ }
      await sleep(300); // be gentle on Discogs/Cloudflare between releases

      // Sold-median: prefer a fresh scrape, else the weekly cache. Refresh the cache when fresh.
      // If the page cleared but the release has simply never sold, cache a null-median sentinel so the
      // warm-up below doesn't keep re-scraping it every run (only when we don't already have a real one).
      // This is the anonymous median-only scrape (no `sales`) — preserve any per-sale list + the
      // `salesChecked` flag a prior GEM enrichment pass may have written, so a routine median refresh
      // can't wipe out real sales history that was fetched separately.
      let sold = cachedSold;
      if (data.sold && data.sold.median != null) {
        sold = { ...data.sold, sales: (cachedSold && cachedSold.sales) || [], salesChecked: !!(cachedSold && cachedSold.salesChecked) };
        store.setSoldMedian(c.rel.releaseId, sold);
      }
      else if (data.cleared && data.sold && (!cachedSold || cachedSold.median == null)) { store.setSoldMedian(c.rel.releaseId, { median: null, low: null, high: null, lastSold: data.sold.lastSold || 'Never', sales: [], salesChecked: false, ts: Date.now() }); }
      if (data.sold) scrapedThisRun.add(c.rel.releaseId); // got a release-page read this run -> warm-up needn't redo it

      const common = {
        id: `${c.rel.releaseId}-scan`,
        releaseId: c.rel.releaseId, title: c.rel.title, artist: c.rel.artist, year: c.rel.year, thumb: c.rel.thumb,
        numForSale: c.stats.numForSale,
        soldMedian: sold ? sold.median : null, soldLow: sold ? sold.low : null, soldHigh: sold ? sold.high : null, lastSold: sold ? sold.lastSold : null,
        freshListing: c.freshListing,
        marketHistory: c.marketHistory || null,
        scanThreshold,
        // Recent lowest-price trail (oldest -> newest) for the dashboard sparkline.
        spark: store.getHistory(c.rel.releaseId).slice(-12).map((o) => o.lowest).filter((x) => typeof x === 'number' && x > 0),
        releaseUrl: engine.releaseUrl(c.rel.releaseId), ts: Date.now(),
      };

      if (Array.isArray(data.listings)) {
        const listingMovements = observeListings(c.rel.releaseId, data.listings, data.totalCount);
        // We have the real listings -> pick the cheapest copy that is actually VG+ or better.
        const pick = engine.selectByCondition(data.listings, { minCondition: 'Very Good Plus (VG+)' });
        if (!pick.best) {
          droppedNoVgPlus++;
          const ca = pick.cheapestAny;
          nearMisses.push({
            ...common, id: `${c.rel.releaseId}-miss`, nearMiss: true, reasonCode: 'no-vgplus',
            currency: (ca && ca.currency) || c.stats.currency || config.currency,
            cheapestPrice: ca ? (ca.price ?? null) : null, cheapestGrade: ca ? ca.media : null,
            copiesSeen: pick.totalCount, vgPlusCount: pick.acceptableCount,
            url: marketUrl(c.rel.releaseId),
          });
          return;
        }
        const best = pick.best;
        const exactHistory = best.itemId != null ? listingMovements[String(best.itemId)] || null : null;
        const sig = engine.evaluateMarketSignal({
          lowest: best.price,
          soldMedian: sold ? sold.median : null,
          suggestion: c.sug ? c.sug.vgplus : null, suggestionLow: c.sug ? c.sug.vg : null, ladder: c.sug ? c.sug.ladder : null,
          trailingMedian: store.trailingMedianLowest(c.rel.releaseId, config.trailingN),
          prevAlertedLowest: null,
        }, { minDiscount: scanThreshold, shippingEstimate: best.shipping != null ? best.shipping : config.shippingEstimate });
        if (sig.meetsThreshold) {
          const cur = best.currency || c.stats.currency || config.currency;
          const cheaperWorn = pick.cheapestAny && pick.cheapestAny.itemId !== best.itemId
            && (pick.cheapestAny.total ?? pick.cheapestAny.price) < (best.total ?? best.price);
          // A: how many VG+ copies are ALL cheap vs the reference (a cluster = real price drop, not a fluke).
          const cluster = engine.cheapCluster(pick.acceptable, sig.reference, scanThreshold);
          // B: a slightly-dearer-but-better-grade copy to offer as an alternative.
          const alt = pick.betterAlt;
          deals.push({
            ...common,
            lowest: best.price, currency: cur,
            shipping: best.shipping, shippingSource: best.shippingSource, shipsFrom: best.shipsFrom,
            reference: sig.reference, referenceSource: sig.referenceSource, discount: sig.discount,
            conditionConfirmed: true, mediaCondition: best.media, sleeveCondition: best.sleeve,
            vgPlusCount: pick.acceptableCount, copiesSeen: pick.totalCount,
            cheapVgPlusCount: cluster.count, cheapVgPlusLow: cluster.low, cheapVgPlusHigh: cluster.high,
            altGrade: alt ? alt.media : null, altPrice: alt ? (alt.total ?? alt.price) : null, altUrl: alt ? alt.url : null,
            cheaperWornPrice: cheaperWorn ? pick.cheapestAny.price : null,
            cheaperWornCondition: cheaperWorn ? pick.cheapestAny.media : null,
            ownDrop: sig.ownDrop, impliedGrade: sig.impliedGrade, pricedAsWorn: sig.pricedAsWorn, suspicious: sig.suspicious,
            listingUrl: best.url, url: best.url || marketUrl(c.rel.releaseId),
            listingId: best.itemId ?? null, listingHistory: exactHistory,
          });
          confirmed++;
          if (best.shipping != null) realShip++;
        } else {
          // There IS a VG+ copy, it's just not cheap enough vs the reference (the JJ-Foster case).
          nearMisses.push({
            ...common, id: `${c.rel.releaseId}-miss`, nearMiss: true, reasonCode: 'vgplus-not-cheap',
            currency: best.currency || c.stats.currency || config.currency,
            bestPrice: best.price, bestGrade: best.media, shipping: best.shipping,
            discount: sig.discount, effectiveDiscount: sig.effectiveDiscount,
            reference: sig.reference, referenceSource: sig.referenceSource,
            url: best.url || marketUrl(c.rel.releaseId),
          });
        }
      } else {
        // Listings unreachable (Cloudflare didn't clear / API shape changed) -> fall back to the
        // API-only estimate so the feature degrades gracefully. Marked unconfirmed; the dashboard's
        // "VG+ only" filter hides it unless it at least looks VG+ by price.
        if (!data.cleared) cfFailed++; // count the "never got past Cloudflare" case for the done line
        const sig = engine.evaluateMarketSignal({
          lowest: c.stats.lowestPrice,
          soldMedian: sold ? sold.median : null,
          suggestion: c.sug ? c.sug.vgplus : null, suggestionLow: c.sug ? c.sug.vg : null, ladder: c.sug ? c.sug.ladder : null,
          trailingMedian: store.trailingMedianLowest(c.rel.releaseId, config.trailingN),
          prevAlertedLowest: null,
        }, { minDiscount: scanThreshold, shippingEstimate: config.shippingEstimate });
        if (sig.meetsThreshold) {
          deals.push({
            ...common,
            lowest: c.stats.lowestPrice, currency: c.stats.currency || config.currency,
            shipping: null,
            reference: sig.reference, referenceSource: sig.referenceSource, discount: sig.discount,
            conditionConfirmed: false, conditionError: data.listingsError || 'unavailable',
            ownDrop: sig.ownDrop, impliedGrade: sig.impliedGrade, pricedAsWorn: sig.pricedAsWorn, suspicious: sig.suspicious,
            url: marketUrl(c.rel.releaseId),
          });
          unconfirmed++;
        } else {
          nearMisses.push({
            ...common, id: `${c.rel.releaseId}-miss`, nearMiss: true, reasonCode: 'unconfirmed-not-cheap',
            currency: c.stats.currency || config.currency,
            lowest: c.stats.lowestPrice, discount: sig.discount, effectiveDiscount: sig.effectiveDiscount,
            reference: sig.reference, referenceSource: sig.referenceSource, impliedGrade: sig.impliedGrade,
            url: marketUrl(c.rel.releaseId),
          });
        }
      }
    }

    // --- Sold-median warm-up (coverage builder) — INTERLEAVED, not a serial post-pass -----------
    // The candidate pipeline only scrapes a sold-median for releases that LOOKED cheap. Releases
    // sitting at a normal price never get their true market value learned — so when one suddenly
    // gets a just-listed cheap copy (the prime diamond event), the cloud has no real median and must
    // judge it against the often-inflated VG+ suggestion. Each FULL scan therefore tops up a bounded
    // budget of not-yet-covered releases, caching the real median (or a "never sold" sentinel).
    // The probes run in the CONSUMER'S IDLE TIME: while the API pacing hasn't produced a candidate
    // yet, the browser does a warm-up probe instead of sleeping — the old serial post-pass added
    // 1.5-2 min AFTER the progress bar hit 100%; now most (often all) of it hides inside the sweep.
    // Whatever budget is left when the pipeline ends drains in a short post-pass. Quick scans skip
    // it. A full-median scan lifts the BUDGET to the whole wantlist (full coverage) but still
    // respects the weekly TTL: only stale/never-scraped medians are (re)probed. Right after a
    // previous full scan the queue is near-empty and the scan collapses to ≈ the API sweep alone;
    // a week later everything has expired and one scan refreshes it all. (It used to IGNORE the
    // TTL and force-rescrape every median — that bought nothing, sales history barely moves within
    // a week, and cost 30-60 min per scan.)
    const WARMUP_BUDGET = opts.quick ? 0 : (opts.fullMedians ? work.length : (() => { const v = Number(readSettings().soldMedianWarmup); return Number.isFinite(v) ? v : 50; })());
    // Purely median-TTL based, same as soldFresh above — gem sales-history freshness is tracked and
    // checked separately in the post-scan enrichment pass, not here.
    const soldFreshNow = (id) => { const sm = store.getSoldMedian(id); return !!(sm && sm.ts && (Date.now() - sm.ts < SOLD_TTL_MS)); };
    const warmupQueue = WARMUP_BUDGET > 0
      ? work
        .filter((rel) => !soldFreshNow(rel.releaseId))
        .sort((a, b) => { const sa = store.getSoldMedian(a.releaseId), sb = store.getSoldMedian(b.releaseId); return (sa ? sa.ts : 0) - (sb ? sb.ts : 0); }) // never-cached first, then oldest
      : [];
    let warmupIdx = 0, warmedReal = 0, warmedChecked = 0;
    // Measured pace of the two browser workloads (a candidate confirmation ≈ 2 navigations, a
    // warm-up probe ≈ 1) — feeds the honest ETA below. Priors cover the first few ops.
    let candMs = 0, candOps = 0, warmMs = 0, warmOps = 0;
    const warmupTotal = Math.min(WARMUP_BUDGET, warmupQueue.length); // display estimate (skips can shrink the real count)
    // Probe ONE warm-up target (release page only, no API calls). Returns false when the queue or
    // budget is exhausted. Targets that were scraped by the pipeline mid-run — or became fresh —
    // are skipped for free.
    async function warmupNext() {
      while (warmupIdx < warmupQueue.length && warmedChecked < WARMUP_BUDGET) {
        if (scrapeAbort) return false;
        const rel = warmupQueue[warmupIdx++];
        if (scrapedThisRun.has(rel.releaseId)) continue;              // pipeline already read this release page
        if (soldFreshNow(rel.releaseId)) continue;                    // became fresh mid-run
        const tW = Date.now();
        const cachedSold = store.getSoldMedian(rel.releaseId);
        let d = { cleared: false, sold: null };
        try { d = await loadReleaseData(cfWin, rel.releaseId, config.currency, { soldOnly: true }); } catch { /* transient — retry next scan */ }
        if (d.sold) scrapedThisRun.add(rel.releaseId); // a later candidate for this release needn't re-scrape
        if (d.sold && d.sold.median != null) {
          // Anonymous median-only scrape — preserve any gem-fetched sales history rather than wipe it.
          store.setSoldMedian(rel.releaseId, { ...d.sold, sales: (cachedSold && cachedSold.sales) || [], salesChecked: !!(cachedSold && cachedSold.salesChecked) });
          warmedReal++;
        }
        else if (d.cleared && d.sold) { store.setSoldMedian(rel.releaseId, { median: null, low: null, high: null, lastSold: d.sold.lastSold || 'Never', sales: [], salesChecked: false, ts: Date.now() }); }
        warmedChecked++;
        await sleep(300);
        warmMs += Date.now() - tW; warmOps++;
        return true;
      }
      return false;
    }

    // PIPELINE: the API sweep (Phase 1, hits api.discogs.com) and the browser confirmation (Phase 2,
    // hits www.discogs.com) use independent rate limits, so run them CONCURRENTLY instead of one after
    // the other — the browser work fills the time the API pacing would otherwise spend idle. A single
    // producer enqueues candidates as it finds them; a single consumer drains them through the one
    // Cloudflare-cleared window. Total wall-clock collapses to ≈ the API sweep alone.
    const queue = [];
    let producerDone = false;
    let wake = null; // resolver to wake the consumer when a candidate arrives or the producer finishes
    let scanned = 0; // releases stats-checked (Phase 1 progress)

    // Honest ETA — the old renderer-side guess (remaining × 1.05s) modeled ONLY the API sweep and
    // was off by 3-4× whenever the browser lane dominated (many candidates / a big warm-up queue)
    // or the sweep needed a second API call per release (stale price-suggestions week). Instead,
    // MEASURE both lanes and report the slower one: they run concurrently, so the scan ends when
    // the longest lane does. The API pace comes from wall-clock elapsed / releases swept (which
    // automatically absorbs the suggestion calls); the browser lane is its backlog (queued + not
    // yet discovered candidates, extrapolated from the hit-rate so far, plus the remaining warm-up
    // queue) at the measured per-op pace.
    const scanStart = Date.now();
    const etaMs = () => estimateScanEta({
      total, scanned, now: Date.now(), scanStart,
      candidateCount, priced, candidateMs: candMs, candidateOps: candOps,
      warmupBudget: WARMUP_BUDGET, warmedChecked,
      warmupQueueLength: warmupQueue.length, warmupIndex: warmupIdx,
      warmMs, warmOps,
    });
    const progress = () => send({ phase: 'scan', checked: scanned, total, found: deals.length, candidates: candidateCount, processed: priced, queued: queue.length, etaMs: etaMs() });

    const consumer = (async () => {
      for (;;) {
        if (scrapeAbort) break;
        if (!queue.length) {
          if (producerDone) break;
          // Idle: no candidate ready yet. Spend the wait on a sold-median warm-up probe (same
          // window, zero API calls) instead of sleeping — candidates still take priority the
          // moment one lands in the queue (re-checked every iteration).
          if (await warmupNext()) continue;
          await new Promise((r) => { wake = r; }); // sleep until a candidate is enqueued (or producer ends)
          continue;
        }
        const c = queue.shift();
        const tC = Date.now();
        try { await confirmCandidate(c); } catch { /* one candidate failing must not stop the drain */ }
        candMs += Date.now() - tC; candOps++;
        priced++;
        progress();
      }
    })();

    const gemsFound = []; // 💎 rare appearances (0 -> first copy) detected during THIS scan
    for (const rel of work) {
      if (scrapeAbort) break;
      try {
        const stats = await client.getMarketplaceStats(rel.releaseId, config.currency);
        const prevObs = store.lastObservation(rel.releaseId);
        const curObs = { ts: Date.now(), lowest: stats.lowestPrice, numForSale: stats.numForSale };
        store.pushObservation(rel.releaseId, curObs);

        // 💎 Rare gem: this release had ZERO copies for sale and just got its first — recorded
        // regardless of price (availability is the signal). Same cooldown dedupe as the cloud
        // watcher, but against the LOCAL state (the two keep independent histories, so the cloud
        // still emails the same event on its own next sweep).
        if (engine.isRareAppearance(prevObs, curObs)) {
          const ra = store.getRareAlerted(rel.releaseId);
          if (!ra || Date.now() - ra.ts > RARE_COOLDOWN_MS) {
            const sm = store.getSoldMedian(rel.releaseId);
            const sug0 = store.getSuggestion(rel.releaseId);
            const refSource = sm && sm.median != null ? 'sold-median' : (sug0 && sug0.vgplus != null ? 'suggestion' : null);
            const gem = {
              id: `${rel.releaseId}-gem-${Date.now()}`,
              type: 'gem',
              releaseId: rel.releaseId, title: rel.title, artist: rel.artist, year: rel.year, thumb: rel.thumb,
              lowest: stats.lowestPrice, currency: stats.currency || config.currency,
              numForSale: stats.numForSale,
              reference: refSource === 'sold-median' ? sm.median : (refSource === 'suggestion' ? sug0.vgplus : null),
              referenceSource: refSource,
              recentSales: sm && Array.isArray(sm.sales) && sm.sales.length ? sm.sales : null,
              url: marketUrl(rel.releaseId),
              releaseUrl: engine.releaseUrl(rel.releaseId),
              ts: Date.now(),
            };
            store.addGem(gem);
            store.setRareAlerted(rel.releaseId, { ts: Date.now(), numForSale: stats.numForSale });
            gemsFound.push(gem);
          }
        }

        if (stats.numForSale > 0 && stats.lowestPrice != null) {
          let sug = store.getSuggestion(rel.releaseId);
          const suggestionComplete = sug && Object.prototype.hasOwnProperty.call(sug, 'ladder');
          if (!suggestionComplete || Date.now() - sug.ts > SUGGESTION_TTL_MS) {
            try {
              const raw = await client.getPriceSuggestions(rel.releaseId);
              if (raw) sug = { ts: Date.now(), vgplus: raw['Very Good Plus (VG+)']?.value ?? null, vg: raw['Very Good (VG)']?.value ?? null, ladder: engine.extractLadder(raw) };
              else sug = { ts: Date.now(), vgplus: null, vg: null, ladder: null, unavailable: true };
              store.setSuggestion(rel.releaseId, sug);
            } catch { /* no suggestion -> trailing-median fallback */ }
          }
          const prelim = evaluateScanPreliminary({ engine, store, rel, stats, suggestion: sug, config });
          if (prelim.meetsThreshold) {
            queue.push({ rel, stats, sug, freshListing: engine.isFreshListing(prevObs, curObs), marketHistory: engine.lowestPriceMovement(prevObs, curObs) });
            candidateCount++;
            if (wake) { wake(); wake = null; } // wake the consumer if it was idle
          }
        }
      } catch (e) { /* one release failing must not abort the scan */ }
      scanned++;
      if (scanned % 2 === 0 || scanned === total) progress();
    }
    producerDone = true;
    if (wake) { wake(); wake = null; } // let the consumer finish draining the queue
    await consumer;

    // Drain whatever warm-up budget the interleaved probes didn't get through during the pipeline
    // (on a candidate-heavy scan the consumer had little idle time). Often this is already empty.
    if (!scrapeAbort && warmedChecked < WARMUP_BUDGET && warmupIdx < warmupQueue.length) {
      send({ phase: 'warmup', checked: warmedChecked, total: warmupTotal, found: deals.length, etaMs: etaMs() });
      while (!scrapeAbort && await warmupNext()) {
        send({ phase: 'warmup', checked: warmedChecked, total: warmupTotal, found: deals.length, etaMs: etaMs() });
      }
    }

    // --- Gem sales-history enrichment — ACHTERAF, GEMS ONLY ---------------------------------------
    // The per-sale Sales History page is the slow, login-gated navigation, so it's worth paying for
    // ONLY the handful of releases that turned out to be rare gems THIS scan (0-for-sale -> first
    // copy) — never for the whole candidate/warm-up pipeline, which stays on the fast anonymous
    // median above. Runs after everything else so gemsFound is final and the browser window is free.
    // Skips a gem whose cached median is already salesChecked-fresh (same weekly TTL as the median).
    let gemsEnriched = 0;
    if (!scrapeAbort && discogsLoggedIn && gemsFound.length) {
      send({ phase: 'gems', checked: 0, total: gemsFound.length, found: deals.length });
      for (const gem of gemsFound) {
        if (scrapeAbort) break;
        const cached = store.getSoldMedian(gem.releaseId);
        if (cached && cached.salesChecked && cached.ts && (Date.now() - cached.ts < SOLD_TTL_MS)) continue;
        let sh = null;
        try { sh = await fetchSalesHistory(cfWin, gem.releaseId); } catch { /* keep the median-only reference */ }
        if (sh) {
          store.setSoldMedian(gem.releaseId, sh);
          const trimmed = engine.recentSales(sh.sales, { years: 2, limit: 10 });
          gem.recentSales = trimmed.length ? trimmed : null;
          if (sh.median != null && gem.referenceSource !== 'sold-median') { gem.reference = sh.median; gem.referenceSource = 'sold-median'; }
          store.addGem(gem); // re-persist the enriched card (replaces the plain one for this releaseId)
          gemsEnriched++;
        }
        await sleep(300); // be gentle on Discogs/Cloudflare between releases
        send({ phase: 'gems', checked: gemsEnriched, total: gemsFound.length, found: deals.length });
      }
    }

    deals.sort((a, b) => (b.discount ?? 0) - (a.discount ?? 0));
    // Near-misses: show the most USEFUL first — a confirmed VG+ copy that just missed the threshold
    // (a real almost-deal) before the worn / no-VG+ ones — then by how close it came. Cap so a huge
    // worn-copy tail can't bloat the result; the count is reported either way.
    const missRank = (m) => (m.reasonCode === 'vgplus-not-cheap' ? 0 : m.reasonCode === 'unconfirmed-not-cheap' ? 1 : 2);
    nearMisses.sort((a, b) => missRank(a) - missRank(b) || ((b.effectiveDiscount ?? b.discount ?? 0) - (a.effectiveDiscount ?? a.discount ?? 0)));
    const nearMissOut = nearMisses.slice(0, 250);

    // 💎 zero-stock watch list: wantlist releases whose LATEST observation counted ZERO copies for
    // sale — the rarities the 💎 tab shows as "being watched". Computed against the FULL wantlist
    // (the store keeps knowledge from earlier scans, so a quick scan doesn't shrink the list).
    const zeroIds = new Set(store.listZeroStock());
    const zeroWatchOut = wantlist
      .filter((r) => zeroIds.has(String(r.releaseId)))
      .map((r) => ({ releaseId: r.releaseId, title: r.title, artist: r.artist, year: r.year, thumb: r.thumb }));

    try { fs.writeFileSync(LAST_SCAN_FILE(), JSON.stringify({ ts: Date.now(), deals, nearMisses: nearMissOut, gems: gemsFound, zeroWatch: zeroWatchOut })); } catch { /* best effort */ }

    // Publish the accumulated REAL sales-history medians so the cloud email watcher can judge deals
    // against true market value. The publisher uses a detached temporary worktree; it never writes,
    // stages or commits in the checkout from which this dashboard is running.
    let soldMediansExported = 0;
    let mediansPush = null;
    let soldMediansForPush = null;
    if (!app.isPackaged) {
      try {
        const src = path.join(stateDir(), 'soldmedians.json');
        if (fs.existsSync(src)) {
          const sm = JSON.parse(fs.readFileSync(src, 'utf8'));
          soldMediansForPush = filterRealMedians(sm);
          soldMediansExported = Object.keys(soldMediansForPush).length;
        }
      } catch { /* non-fatal: publishing is a convenience, not the scan result */ }

      // Auto-commit + push the refreshed medians so the cloud emails use them with no manual git step.
      if (soldMediansExported && readSettings().autoPushMedians !== false) {
        send({ phase: 'pushing' });
        mediansPush = await autoPushSoldMedians(soldMediansForPush);
        writePushStatus({ ts: Date.now(), ...mediansPush }); // feeds the persistent topbar badge
      }
    }

    send({ phase: 'done', checked: total, total, found: deals.length, gems: gemsFound.length, gemsEnriched, zeroWatch: zeroWatchOut.length, confirmed, droppedNoVgPlus, unconfirmed, cfFailed, realShip, nearMisses: nearMissOut.length, warmedReal, warmedChecked, soldMediansExported, mediansPush, aborted: scrapeAbort, quick: !!opts.quick, fullMedians: !!opts.fullMedians, wantlistTotal });
    return { deals, nearMisses: nearMissOut, gems: gemsFound, gemsEnriched, zeroWatch: zeroWatchOut, checked: total, total, confirmed, droppedNoVgPlus, unconfirmed, cfFailed, realShip, warmedReal, warmedChecked, aborted: scrapeAbort, quick: !!opts.quick, fullMedians: !!opts.fullMedians, wantlistTotal };
  } finally {
    scrapeRunning = false;
    if (cfWin) { try { cfWin.destroy(); } catch { /* already gone */ } }
  }
}

// ---------------------------------------------------------------------------
// Scout — discover valuable vinyl outside the user's wantlist by genre/style.
// ---------------------------------------------------------------------------
// Database search itself has no price sort. We therefore inspect a bounded number of concrete
// vinyl releases, read Discogs's VG+ price suggestion (or a fresh real sold-median already in our
// cache), and only then fetch marketplace availability for releases above the chosen value floor.
// This stays honest about the signal and avoids spending two API calls on every cheap release.
const LAST_SCOUT_FILE = () => path.join(app.getPath('userData'), 'last-scout.json');

function lastScout() {
  try {
    const value = JSON.parse(fs.readFileSync(LAST_SCOUT_FILE(), 'utf8'));
    return value && Array.isArray(value.results) ? value : null;
  } catch { return null; }
}

async function runScout(win, rawOpts = {}) {
  if (scoutRunning) throw new Error('A Scout scan is already running.');
  if (scrapeRunning) throw new Error('Your wantlist scan is already running. Wait for it to finish first.');
  if (cityDigRunning) throw new Error('City Dig is already scanning a store inventory. Stop it first.');
  const opts = normalizeScoutOptions(rawOpts);
  scoutRunning = true;
  scoutAbort = false;
  const send = (message) => { try { win.webContents.send('scout:progress', message); } catch { /* window gone */ } };

  try {
    const cloudBusy = await cloudScanActive();
    if (cloudBusy) return { postponed: true, cloudBusy };
    const { makeClient, makeStore, loadConfig } = loadWatcher();
    const config = loadConfig(configPath());
    if (!config.token) throw new Error('No Discogs token configured — open Settings → Discogs account.');
    if (!config.username) throw new Error('No Discogs username configured — open Settings → Discogs account.');
    if (['EUR', 'USD', 'GBP'].includes(String(config.currency || '').toUpperCase())) opts.currency = String(config.currency).toUpperCase();

    const client = makeClient({ token: config.token, userAgent: config.userAgent, minIntervalMs: 1100 });
    const store = makeStore(stateDir());
    send({ phase: 'wantlist', checked: 0, total: 0, found: 0 });
    const wanted = new Set((await client.getWantlist(config.username)).map((release) => Number(release.releaseId)));

    const discovered = [];
    const seenReleases = new Set();
    let excludedWantlist = 0;
    let inspected = 0;
    let page = 1;
    let pages = 1;
    send({ phase: 'search', checked: 0, total: opts.limit, found: 0, query: opts.query });
    while (!scoutAbort && inspected < opts.limit && page <= pages) {
      const perPage = Math.min(100, opts.limit - inspected);
      const found = await client.searchReleases({
        field: opts.field,
        query: opts.query,
        format: opts.format,
        page,
        perPage,
      });
      pages = Math.max(1, Number(found.pagination?.pages) || 1);
      const batch = (found.results || []).slice(0, perPage);
      inspected += batch.length;
      for (const raw of batch) {
        const release = normalizeSearchResult(raw);
        if (!Number.isFinite(release.releaseId) || release.releaseId <= 0 || seenReleases.has(release.releaseId)) continue;
        seenReleases.add(release.releaseId);
        if (wanted.has(release.releaseId)) { excludedWantlist += 1; continue; }
        discovered.push(release);
      }
      send({ phase: 'search', checked: inspected, total: opts.limit, found: discovered.length, query: opts.query });
      if (!batch.length) break;
      page += 1;
    }

    const results = [];
    let checked = 0;
    const soldFreshMs = 30 * 24 * 60 * 60 * 1000;
    for (const release of discovered) {
      if (scoutAbort) break;
      checked += 1;
      let suggestion = store.getSuggestion(release.releaseId);
      if (!suggestion || !suggestion.ts || Date.now() - suggestion.ts >= SUGGESTION_TTL_MS) {
        try {
          const raw = await client.getPriceSuggestions(release.releaseId);
          const snapshot = suggestionSnapshot(raw);
          suggestion = { ts: Date.now(), ...snapshot, unavailable: snapshot.vgplus == null };
          store.setSuggestion(release.releaseId, suggestion);
        } catch (error) {
          if (error && error.status === 401) throw error;
          suggestion = null;
        }
      }

      const sold = store.getSoldMedian(release.releaseId);
      const freshSold = sold && sold.median != null && sold.ts && Date.now() - sold.ts < soldFreshMs ? sold : null;
      const estimatedValue = freshSold ? Number(freshSold.median) : Number(suggestion && suggestion.vgplus);
      if (!Number.isFinite(estimatedValue) || estimatedValue < opts.minValue) {
        send({ phase: 'pricing', checked, total: discovered.length, found: results.length });
        continue;
      }

      let stats = { numForSale: null, lowestPrice: null, currency: opts.currency, blocked: false };
      try { stats = await client.getMarketplaceStats(release.releaseId, opts.currency); }
      catch { /* value candidate remains useful even if live availability failed */ }
      const item = {
        ...release,
        estimatedValue,
        valueSource: freshSold ? 'sold-median' : 'suggestion',
        currency: (freshSold && freshSold.currency) || (suggestion && suggestion.currency) || stats.currency || opts.currency,
        numForSale: stats.numForSale,
        lowestPrice: stats.lowestPrice,
        blocked: !!stats.blocked,
        releaseUrl: `https://www.discogs.com/release/${release.releaseId}`,
        marketplaceUrl: `https://www.discogs.com/sell/release/${release.releaseId}?sort=price%2Casc&currency=${encodeURIComponent(opts.currency)}`,
      };
      item.score = scoutScore(item);
      results.push(item);
      send({ phase: 'pricing', checked, total: discovered.length, found: results.length });
    }

    const output = {
      ts: Date.now(),
      query: opts,
      inspected,
      candidates: discovered.length,
      excludedWantlist,
      aborted: scoutAbort,
      results: sortScoutResults(results),
    };
    try { fs.writeFileSync(LAST_SCOUT_FILE(), JSON.stringify(output, null, 2)); } catch { /* persistence is best effort */ }
    send({ phase: 'done', checked, total: discovered.length, found: output.results.length, aborted: scoutAbort });
    return output;
  } finally {
    scoutRunning = false;
  }
}

async function addScoutWant(releaseId) {
  const id = Number(releaseId);
  if (!Number.isInteger(id) || id <= 0) throw new Error('Invalid Discogs release id.');
  if (scrapeRunning || scoutRunning || cityDigRunning) throw new Error('Wait for the active scan to finish first.');
  const { makeClient, loadConfig } = loadWatcher();
  const config = loadConfig(configPath());
  if (!config.token || !config.username) throw new Error('Set up your Discogs account first.');
  const client = makeClient({ token: config.token, userAgent: config.userAgent, minIntervalMs: 1100 });
  await client.addToWantlist(config.username, id);
  const saved = lastScout();
  if (saved) {
    saved.results = saved.results.map((item) => Number(item.releaseId) === id ? { ...item, addedToWantlist: true } : item);
    try { fs.writeFileSync(LAST_SCOUT_FILE(), JSON.stringify(saved, null, 2)); } catch { /* best effort */ }
  }
  return { ok: true, releaseId: id };
}

// ---------------------------------------------------------------------------
// City Dig — browse recent inventory from verified physical record stores.
// ---------------------------------------------------------------------------
// Discogs inventory rows do not contain genre/style. We therefore read a small newest-first slice
// from each selected seller and enrich each unique release through the official releases endpoint.
// Release taxonomy is cached for 180 days, making repeat digs fast while respecting 60 req/min.
const LAST_CITY_DIG_FILE = () => path.join(app.getPath('userData'), 'last-city-dig.json');

function lastCityDig() {
  try {
    const value = JSON.parse(fs.readFileSync(LAST_CITY_DIG_FILE(), 'utf8'));
    return value && Array.isArray(value.results) ? value : null;
  } catch { return null; }
}

async function cityDigCounts(cityId) {
  const city = CITY_DIG_CITIES.find((candidate) => candidate.id === String(cityId || ''));
  if (!city) throw new Error('Unknown City Dig city.');
  if (scrapeRunning || scoutRunning || cityDigRunning) {
    return { cityId: city.id, ts: Date.now(), counts: {}, busy: true };
  }
  const { makeClient, loadConfig } = loadWatcher();
  let config = {};
  try { config = loadConfig(configPath()) || {}; } catch { config = {}; }
  const client = makeClient({ token: config.token || '', userAgent: config.userAgent, minIntervalMs: config.token ? 1100 : 2500 });
  const counts = {};
  for (const store of city.stores.filter((candidate) => candidate.sellerUsername)) {
    try {
      const profile = await client.getUserProfile(store.sellerUsername);
      counts[store.sellerUsername] = profile ? profile.numForSale : null;
    } catch { counts[store.sellerUsername] = null; }
  }
  return { cityId: city.id, ts: Date.now(), counts };
}

async function runCityDig(win, rawOpts = {}) {
  if (cityDigRunning) throw new Error('A City Dig scan is already running.');
  if (scrapeRunning || scoutRunning) throw new Error('Another Discogs scan is already running. Wait for it to finish first.');
  const opts = normalizeCityDigOptions(rawOpts, CITY_DIG_CITIES);
  const city = CITY_DIG_CITIES.find((candidate) => candidate.id === opts.cityId);
  const selectedStores = city.stores.filter((store) => opts.sellerUsernames.includes(store.sellerUsername));
  const storesBySeller = new Map(selectedStores.map((store) => [store.sellerUsername, store]));
  cityDigRunning = true;
  cityDigAbort = false;
  const send = (message) => { try { win.webContents.send('cityDig:progress', message); } catch { /* window gone */ } };

  try {
    const { makeClient, makeStore, loadConfig } = loadWatcher();
    const config = loadConfig(configPath());
    if (!config.token) throw new Error('No Discogs token configured — open Settings → Discogs account.');
    if (['EUR', 'USD', 'GBP'].includes(String(config.currency || '').toUpperCase())) opts.currency = String(config.currency).toUpperCase();
    const client = makeClient({ token: config.token, userAgent: config.userAgent, minIntervalMs: 1100 });
    const store = makeStore(stateDir());
    const listings = [];
    let skippedNonVinyl = 0;

    for (let storeIndex = 0; storeIndex < selectedStores.length && !cityDigAbort; storeIndex += 1) {
      const selectedStore = selectedStores[storeIndex];
      let gathered = 0;
      let page = 1;
      send({ phase: 'inventory', store: selectedStore.name, storeIndex, stores: selectedStores.length, checked: 0, total: opts.limitPerSeller });
      while (gathered < opts.limitPerSeller && !cityDigAbort) {
        const perPage = Math.min(100, opts.limitPerSeller - gathered);
        const inventory = await client.getInventory(selectedStore.sellerUsername, { page, perPage, sort: 'listed', sortOrder: 'desc' });
        const batch = inventory.listings || [];
        gathered += batch.length;
        for (const raw of batch) {
          const item = normalizeInventoryListing(raw, selectedStore.sellerUsername);
          if (!Number.isFinite(item.releaseId) || !Number.isFinite(item.listingId)) continue;
          if (!looksLikeVinyl(item.format)) { skippedNonVinyl += 1; continue; }
          listings.push(item);
        }
        send({ phase: 'inventory', store: selectedStore.name, storeIndex, stores: selectedStores.length, checked: gathered, total: opts.limitPerSeller });
        const pages = Number(inventory.pagination && inventory.pagination.pages) || 1;
        if (!batch.length || page >= pages) break;
        page += 1;
      }
    }

    const metadata = new Map();
    const uniqueReleaseIds = [...new Set(listings.map((listing) => listing.releaseId))];
    let cacheHits = 0;
    let checked = 0;
    const results = [];
    for (const releaseId of uniqueReleaseIds) {
      if (cityDigAbort) break;
      let meta = store.getReleaseMeta(releaseId);
      if (meta && meta.ts && Date.now() - meta.ts < RELEASE_META_TTL_MS) cacheHits += 1;
      else {
        try {
          const release = await client.getRelease(releaseId);
          meta = release ? { ts: Date.now(), ...release } : null;
          if (meta) store.setReleaseMeta(releaseId, meta);
        } catch (error) {
          if (error && error.status === 401) throw error;
          meta = null;
        }
      }
      if (meta) metadata.set(releaseId, meta);
      checked += 1;
      send({ phase: 'taxonomy', checked, total: uniqueReleaseIds.length, found: results.length, cacheHits });
    }

    for (const listing of listings) {
      const meta = metadata.get(listing.releaseId);
      if (!meta) continue;
      const matchedTaxonomies = matchTaxonomies(meta, opts.taxonomies);
      if (!matchedTaxonomies.length) continue;
      const selectedStore = storesBySeller.get(listing.sellerUsername) || {};
      results.push({
        ...listing,
        artist: meta.artist || listing.artist,
        title: meta.title || listing.title,
        year: meta.year || listing.year,
        country: meta.country || null,
        thumb: meta.thumb || listing.thumb,
        genres: meta.genres || [],
        styles: meta.styles || [],
        labels: meta.labels || [],
        matchedTaxonomies,
        storeId: selectedStore.id || null,
        storeName: selectedStore.name || listing.sellerUsername,
        storeAddress: selectedStore.address || '',
        listingUrl: `https://www.discogs.com/sell/item/${listing.listingId}`,
        sellerUrl: `https://www.discogs.com/seller/${encodeURIComponent(listing.sellerUsername)}/profile`,
        releaseUrl: `https://www.discogs.com/release/${listing.releaseId}`,
      });
    }

    const output = {
      ts: Date.now(),
      city: { id: city.id, name: city.name, country: city.country },
      query: opts,
      inspected: listings.length,
      releasesChecked: checked,
      cacheHits,
      skippedNonVinyl,
      aborted: cityDigAbort,
      results,
    };
    try { fs.writeFileSync(LAST_CITY_DIG_FILE(), JSON.stringify(output, null, 2)); } catch { /* persistence is best effort */ }
    send({ phase: 'done', checked, total: uniqueReleaseIds.length, found: results.length, aborted: cityDigAbort, cacheHits });
    return output;
  } finally {
    cityDigRunning = false;
  }
}

function lastScan() {
  try { return JSON.parse(fs.readFileSync(LAST_SCAN_FILE(), 'utf8')); } catch { return null; }
}

// ---------------------------------------------------------------------------
// Auto-verification of the cloud feed — "is this card still buyable, and in what condition?"
// ---------------------------------------------------------------------------
// A cloud deal is an API-only, moment-in-time alert: no condition, estimated shipping, and the copy
// may have sold since. This re-checks the releases on the visible cloud feed through the SAME
// residential-IP browser pipeline the local scan uses (one sell-page navigation + the same-origin
// listings JSON per release), so every card shows live, condition-confirmed data — automatically,
// no button. Results are cached (VERIFY_TTL_MS) so the renderer's 30s deals poll costs nothing;
// a release is re-scraped at most twice an hour. ~13 releases ≈ under a minute, GET-only, paced.
let verifyRunning = false;
const VERIFY_TTL_MS = 30 * 60 * 1000;
const verifyCache = new Map(); // releaseId -> { ts, cheapest, bestVgPlus, copies, vgPlusCount, error }

// Trim a selectByCondition copy to the fields the renderer needs (plus a direct buy link).
const trimCopy = (c, history = null) => (c ? {
  itemId: c.itemId ?? null, price: c.price ?? null, currency: c.currency || null,
  media: c.media || null, sleeve: c.sleeve || null,
  shipping: c.shipping ?? null, shippingSource: c.shippingSource || null,
  shipsFrom: c.shipsFrom || null,
  url: c.url || (c.itemId ? `https://www.discogs.com/sell/item/${c.itemId}` : null),
  history,
} : null);

async function runVerify(win, items) {
  const send = (m) => { try { win.webContents.send('verify:progress', m); } catch { /* window gone */ } };
  const wanted = [];
  const seen = new Set();
  for (const it of (Array.isArray(items) ? items : [])) {
    const id = it && it.releaseId;
    if (id == null || seen.has(id)) continue;
    seen.add(id);
    wanted.push({ releaseId: id, currency: it.currency || 'EUR' });
  }
  const results = {};
  const stale = [];
  const now = Date.now();
  for (const w of wanted) {
    const c = verifyCache.get(w.releaseId);
    if (c && now - c.ts < VERIFY_TTL_MS) results[w.releaseId] = c;
    else stale.push(w);
  }
  // Never contend with a running scan (its results are live anyway) or a second verify pass —
  // cached results still go back so the renderer keeps whatever is already known.
  if (!stale.length || scrapeRunning || verifyRunning) return { results, checked: 0 };
  verifyRunning = true;
  let cfWin = null;
  let checked = 0;
  try {
    const { engine } = loadWatcher();
    cfWin = new BrowserWindow({ show: false, width: 1200, height: 900, webPreferences: { images: false } });
    cfWin.loadURL('https://www.discogs.com/', { userAgent: DISCOGS_UA }).catch(() => {});
    scrapeAbort = false; // waitFor consults this global; a previously-aborted scan must not poison the check
    const cap = stale.slice(0, 40); // sanity cap — the visible feed is ~a dozen releases
    for (const w of cap) {
      if (scrapeRunning) break; // a scan just started — get out of its way; the rest re-checks later
      send({ phase: 'verifying', done: checked, total: cap.length });
      const r = { releaseId: w.releaseId, ts: Date.now(), error: null, copies: null, vgPlusCount: null, cheapest: null, bestVgPlus: null };
      try {
        const data = await loadReleaseData(cfWin, w.releaseId, w.currency, { needSold: false });
        if (Array.isArray(data.listings)) {
          const listingMovements = observeListings(w.releaseId, data.listings, data.totalCount, r.ts);
          const pick = engine.selectByCondition(data.listings, { minCondition: 'Very Good Plus (VG+)' });
          r.copies = pick.totalCount != null ? pick.totalCount : data.listings.length;
          r.vgPlusCount = pick.acceptableCount != null ? pick.acceptableCount : null;
          // cheapestAny is ordered by TOTAL (price+shipping) — the best actual buy. For the
          // "is the alerted price still listed?" question we need the lowest bare ITEM price.
          r.lowestPrice = data.listings.reduce((m, l) => (l.price != null && l.price > 0 && (m == null || l.price < m) ? l.price : m), null);
          r.cheapest = trimCopy(pick.cheapestAny, pick.cheapestAny && pick.cheapestAny.itemId != null ? listingMovements[String(pick.cheapestAny.itemId)] || null : null);
          r.bestVgPlus = trimCopy(pick.best, pick.best && pick.best.itemId != null ? listingMovements[String(pick.best.itemId)] || null : null);
        } else r.error = data.cleared ? 'listings' : 'cloudflare';
      } catch (e) { r.error = String((e && e.message) || e); }
      verifyCache.set(w.releaseId, r);
      results[w.releaseId] = r;
      checked++;
      await sleep(800); // gentle pacing between releases — a small, occasional sweep
    }
    send({ phase: 'done', done: checked, total: cap.length });
    return { results, checked };
  } finally {
    verifyRunning = false;
    if (cfWin) { try { cfWin.destroy(); } catch { /* already gone */ } }
  }
}

// ---------------------------------------------------------------------------
// Discogs account config — written by the first-run setup wizard.
// ---------------------------------------------------------------------------
// Lives in config.json (dataDir): the same shape watcher.js loadConfig() reads, so a packaged
// app and the dev/owner project share one format. We never send the token back to the renderer
// (only `hasToken`); the wizard collects a fresh one if the user wants to change it.
function readConfigFile() {
  try { return JSON.parse(fs.readFileSync(configPath(), 'utf8')); } catch { return {}; }
}
function writeConfigFile(patch) {
  const next = { ...readConfigFile(), ...(patch || {}) };
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(next, null, 2));
  return true;
}

// Validate Discogs credentials live: the personal token via /oauth/identity (401 if bad), and the
// username by counting its wantlist. Returns a friendly {ok, username, wantlist} / {ok:false, error}.
async function testConfig({ username, token } = {}) {
  let makeClient;
  try { ({ makeClient } = loadWatcher()); }
  catch (e) { return { ok: false, error: e.message }; }
  const client = makeClient({ token: (token || '').trim(), userAgent: 'DiscogsDealShark/1.0 (desktop setup test)' });
  let who;
  try {
    const id = await client.req('/oauth/identity');
    who = id && id.data ? id.data.username : null;
    if (!who) return { ok: false, error: 'Token werd niet geaccepteerd — controleer je persoonlijke token.' };
  } catch (e) {
    if (e && e.status === 401) return { ok: false, error: 'Token ongeldig (401) — controleer je persoonlijke token.' };
    return { ok: false, error: 'Kon Discogs niet bereiken: ' + (e && e.message ? e.message : String(e)) };
  }
  const uname = (username || '').trim();
  if (!uname) return { ok: true, username: who, wantlist: null };
  try {
    const wl = await client.getWantlist(uname);
    return { ok: true, username: who, wantlist: wl.length };
  } catch (e) {
    return { ok: false, error: `Token werkt (ingelogd als ${who}), maar wantlist van "${uname}" ophalen mislukte: ${e && e.message ? e.message : e}` };
  }
}

ipcMain.handle('config:get', () => {
  const c = readConfigFile();
  return {
    username: c.username || '',
    currency: c.currency || 'EUR',
    hasToken: !!c.token,
    minDiscount: c.minDiscount,
    minReference: c.minReference,
    shippingEstimate: c.shippingEstimate,
  };
});
ipcMain.handle('config:set', (_e, patch) => writeConfigFile(patch));
ipcMain.handle('config:test', (_e, creds) => testConfig(creds || {}));

ipcMain.handle('settings:get', () => readSettings());
ipcMain.handle('settings:set', (_e, s) => { writeSettings(s); return true; });
ipcMain.handle('deals:get', (_e, limit) => getDeals(limit));
ipcMain.handle('gems:get', () => getGems());
ipcMain.handle('status:get', () => getStatus());
ipcMain.handle('health:get', () => getServiceHealth());
ipcMain.handle('open:external', (_e, url) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); });
ipcMain.handle('scrape:run', (e, opts) => runScrape(BrowserWindow.fromWebContents(e.sender), opts || {}));
ipcMain.handle('verify:run', (e, items) => runVerify(BrowserWindow.fromWebContents(e.sender), items || []));
ipcMain.handle('scrape:cancel', () => { scrapeAbort = true; return true; });
ipcMain.handle('scrape:last', () => lastScan());
ipcMain.handle('scout:run', (e, opts) => runScout(BrowserWindow.fromWebContents(e.sender), opts || {}));
ipcMain.handle('scout:cancel', () => { scoutAbort = true; return true; });
ipcMain.handle('scout:last', () => lastScout());
ipcMain.handle('scout:addWant', (_e, releaseId) => addScoutWant(releaseId));
ipcMain.handle('cityDig:data', () => CITY_DIG_CITIES);
ipcMain.handle('cityDig:counts', (_e, cityId) => cityDigCounts(cityId));
ipcMain.handle('cityDig:run', (e, opts) => runCityDig(BrowserWindow.fromWebContents(e.sender), opts || {}));
ipcMain.handle('cityDig:cancel', () => { cityDigAbort = true; return true; });
ipcMain.handle('cityDig:last', () => lastCityDig());
ipcMain.handle('discogs:loginStatus', () => isDiscogsLoggedIn());
ipcMain.handle('discogs:login', () => startDiscogsLogin());
// Medians push status — null hides the badge (packaged installs never push: there's no repo; and
// with autoPushMedians off there's nothing to report). Retry lets the user fix a red badge in place.
ipcMain.handle('medians:pushStatus', () => {
  if (app.isPackaged || readSettings().autoPushMedians === false) return null;
  return readPushStatus();
});
ipcMain.handle('medians:retryPush', async () => {
  if (app.isPackaged) return { ok: false, pushed: false, reason: 'not available in a packaged install' };
  const res = await autoPushSoldMedians();
  const st = { ts: Date.now(), ...res };
  writePushStatus(st);
  return st;
});

// ---------------------------------------------------------------------------
// ☁ Cloud setup — fork the watcher repo + configure it, all from inside the app.
// ---------------------------------------------------------------------------
// The 24/7 email watcher is "your own copy of the public repo, running on GitHub Actions".
// Setting that up by hand is ~15 min of GitHub clicking (fork, five secrets, enable workflow,
// first run) — this wizard does all of it through the GitHub API with a user-supplied token.
// The Discogs credentials are reused from the local config.json (the first-run wizard already
// collected them); the GitHub/Resend tokens are used here and stored ONLY as encrypted GitHub
// Actions secrets on the user's own fork — never persisted locally.
const UPSTREAM_REPO = 'norsnors/discogs-deal-shark';
const LEGACY_UPSTREAM_REPO = 'norsnors/discogs-deal-watcher';

async function ghReq(token, method, pathname, body) {
  const to = withTimeout(20_000);
  try {
    const res = await fetch('https://api.github.com' + pathname, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        authorization: 'Bearer ' + token,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: to.signal,
    });
    let data = null;
    try { data = await res.json(); } catch { /* 204s and error pages have no JSON body */ }
    return { status: res.status, data };
  } finally { to.done(); }
}

// GitHub Actions secrets are encrypted client-side with the repo's public key (libsodium sealed
// box) — the API rejects plaintext. This is the documented flow from GitHub's own REST docs.
async function encryptSecret(publicKeyB64, value) {
  const sodium = require('libsodium-wrappers'); // lazy: only loaded when the wizard runs
  await sodium.ready;
  const key = sodium.from_base64(publicKeyB64, sodium.base64_variants.ORIGINAL);
  const sealed = sodium.crypto_box_seal(sodium.from_string(value), key);
  return sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL);
}

async function findExistingFork(githubToken, login) {
  const configured = (readSettings().githubRepo || '').trim().replace(/^https?:\/\/github\.com\//, '').replace(/\/+$/, '');
  const candidates = [...new Set([
    configured,
    `${login}/discogs-deal-shark`,
    `${login}/discogs-deal-watcher`
  ].filter(Boolean))];
  for (const candidate of candidates) {
    const response = await ghReq(githubToken, 'GET', `/repos/${candidate}`);
    const repo = response.data;
    const parent = repo && repo.parent ? String(repo.parent.full_name).toLowerCase() : '';
    if (response.status === 200 && repo && repo.fork && [UPSTREAM_REPO, LEGACY_UPSTREAM_REPO].map((name) => name.toLowerCase()).includes(parent)) {
      return repo.full_name;
    }
  }
  const forks = await ghReq(githubToken, 'GET', `/repos/${UPSTREAM_REPO}/forks?per_page=100`);
  if (forks.status === 200 && Array.isArray(forks.data)) {
    const own = forks.data.find((repo) => repo && repo.owner && String(repo.owner.login).toLowerCase() === String(login).toLowerCase());
    if (own && own.full_name) return own.full_name;
  }
  return null;
}

let cloudSetupRunning = false;
async function setupCloud(win, { githubToken, mailTo, resendKey } = {}) {
  if (cloudSetupRunning) throw new Error('Cloud setup is already running.');
  cloudSetupRunning = true;
  const step = (id, state, detail) => { try { win.webContents.send('cloud:progress', { step: id, state, detail }); } catch { /* window gone */ } };
  try {
    githubToken = (githubToken || '').trim();
    mailTo = (mailTo || '').trim();
    resendKey = (resendKey || '').trim();
    const cfg = readConfigFile();
    if (!cfg.token || !cfg.username) throw new Error('Set up your Discogs account first (Settings → Discogs account), then run this again.');
    if (!githubToken) throw new Error('Paste a GitHub token first.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mailTo)) throw new Error('Enter the email address that should receive the alerts.');
    if (!resendKey) throw new Error('Paste your Resend API key first.');

    // 1. Verify both tokens up-front, so a typo fails here instead of as a broken cloud run later.
    step('verify', 'busy');
    const me = await ghReq(githubToken, 'GET', '/user');
    if (me.status === 401) throw new Error('GitHub rejected the token (401) — generate a classic token with the "repo" and "workflow" scopes.');
    if (me.status !== 200 || !me.data || !me.data.login) throw new Error('Could not reach GitHub (HTTP ' + me.status + ').');
    const login = me.data.login;
    const rkTo = withTimeout(15_000);
    try {
      const rk = await fetch('https://api.resend.com/domains', { headers: { authorization: 'Bearer ' + resendKey }, signal: rkTo.signal });
      if (rk.status === 401 || rk.status === 403) throw new Error('Resend rejected the API key — create one at resend.com/api-keys and paste it exactly.');
    } finally { rkTo.done(); }
    step('verify', 'ok', 'GitHub: ' + login);

    // 2. Fork. Reuse an existing fork before POSTing: GitHub's create-fork endpoint itself is not
    // reliably idempotent and may return 422 on a resumed, half-finished setup.
    step('fork', 'busy');
    let fork = await findExistingFork(githubToken, login);
    if (!fork) {
      const fk = await ghReq(githubToken, 'POST', `/repos/${UPSTREAM_REPO}/forks`, { default_branch_only: true });
      if (fk.status === 202 || fk.status === 200) fork = fk.data && fk.data.full_name;
      else {
        await sleep(2000);
        fork = await findExistingFork(githubToken, login);
        if (!fork) {
          const msg = fk.data && fk.data.message ? ' — ' + fk.data.message : '';
          throw new Error('Could not create your copy of the watcher repo (HTTP ' + fk.status + msg + ').');
        }
      }
    }
    if (!fork) throw new Error('GitHub did not return the name of your watcher repository.');
    // Forking is async on GitHub's side — poll until the repo actually answers.
    let ready = false;
    for (let i = 0; i < 30 && !ready; i++) {
      const r = await ghReq(githubToken, 'GET', '/repos/' + fork);
      if (r.status === 200) ready = true;
      else await sleep(3000);
    }
    if (!ready) throw new Error('Your copy (' + fork + ') did not become available in time — wait a minute and run the setup again (it continues where it stopped).');
    step('fork', 'ok', fork);

    // 3. Secrets. Actions on a fresh fork can take a moment to initialize — retry the public key.
    step('secrets', 'busy');
    await ghReq(githubToken, 'PUT', `/repos/${fork}/actions/permissions`, { enabled: true, allowed_actions: 'all' }).catch(() => { /* usually already enabled */ });
    let pk = null;
    for (let i = 0; i < 10 && !pk; i++) {
      const r = await ghReq(githubToken, 'GET', `/repos/${fork}/actions/secrets/public-key`);
      if (r.status === 200 && r.data && r.data.key) pk = r.data;
      else await sleep(3000);
    }
    if (!pk) throw new Error('GitHub is still initializing Actions on your copy — wait a minute and run the setup again.');
    const secrets = {
      DISCOGS_USERNAME: cfg.username,
      DISCOGS_TOKEN: cfg.token,
      MAIL_TO: mailTo,
      RESEND_API_KEY: resendKey,
      // The user's own PAT doubles as the keepalive: its pushes count as user activity, which is
      // what stops GitHub's 60-day auto-disable of the schedule (see watch.yml).
      KEEPALIVE_PAT: githubToken,
    };
    for (const [name, value] of Object.entries(secrets)) {
      const encrypted_value = await encryptSecret(pk.key, value);
      const r = await ghReq(githubToken, 'PUT', `/repos/${fork}/actions/secrets/${name}`, { encrypted_value, key_id: pk.key_id });
      if (r.status !== 201 && r.status !== 204) throw new Error('Could not store the ' + name + ' setting (HTTP ' + r.status + ').');
    }
    step('secrets', 'ok');

    // 4. Switch the sweep on. Workflows in a fork start disabled; enable just ours, then fire the
    // first run so the user sees it working (and gets the first email batch) without waiting for
    // GitHub's (heavily delayed) schedule.
    step('enable', 'busy');
    let enabled = false; let lastStatus = 0;
    for (let i = 0; i < 10 && !enabled; i++) {
      const r = await ghReq(githubToken, 'PUT', `/repos/${fork}/actions/workflows/${CRON_WORKFLOW}/enable`);
      lastStatus = r.status;
      if (r.status === 204) enabled = true;
      else await sleep(3000);
    }
    if (!enabled) throw new Error('Could not switch the cloud scan on (HTTP ' + lastStatus + ') — open github.com/' + fork + '/actions, click "Enable workflows", and run this setup again.');
    const disp = await ghReq(githubToken, 'POST', `/repos/${fork}/actions/workflows/${CRON_WORKFLOW}/dispatches`, { ref: 'main' });
    if (disp.status !== 204) throw new Error('Cloud scan is on, but starting the first run failed (HTTP ' + disp.status + ') — open github.com/' + fork + '/actions and press "Run workflow" once.');
    step('enable', 'ok');

    // 5. Point the dashboard's heartbeat (svc badge + ☁ cloud-scan pill) at the fork. The deal
    // SOURCE deliberately stays the local scan — it is fresher and condition-confirmed; the fork's
    // job is the 24/7 email. (cronRepo() reads settings.githubRepo first, so the pill lights up.)
    writeSettings({ ...readSettings(), githubRepo: fork });
    step('done', 'ok', fork);
    return { ok: true, fork, url: `https://github.com/${fork}/actions` };
  } finally {
    cloudSetupRunning = false;
  }
}

ipcMain.handle('cloud:setup', async (e, opts) => {
  try { return await setupCloud(BrowserWindow.fromWebContents(e.sender), opts || {}); }
  catch (err) { return { ok: false, error: err && err.message ? err.message : String(err) }; }
});

// ── Telegram push setup ────────────────────────────────────────────────────
// Telegram alerts are sent by the CLOUD watcher (the fork), exactly like the emails — so "connecting
// Telegram" means storing TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID as secrets on the user's fork. That's
// why it needs the fork (from the cloud-email setup) + a transient GitHub token. The local scan never
// pushes, so nothing here runs unless the cloud watcher is set up.

// Resolve the user's chat id from the bot's recent updates and send a test message. Called before
// connecting so the user sees it work first. botToken-only in; returns the discovered chatId + name.
async function telegramTest({ botToken, chatId } = {}) {
  botToken = (botToken || '').trim();
  chatId = (chatId || '').trim();
  if (!botToken) throw new Error('Paste your bot token first (from @BotFather).');
  let chatName = null;
  if (!chatId) {
    // getUpdates returns the messages people have sent the bot recently — the user tapping Start on
    // their new bot puts their own chat there. (No webhook is set on a fresh bot, so this works.)
    const to = withTimeout(15_000);
    let data = null;
    try {
      const r = await fetch(`https://api.telegram.org/bot${botToken}/getUpdates`, { signal: to.signal });
      data = await r.json().catch(() => null);
      if (r.status === 401 || (data && data.error_code === 401)) throw new Error('Telegram rejected the bot token — copy it exactly from @BotFather.');
    } finally { to.done(); }
    const chats = [];
    for (const u of (data && data.result) || []) {
      const c = (u.message && u.message.chat) || (u.my_chat_member && u.my_chat_member.chat);
      if (c && c.id != null && !chats.some((x) => x.id === c.id)) {
        chats.push({ id: c.id, name: [c.first_name, c.last_name].filter(Boolean).join(' ') || c.username || String(c.id) });
      }
    }
    if (!chats.length) throw new Error('Open your bot in Telegram and tap Start (or send it any message), then press Test again.');
    const last = chats[chats.length - 1]; // the most recent chat that messaged the bot
    chatId = String(last.id);
    chatName = last.name;
  }
  const to2 = withTimeout(15_000);
  try {
    const r = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId, parse_mode: 'HTML', disable_web_page_preview: true,
        text: '✅ <b>Discogs Deal Shark</b> is connected. Deal &amp; 💎 rare-gem alerts will arrive here.',
      }),
      signal: to2.signal,
    });
    const body = await r.json().catch(() => null);
    if (!r.ok || (body && body.ok === false)) throw new Error('Could not send a test message (' + ((body && body.description) || ('HTTP ' + r.status)) + ').');
  } finally { to2.done(); }
  return { ok: true, chatId: String(chatId), name: chatName };
}

let telegramSetupRunning = false;
async function setupTelegram(win, { githubToken, botToken, chatId } = {}) {
  if (telegramSetupRunning) throw new Error('Telegram setup is already running.');
  telegramSetupRunning = true;
  const step = (id, state, detail) => { try { win.webContents.send('telegram:progress', { step: id, state, detail }); } catch { /* window gone */ } };
  try {
    githubToken = (githubToken || '').trim();
    botToken = (botToken || '').trim();
    chatId = (chatId || '').trim();
    if (!botToken || !chatId) throw new Error('Press Test first so we have your bot token and chat.');
    if (!githubToken) throw new Error('Paste your GitHub token so this can be saved to your cloud watcher.');
    const fork = (readSettings().githubRepo || '').trim();
    if (!fork) throw new Error('Set up 24/7 email alerts first — Telegram alerts run on that same cloud watcher.');

    step('verify', 'busy');
    const me = await ghReq(githubToken, 'GET', '/user');
    if (me.status === 401) throw new Error('GitHub rejected the token (401) — use a classic token with the "repo" and "workflow" scopes.');
    if (me.status !== 200 || !me.data || !me.data.login) throw new Error('Could not reach GitHub (HTTP ' + me.status + ').');
    step('verify', 'ok', 'GitHub: ' + me.data.login);

    step('secrets', 'busy');
    let pk = null;
    for (let i = 0; i < 10 && !pk; i++) {
      const r = await ghReq(githubToken, 'GET', `/repos/${fork}/actions/secrets/public-key`);
      if (r.status === 200 && r.data && r.data.key) pk = r.data;
      else if (r.status === 404) throw new Error('Your cloud copy (' + fork + ') was not found — re-run the email setup, then try again.');
      else await sleep(2000);
    }
    if (!pk) throw new Error('GitHub did not return the encryption key for ' + fork + ' — wait a moment and try again.');
    for (const [name, value] of Object.entries({ TELEGRAM_BOT_TOKEN: botToken, TELEGRAM_CHAT_ID: chatId })) {
      const encrypted_value = await encryptSecret(pk.key, value);
      const r = await ghReq(githubToken, 'PUT', `/repos/${fork}/actions/secrets/${name}`, { encrypted_value, key_id: pk.key_id });
      if (r.status !== 201 && r.status !== 204) throw new Error('Could not store the ' + name + ' setting (HTTP ' + r.status + ').');
    }
    step('secrets', 'ok');

    // Fire a run so Telegram takes effect now, not at the next (heavily delayed) cron tick.
    step('enable', 'busy');
    await ghReq(githubToken, 'POST', `/repos/${fork}/actions/workflows/${CRON_WORKFLOW}/dispatches`, { ref: 'main' }).catch(() => { /* non-fatal: the schedule will pick it up */ });
    step('enable', 'ok');

    writeSettings({ ...readSettings(), telegramConnected: true });
    step('done', 'ok', fork);
    return { ok: true, fork };
  } finally {
    telegramSetupRunning = false;
  }
}

ipcMain.handle('telegram:test', async (e, opts) => {
  try { return await telegramTest(opts || {}); }
  catch (err) { return { ok: false, error: err && err.message ? err.message : String(err) }; }
});
ipcMain.handle('telegram:setup', async (e, opts) => {
  try { return await setupTelegram(BrowserWindow.fromWebContents(e.sender), opts || {}); }
  catch (err) { return { ok: false, error: err && err.message ? err.message : String(err) }; }
});

let mainWindow = null;

function createWindow() {
  const win = new BrowserWindow({
    width: 1120, height: 800, minWidth: 720, minHeight: 520,
    show: false, backgroundColor: '#0f1115',
    title: 'Discogs Deal Shark',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  mainWindow = win;
  // Closing the MAIN window = quitting the app. Without this, a hidden helper window (the
  // Cloudflare scan window during an auto-scan, or a Discogs login window) keeps the process
  // alive headless after the user closes the app; that zombie then owns the single-instance
  // lock, and the next launch makes IT crash with "Object has been destroyed".
  win.on('closed', () => {
    mainWindow = null;
    scrapeAbort = true;
    scoutAbort = true;
    cityDigAbort = true;
    if (process.platform !== 'darwin') app.quit();
  });
  win.removeMenu();
  win.loadFile('index.html');
  // Show only once painted, to avoid the white flash (same pattern as BPM Tapper).
  win.once('ready-to-show', () => win.show());
}

// Single-instance lock. Every window/dir path (settings.json, last-scan.json, state/) is shared, so
// two live instances stomp each other's state — one runs a scan and overwrites last-scan.json while
// the other shows stale data, which reads to the user as the dashboard "jumping back in time". So a
// second launch must NOT spawn a rival: it just focuses the window that's already open.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // Guard against a destroyed window: touching it throws "Object has been destroyed" in an
    // app-level handler, which surfaces as a crash dialog. If the window is gone but the process
    // survived (see the closed-handler note in createWindow), reopen it instead.
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    } else {
      createWindow();
    }
  });
  app.whenReady().then(createWindow);
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
}

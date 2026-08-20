'use strict';
/*
 * renderer.js — dashboard UI. Talks to the main process only through window.api (preload IPC).
 * When window.api is absent (a plain browser preview), it falls back to DEMO data so the layout
 * is still viewable.
 *
 * Philosophy: detect PERMISSIVELY (the scan / cloud collect every bargain), then filter POWERFULLY
 * here. All the sliders (min value, % off, max total, shipping estimate) and the sort run live in
 * the browser over the loaded deals — so dialling in "show me the real diamonds" never needs a
 * re-scan and never throws away the €2-for-€100 outlier.
 *
 * Two view modes:
 *   'cloud' — passive: deals the cloud watcher already found (polled every 30s). The default.
 *   'scan'  — the results of a local "⚡ Scan now" full sweep. Polling pauses while shown.
 */

const hasApi = typeof window.api !== 'undefined';

const DEMO = [
  // Confirmed (scan) deals: real media condition read off the live listing.
  { id: 'demo1', releaseId: 249504, artist: 'Imagination', title: 'Night Dubbing', lowest: 8.5, currency: 'EUR', shipping: 4.5, shipsFrom: 'Germany', numForSale: 14, vgPlusCount: 5, cheapVgPlusCount: 4, cheapVgPlusLow: 13, cheapVgPlusHigh: 17, altGrade: 'Near Mint (NM or M-)', altPrice: 14.5, altUrl: 'https://www.discogs.com/sell/item/112', reference: 32, referenceSource: 'sold-median', soldLow: 18, soldHigh: 45, discount: 0.73, conditionConfirmed: true, mediaCondition: 'Very Good Plus (VG+)', sleeveCondition: 'Very Good Plus (VG+)', cheaperWornPrice: 4.0, cheaperWornCondition: 'Good (G)', freshListing: true, ownDrop: 0.5, spark: [22, 20, 21, 19, 18, 17, 16, 15, 14, 12, 10, 8.5], listingUrl: 'https://www.discogs.com/sell/item/111', url: 'https://www.discogs.com/sell/item/111', ts: Date.now() - 4 * 60000, thumb: '' },
  { id: 'demo2', releaseId: 67890, artist: 'Gino Soccio', title: 'Outline', lowest: 11.0, currency: 'EUR', shipping: 0, shipsFrom: 'Netherlands', numForSale: 22, vgPlusCount: 8, reference: 30, referenceSource: 'suggestion', discount: 0.63, conditionConfirmed: true, mediaCondition: 'Near Mint (NM or M-)', sleeveCondition: 'Very Good (VG)', freshListing: false, ownDrop: 0.2, spark: [13, 12, 12.5, 11.5, 12, 11.5, 12, 11.5, 11, 11.5, 11, 11], listingUrl: 'https://www.discogs.com/sell/item/222', url: 'https://www.discogs.com/sell/item/222', ts: Date.now() - 90 * 60000, thumb: '' },
  // Unconfirmed (cloud/API) deals: condition unknown -> only a price-proxy estimate, hidden by "VG+ only".
  { id: 'demo3', releaseId: 12345, artist: 'Klein & M.B.O.', title: 'Dirty Talk', lowest: 4.0, currency: 'EUR', numForSale: 3, reference: 26, referenceSource: 'trailing-median', discount: 0.85, conditionConfirmed: false, suspicious: true, pricedAsWorn: true, impliedGrade: null, freshListing: false, ownDrop: 0.7, url: 'https://www.discogs.com/sell/release/12345?sort=price%2Casc', ts: Date.now() - 32 * 60000, thumb: '' },
  { id: 'demo4', releaseId: 1111, artist: 'Mr. Flagio', title: 'Take A Chance', lowest: 2.0, currency: 'EUR', numForSale: 1, reference: 120, referenceSource: 'suggestion', discount: 0.98, conditionConfirmed: false, suspicious: true, pricedAsWorn: true, impliedGrade: null, freshListing: true, ownDrop: 0.9, url: 'https://www.discogs.com/sell/release/1111?sort=price%2Casc', ts: Date.now() - 1 * 60000, thumb: '' },
];

// Demo data for the 💎 Rare tab (browser preview only).
const DEMO_GEMS = {
  ts: Date.now(),
  gems: [
    { id: 'dg1', releaseId: 1111, artist: 'Mr. Flagio', title: 'Take A Chance', lowest: 95, currency: 'EUR', numForSale: 1, reference: 120, referenceSource: 'sold-median', recentSales: [{ date: '2026-05-24', price: 165, media: 'NM' }, { date: '2025-07-27', price: 100, media: 'VG' }, { date: '2024-12-31', price: 141.23, media: 'NM' }], url: 'https://www.discogs.com/sell/release/1111?sort=price%2Casc', ts: Date.now() - 12 * 60000, thumb: '' },
    { id: 'dg2', releaseId: 2222, artist: 'Squash Gang', title: 'I Want An Illusion', lowest: 40, currency: 'EUR', numForSale: 2, reference: null, referenceSource: null, url: 'https://www.discogs.com/sell/release/2222?sort=price%2Casc', ts: Date.now() - 3 * 3600000, thumb: '' },
    { id: 'dg3', releaseId: 6666, artist: 'Vinicio', title: 'Dance You And Me', lowest: 79.99, currency: 'EUR', numForSale: 1, reference: 42.5, referenceSource: 'sold-median', gone: true, url: 'https://www.discogs.com/sell/release/6666?sort=price%2Casc', ts: Date.now() - 26 * 3600000, thumb: '' },
  ],
  zeroWatch: [
    { releaseId: 3333, artist: 'Fockewulf 190', title: 'Body Heat', year: 1984 },
    { releaseId: 4444, artist: 'Ago', title: 'You Make Me Do It', year: 1985 },
    { releaseId: 5555, artist: 'Cellophane', title: 'Music Colours', year: 1983 },
  ],
};

const DEMO_SCOUT = {
  ts: Date.now(),
  query: { field: 'style', query: 'Italo-Disco', minValue: 80, limit: 100, currency: 'EUR' },
  inspected: 200,
  candidates: 97,
  excludedWantlist: 3,
  aborted: false,
  results: [
    { releaseId: 7001, artist: 'Koto', title: 'Visitors', year: 1985, country: 'Italy', formats: ['Vinyl', '12"'], styles: ['Italo-Disco'], labels: ['Memory Records'], estimatedValue: 145, valueSource: 'suggestion', currency: 'EUR', numForSale: 2, lowestPrice: 119, want: 826, have: 301, thumb: '', releaseUrl: 'https://www.discogs.com/release/7001', marketplaceUrl: 'https://www.discogs.com/sell/release/7001' },
    { releaseId: 7002, artist: 'Charlie', title: 'Spacer Woman', year: 1983, country: 'Italy', formats: ['Vinyl', '12"'], styles: ['Italo-Disco'], labels: ['Mr. Disc Organization'], estimatedValue: 105, valueSource: 'sold-median', currency: 'EUR', numForSale: 0, lowestPrice: null, want: 1412, have: 578, thumb: '', releaseUrl: 'https://www.discogs.com/release/7002', marketplaceUrl: 'https://www.discogs.com/sell/release/7002' },
  ],
};

const DEMO_CITY_DIG = {
  ts: Date.now(),
  city: { id: 'antwerp', name: 'Antwerp', country: 'Belgium' },
  query: { cityId: 'antwerp', sellerUsernames: ['wgwstore', 'Tune-Up-Records'], taxonomies: ['Italo-Disco', 'Synth-pop', 'Electro'], limitPerSeller: 100, currency: 'EUR' },
  inspected: 100,
  releasesChecked: 96,
  cacheHits: 82,
  skippedNonVinyl: 4,
  aborted: false,
  results: [
    { listingId: 81001, releaseId: 7001, storeId: 'wallys-groove-world', storeName: "Wally's Groove World", storeAddress: 'Lange Nieuwstraat 126', sellerUsername: 'wgwstore', artist: 'My Mine', title: 'Hypnotic Tango', year: 1983, country: 'Italy', price: 14, currency: 'EUR', condition: 'Very Good Plus (VG+)', sleeveCondition: 'Very Good (VG)', format: '12\", Single', styles: ['Italo-Disco', 'Synth-pop'], genres: ['Electronic'], matchedTaxonomies: ['Italo-Disco', 'Synth-pop'], posted: '2026-08-11T12:00:00Z', listingUrl: 'https://www.discogs.com/sell/item/81001', sellerUrl: 'https://www.discogs.com/seller/wgwstore/profile', thumb: '' },
    { listingId: 81002, releaseId: 7002, storeId: 'tune-up', storeName: 'Tune Up', storeAddress: 'Melkmarkt 20', sellerUsername: 'Tune-Up-Records', artist: 'Koto', title: 'Visitors', year: 1985, country: 'Italy', price: 19.5, currency: 'EUR', condition: 'Near Mint (NM or M-)', sleeveCondition: 'Very Good Plus (VG+)', format: '12\"', styles: ['Italo-Disco'], genres: ['Electronic'], matchedTaxonomies: ['Italo-Disco'], posted: '2026-08-09T12:00:00Z', listingUrl: 'https://www.discogs.com/sell/item/81002', sellerUrl: 'https://www.discogs.com/seller/Tune-Up-Records/profile', thumb: '' },
  ],
};

let allDeals = [];
let allNearMisses = [];   // releases that looked cheap but didn't qualify (scan only) — see "Show near-misses"
let seenIds = new Set();
let firstLoad = true;
let viewMode = 'cloud';   // 'cloud' | 'scan'

let activeTab = 'deals';  // 'deals' | 'gems' | 'scout' | 'city'
let gemsData = { ts: null, gems: [], zeroWatch: [] };
let seenGemIds = new Set();
let firstGemLoad = true;
let scanning = false;
let scouting = false;
let scoutData = { ts: null, query: null, inspected: 0, candidates: 0, excludedWantlist: 0, aborted: false, results: [] };
let cityDigging = false;
let cityCountsLoaded = false;
let cityCities = Array.isArray(window.CITY_DIG_CITIES) ? window.CITY_DIG_CITIES : [];
let cityCounts = {};
let cityDigData = { ts: null, city: null, query: null, inspected: 0, releasesChecked: 0, cacheHits: 0, skippedNonVinyl: 0, aborted: false, results: [] };
let cityWorldMap = null;
let cityLocalMap = null;
let cityStoreMarkers = new Map();
let scannedOnce = false;  // has a local scan run (or its results been loaded) this session? Distinguishes
                          // "no scan yet — go scan" from "scanned, nothing matched right now".

// Marketplace is a first-class dimension: each platform keeps its own Deals/Rare Gems state while
// the shared cards, search and value filters are reused. Future adapters only need another entry
// here plus their own main-process IPC; Discogs-only tools remain separate tabs.
const savedPlatform = (() => { try { return localStorage.getItem('deal-shark-platform'); } catch { return null; } })();
let activePlatform = ['discogs', 'vinted', 'ebay', 'tradera'].includes(savedPlatform) ? savedPlatform : 'discogs';
const platformViews = {
  discogs: { deals: [], nearMisses: [], gems: { ts: null, gems: [], zeroWatch: [] }, viewMode: 'scan', scannedOnce: false },
  vinted: { deals: [], nearMisses: [], gems: { ts: null, gems: [], zeroWatch: [] }, viewMode: 'vinted', scannedOnce: false },
  ebay: { deals: [], nearMisses: [], gems: { ts: null, gems: [], zeroWatch: [] }, viewMode: 'ebay', scannedOnce: false },
  tradera: { deals: [], nearMisses: [], gems: { ts: null, gems: [], zeroWatch: [] }, viewMode: 'tradera', scannedOnce: false },
};
let vintedStatus = { enabled: false, running: false, health: 'idle', lastPollAt: null, nextPollAt: null, requestsLastHour: 0, message: null, backfill: { active: false, checked: 0, total: 0, listingsFound: 0 } };
let vintedRefreshBusy = false;
let ebayStatus = { enabled: false, configured: false, running: false, health: 'setup', lastPollAt: null, nextPollAt: null, callsToday: 0, dailyLimit: 4800, message: null, progress: null };
let ebayRefreshBusy = false;
let traderaStatus = { enabled: false, configured: false, running: false, health: 'setup', lastPollAt: null, nextPollAt: null, callsToday: 0, dailyLimit: 9500, message: null, progress: null, fx: null };
let traderaRefreshBusy = false;
const ALL_SCAN_LABELS = { discogs: 'Discogs', vinted: 'Vinted', ebay: 'eBay', tradera: 'Tradera' };
let scanAllRunning = false;
let scanAllSources = Object.fromEntries(Object.keys(ALL_SCAN_LABELS).map((source) => [source, { state: 'queued' }]));
let scanAllCompletionTimer = null;

const $ = (id) => document.getElementById(id);
const openUrl = (url) => { if (!url) return; if (hasApi) window.api.openExternal(url); else window.open(url, '_blank'); };

// --- Dismiss / snooze (client-side, persisted) ---
// Keyed by releaseId (deal ids change every sweep; the release is the stable identity). A dismissed
// release is hidden until you tick "show hidden" and restore it — keeps deals you've already judged
// out of the way without losing them.
const DISMISS_KEY = 'ddw-dismissed';
function loadDismissed() {
  try {
    // v1 stored bare Discogs release ids. Namespace them during load so hiding a Discogs pressing
    // can never accidentally hide the corresponding Vinted match (or a future marketplace).
    return new Set(JSON.parse(localStorage.getItem(DISMISS_KEY) || '[]').map((value) => {
      const key = String(value);
      return key.includes(':') ? key : `discogs:${key}`;
    }));
  } catch { return new Set(); }
}
let dismissed = loadDismissed();
const saveDismissed = () => { try { localStorage.setItem(DISMISS_KEY, JSON.stringify([...dismissed])); } catch { /* private mode */ } };
const sym = (c) => ({ EUR: '€', USD: '$', GBP: '£', SEK: 'SEK ' }[c] || '');
const money = (v, c) => (v == null ? '—' : sym(c) + Number(v).toFixed(2));
const pct = (d) => (d == null ? '—' : Math.round(d * 100) + '%');
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
const REF_LABEL = { 'sold-median': 'real sold median', suggestion: 'VG+ suggested', 'trailing-median': 'usual lowest' };

// "Very Good Plus (VG+)" -> "VG+"
const gradeShort = (g) => { if (!g) return null; const m = String(g).match(/\(([^)]+)\)/); return m ? m[1] : g; };

// "2026-05-24" -> "May '26" (mirrors mailer.js's fmtDateShort; duplicated because this file runs in
// the renderer with no require(), same reason REF_LABEL is duplicated rather than shared).
const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtDateShort(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  if (!m) return '';
  const mon = SHORT_MONTHS[parseInt(m[2], 10) - 1];
  return mon ? `${mon} '${m[1].slice(-2)}` : '';
}
const GOOD_GRADES = new Set(['M', 'NM or M-', 'NM', 'M-', 'VG+']); // VG+ or better
const VGPLUS_RANK = 2; // Discogs grade ladder: M=0, NM=1, VG+=2, VG=3, G+=4, G=5, F=6, P=7

// Rank a (possibly messy) condition label on the Discogs ladder. Confirmed conditions arrive in
// the full "Very Good Plus (VG+)" form, so the short-code map covers them; the text fallback
// tolerates anything else. Returns null when unrecognized.
const RANK_BY_SHORT = { M: 0, 'NM or M-': 1, NM: 1, 'M-': 1, 'VG+': 2, VG: 3, 'G+': 4, G: 5, F: 6, P: 7 };
function gradeRank(label) {
  if (!label) return null;
  const s = gradeShort(label);
  if (s != null && s in RANK_BY_SHORT) return RANK_BY_SHORT[s];
  const t = String(label).toLowerCase();
  if (t.includes('near mint') || /\bnm\b/.test(t)) return 1;
  if (t.includes('mint') || /\bm\b/.test(t)) return 0;
  if (t.includes('very good plus') || t.includes('vg+')) return 2;
  if (t.includes('very good') || /\bvg\b/.test(t)) return 3;
  if (t.includes('good plus') || t.includes('g+')) return 4;
  if (t.includes('good')) return 5;
  if (t.includes('fair')) return 6;
  if (t.includes('poor')) return 7;
  return null;
}

// Is this deal VG+ or better? Confirmed deals use the REAL media grade (a guarantee); unconfirmed
// deals fall back to the price proxy (not flagged worn or suspiciously low) — best effort only.
function isVgPlus(d) {
  if (d.conditionConfirmed && d.mediaCondition) { const r = gradeRank(d.mediaCondition); return r != null && r <= VGPLUS_RANK; }
  return !d.pricedAsWorn && !d.suspicious;
}

function ago(ts) {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}

const shipVal = () => parseFloat($('shipEst').value) || 0;

// Daily use stays intentionally simple. The full filter engine still exists, but lives behind one
// "Fine-tune" button and remembers the user's choices between app launches.
const FILTER_STATE_KEY = 'ddw-filter-state-v2';
const FILTER_DEFAULTS = {
  minValue: '25', minDiscount: '50', maxTotal: '0', shipEst: '5', sortBy: 'best',
  vgPlusOnly: false, freshOnly: false, showHidden: false, showNearMiss: false,
};
const FILTER_IDS = Object.keys(FILTER_DEFAULTS);

function readFilterState() {
  try { return { ...FILTER_DEFAULTS, ...JSON.parse(localStorage.getItem(FILTER_STATE_KEY) || '{}') }; }
  catch { return { ...FILTER_DEFAULTS }; }
}

function applyFilterState(state) {
  for (const id of FILTER_IDS) {
    const el = $(id);
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = !!state[id];
    else el.value = String(state[id]);
  }
}

function currentFilterState() {
  const state = {};
  for (const id of FILTER_IDS) {
    const el = $(id);
    state[id] = el.type === 'checkbox' ? el.checked : el.value;
  }
  return state;
}

function saveFilterState() {
  try { localStorage.setItem(FILTER_STATE_KEY, JSON.stringify(currentFilterState())); } catch { /* private mode */ }
}

function updateFilterUi() {
  const minValue = parseInt($('minValue').value, 10) || 0;
  const minDiscount = parseInt($('minDiscount').value, 10) || 0;
  const maxTotal = parseInt($('maxTotal').value, 10) || 0;
  const shipping = parseInt($('shipEst').value, 10) || 0;
  $('minValueVal').textContent = minValue > 0 ? `€${minValue}+` : 'Any';
  $('minDiscountVal').textContent = `${minDiscount}%`;
  $('maxTotalVal').textContent = maxTotal > 0 ? `€${maxTotal}` : 'Any';
  $('shipEstVal').textContent = `€${shipping}`;
  $('summary-discount').textContent = `${minDiscount}%+ off`;
  $('summary-value').textContent = minValue > 0 ? `€${minValue}+ value` : 'Any value';
  const sortLabels = { best: 'Best first', discount: 'Biggest discount', total: 'Lowest total', savings: 'Most saved', newest: 'Newest first' };
  $('summary-sort').textContent = sortLabels[$('sortBy').value] || 'Best first';

  const state = currentFilterState();
  const changed = FILTER_IDS.filter((id) => String(state[id]) !== String(FILTER_DEFAULTS[id])).length;
  const badge = $('filter-active-count');
  badge.textContent = changed ? String(changed) : '';
  badge.classList.toggle('hidden', !changed);
}

function setFilterPanel(open) {
  $('filter-panel').classList.toggle('hidden', !open);
  $('btn-filter-toggle').setAttribute('aria-expanded', open ? 'true' : 'false');
}

function onFilterChanged() {
  updateFilterUi();
  saveFilterState();
  render();
}

function resetFilters() {
  applyFilterState(FILTER_DEFAULTS);
  updateFilterUi();
  saveFilterState();
  render();
}

function updateViewCopy() {
  const gems = activeTab === 'gems';
  const scout = activeTab === 'scout';
  const city = activeTab === 'city';
  const vinted = activePlatform === 'vinted';
  const ebay = activePlatform === 'ebay';
  const tradera = activePlatform === 'tradera';
  if (vinted) {
    $('view-eyebrow').textContent = gems ? 'VINTED RARITY WATCH' : 'VINTED × YOUR WANTLIST';
    $('view-title').textContent = gems ? 'Wanted records that surfaced again' : 'Vinted deals before they disappear';
    $('view-intro').textContent = gems ? 'A targeted Vinted search found nothing, then a matching copy appeared — availability is the signal.' : 'Pressing-matched Vinted listings, valued against that exact Discogs release. Reissues and ambiguous versions are ignored.';
  } else if (ebay) {
    $('view-eyebrow').textContent = gems ? 'EBAY RARITY WATCH' : 'EBAY × YOUR WANTLIST';
    $('view-title').textContent = gems ? 'Wanted records newly available on eBay' : 'eBay deals worth opening';
    $('view-intro').textContent = gems ? 'An official eBay Browse search found no matching pressing, then a verified copy appeared.' : 'Official eBay listings, matched to exact Discogs pressings and ranked by landed cost versus sold median.';
  } else if (tradera) {
    $('view-eyebrow').textContent = gems ? 'TRADERA RARITY WATCH' : 'TRADERA × YOUR WANTLIST';
    $('view-title').textContent = gems ? 'Wanted records newly available on Tradera' : 'Tradera deals worth opening';
    $('view-intro').textContent = gems ? 'An official Tradera API search found no matching fixed-price pressing, then a verified copy appeared.' : 'Fixed-price Tradera listings, pressing-matched to Discogs and converted from SEK with the ECB daily rate.';
  } else {
    $('view-eyebrow').textContent = city ? 'DIG THE CITY' : (scout ? 'BEYOND YOUR WANTLIST' : (gems ? 'RARITY WATCH' : 'YOUR WANTLIST'));
    $('view-title').textContent = city ? 'Antwerp record stores, one inventory at a time' : (scout ? 'Scout valuable records you may be missing' : (gems ? 'Rare records that just surfaced' : 'Deals worth opening'));
    $('view-intro').textContent = city ? 'See every mapped shop for free, then load the first 100 vinyl listings from every connected Discogs seller in the city.' : (scout ? 'Search Discogs by style or genre, filter on estimated VG+ value, and add promising pressings straight to your wantlist.' : (gems ? 'First copies after a release was unavailable — price is context, availability is the signal.' : 'Verified copies ranked by total value, so the strongest opportunities stay on top.'));
  }
  $('search').placeholder = city ? 'Search loaded store inventory' : (gems ? 'Search rare records' : 'Search artist or release');
}

function until(ts) {
  const seconds = Math.max(0, Math.ceil((Number(ts) - Date.now()) / 1000));
  if (seconds < 60) return `in ${seconds}s`;
  if (seconds < 3600) return `in ${Math.ceil(seconds / 60)}m`;
  return `in ${Math.ceil(seconds / 3600)}h`;
}

// "No longer listed" means exactly that: the release has NO copies for sale right now — not merely
// that the price rose since the alert. A copy that's still there at a higher price is upgraded to
// that price (see applyVerify) and left to the % slider, so cloud and scan agree on what's a deal.
// (Earlier this also fired when the lowest price crept above the alerted price, which wrongly exiled
// still-buyable copies to history — and made them "reappear" the moment a scan re-evaluated them.)
// Scan deals never carry `current` (they're live by definition), so this is naturally cloud-only.
function dealGone(d) {
  if (!d.current) return false;
  const cur = d.current;
  return cur.numForSale === 0 || cur.lowest == null;
}

// --- Automatic live verification of the cloud feed --------------------------
// On every refresh the visible cloud deals + gems are re-checked against the LIVE marketplace
// through the same residential-IP pipeline the scan uses (main.js caches results 30 min, so the
// 30s poll is free). A verified card gets the copy's REAL condition + shipping + a direct buy
// link — so "VG+ only" and Best-first mean the same thing everywhere — and a card whose price no
// longer exists moves to the collapsed history section instead of posing as a live deal.
let verifyInfo = { running: false, done: 0, total: 0 };
let verifyBusy = false;
let goneHistoryOpen = false; // remember the <details> state across re-renders

async function maybeVerify() {
  if (activePlatform !== 'discogs' || !hasApi || scanning || verifyBusy) return;
  // In the (default) scan view the deal cards are already live/condition-verified by the scan
  // itself — only the 💎 gems need the live check. Cloud deal cards (if that view is ever shown)
  // get the full treatment.
  const items = [
    ...(viewMode === 'cloud' ? allDeals.map((d) => ({ releaseId: d.releaseId, currency: d.currency })) : []),
    ...((gemsData.gems || []).map((g) => ({ releaseId: g.releaseId, currency: g.currency }))),
  ].filter((x) => x.releaseId != null);
  if (!items.length) return;
  verifyBusy = true;
  try {
    const res = await window.api.verifyDeals(items);
    if (res && res.results && Object.keys(res.results).length) applyVerify(res.results);
  } catch { /* verification is best-effort — the cards just keep their API-only estimates */ }
  finally { verifyBusy = false; }
}

function applyVerify(results) {
  if (activePlatform !== 'discogs') return; // a platform switch may happen while the async verification is in flight
  // Scan deals are already live data — never overwrite them with a (release-level) verify result;
  // only cloud alert cards get upgraded. Gems are handled below in every view.
  if (viewMode === 'cloud') allDeals = allDeals.map((d) => {
    const r = results[d.releaseId];
    if (!r || r.error) return d; // unverifiable -> keep the honest API-only estimate
    const cur = r.cheapest;
    const copies = r.copies || 0;
    // `current` feeds dealGone() + the badge. numForSale is what decides "no longer listed": only a
    // release with ZERO copies is history. A copy that merely got pricier is upgraded below and left
    // to the % slider — the same call a scan makes, so the two views can't diverge.
    const base = { ...d, verified: true, current: { lowest: cur ? cur.price : null, numForSale: copies, ts: r.ts } };
    if (!cur || copies === 0) return base; // nothing for sale -> history
    // Upgrade the card to the LIVE cheapest copy: real grade, real shipping, direct listing link.
    // If it's no longer cheap enough vs the reference, enrich()'s recomputed discount drops it below
    // the % slider and it falls out naturally (exactly as a scan would treat it) — no dead price shown.
    const alt = (r.bestVgPlus && (!cur.itemId || r.bestVgPlus.itemId !== cur.itemId)) ? r.bestVgPlus : null;
    return {
      ...base,
      lowest: cur.price, currency: cur.currency || d.currency,
      conditionConfirmed: !!cur.media, mediaCondition: cur.media, sleeveCondition: cur.sleeve,
      shipping: cur.shipping, shippingSource: cur.shippingSource, shipsFrom: cur.shipsFrom || d.shipsFrom,
      vgPlusCount: r.vgPlusCount, copiesSeen: copies,
      listingUrl: cur.url || d.listingUrl || null, url: cur.url || d.url,
      listingId: cur.itemId ?? d.listingId ?? null,
      listingHistory: cur.history || d.listingHistory || null,
      altGrade: alt ? alt.media : null, altPrice: alt ? (alt.price != null ? alt.price + (alt.shipping || 0) : null) : null, altUrl: alt ? alt.url : null,
    };
  });
  if (gemsData.gems && gemsData.gems.length) {
    gemsData = {
      ...gemsData,
      gems: gemsData.gems.map((g) => {
        const r = results[g.releaseId];
        if (!r || r.error) return g;
        const cur = r.cheapest;
        return { ...g, verified: true, gone: !cur, currentLowest: cur ? cur.price : null, currentMedia: cur ? cur.media : null };
      }),
    };
    updateGemsBadge();
  }
  render();
}

// Attach shipping-aware totals + a ranking score to a deal. When the deal carries REAL per-copy
// shipping (a scan-confirmed copy), use it (incl. €0 = free); otherwise fall back to the slider.
function enrich(d) {
  const shipReal = d.shipping != null;
  const ship = shipReal ? d.shipping : shipVal();
  const ref = d.reference;
  const total = d.lowest != null ? d.lowest + ship : null;
  const eff = (ref && total != null) ? 1 - total / ref : (d.discount ?? null);
  const savings = (ref && total != null) ? ref - total : null;
  let score = (eff || 0) * 40 + Math.min(Math.max(savings || 0, 0), 80) / 80 * 40 + (d.ownDrop || 0) * 20;
  const n = d.numForSale;
  if (n != null) score += n <= 3 ? 15 : (n <= 10 ? 7 : 0);
  if (d.freshListing) score += 10;
  if (d.conditionConfirmed) score += 14;           // a KNOWN-VG+ copy beats a price-guess
  else { if (d.pricedAsWorn) score -= 12; if (d.suspicious) score -= 5; }
  if (d.cheapVgPlusCount > 1) score += Math.min(d.cheapVgPlusCount, 8) * 2; // a cluster = real drop, low risk
  const gone = dealGone(d);
  if (gone) score -= 60; // a dead price should never outrank a live deal in Best-first
  return Object.assign({}, d, { _ship: ship, _shipReal: shipReal, _total: total, _eff: eff, _savings: savings, _score: score, _gone: gone });
}

// The condition chip. For a scan-confirmed deal it shows the REAL media grade read off the live
// listing (green ✓ when VG+ or better) — the certainty the user asked for. For an unconfirmed
// (cloud/API) deal it falls back to the old price-proxy ESTIMATE (≈), clearly marked as a guess.
function conditionChip(d) {
  if (d.platform === 'vinted' || d.platform === 'ebay' || d.platform === 'tradera') {
    const condition = d.itemCondition ? ` · ${esc(d.itemCondition)}` : '';
    const evidence = Array.isArray(d.pressingEvidence) && d.pressingEvidence.length
      ? ` Evidence: ${d.pressingEvidence.join(', ')}.` : '';
    const source = d.platform === 'ebay' ? 'eBay' : (d.platform === 'tradera' ? 'Tradera' : 'Vinted');
    return `<span class="tag good" title="Matched to a concrete Discogs pressing from ${source}.${esc(evidence)} Media grade is not verified.">✓ pressing matched${condition}</span>`;
  }
  if (d.conditionConfirmed && d.mediaCondition) {
    const g = gradeShort(d.mediaCondition);
    const ok = isVgPlus(d);
    const sleeve = d.sleeveCondition ? ` · sleeve ${esc(gradeShort(d.sleeveCondition))}` : '';
    return `<span class="tag ${ok ? 'good' : 'warn'}" title="Confirmed from the live marketplace listing">✓ media ${esc(g)}${sleeve}</span>`;
  }
  // Unconfirmed: a price-proxy estimate only.
  if (d.impliedGrade) {
    const g = gradeShort(d.impliedGrade);
    const cls = d.pricedAsWorn ? 'warn' : (GOOD_GRADES.has(g) ? 'good' : '');
    return `<span class="tag ${cls}" title="Estimate from price only — condition not verified">≈ priced as ${esc(g)}</span>`;
  }
  if (d.impliedGrade === null && (d.pricedAsWorn || d.suspicious)) return `<span class="tag warn" title="Estimate from price only — condition not verified">≈ ≤ Good · very cheap</span>`;
  if (d.suspicious) return `<span class="tag warn" title="Estimate from price only — condition not verified">⚠ maybe below VG+</span>`;
  return `<span class="tag" title="Condition not verified — check on Discogs">condition unknown</span>`;
}

// Tiny inline SVG of the release's recent lowest-price trail (oldest -> newest). Lets you see at a
// glance whether the current price is a real dip or just the release's normal floor. The last point
// is dotted green when it's the lowest in the window (a genuine new low), amber otherwise.
function sparkline(spark) {
  if (!Array.isArray(spark) || spark.length < 3) return '';
  const w = 72, h = 20, pad = 2;
  const min = Math.min(...spark), max = Math.max(...spark);
  const span = max - min || 1;
  const n = spark.length;
  const x = (i) => pad + (i * (w - 2 * pad)) / (n - 1);
  const y = (v) => h - pad - ((v - min) / span) * (h - 2 * pad);
  const pts = spark.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const last = spark[n - 1];
  const isLow = last <= min + 1e-9;
  const dotColor = isLow ? 'var(--green)' : 'var(--amber)';
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true" preserveAspectRatio="none">
    <polyline points="${pts}" fill="none" stroke="var(--muted)" stroke-width="1.25" stroke-linejoin="round" stroke-linecap="round" />
    <circle cx="${x(n - 1).toFixed(1)}" cy="${y(last).toFixed(1)}" r="2.2" fill="${dotColor}" />
  </svg>`;
}

function priceHistoryDisplay(d) {
  const exact = d.listingHistory;
  if (exact && exact.priceDropped) {
    const percent = exact.dropPct != null ? ` (-${pct(exact.dropPct)})` : '';
    return `<div class="note drop">📉 This exact listing dropped ${money(exact.previousPrice, d.currency)} → ${money(exact.currentPrice, d.currency)}${percent}</div>`;
  }
  if (d.marketHistory && d.marketHistory.priceDropped) {
    const h = d.marketHistory;
    const percent = h.dropPct != null ? ` (-${pct(h.dropPct)})` : '';
    return `<div class="note drop">📉 Marketplace low fell ${money(h.previousLowest, d.currency)} → ${money(h.currentLowest, d.currency)}${percent}</div>`;
  }
  return '';
}

function listingHistoryTags(d) {
  const h = d.listingHistory;
  if (!h) return '';
  const relisted = h.relisted ? '<span class="tag history">↻ relisted</span>' : '';
  const tracked = h.seenCount > 1
    ? `<span class="tag history" title="This exact Discogs listing has been seen ${esc(String(h.seenCount))} times">tracked ${esc(String(h.seenCount))}×</span>`
    : '';
  return `${relisted}${tracked}`;
}

function card(d) {
  const fresh = d.freshListing ? `<span class="tag fresh">🆕 just listed</span>` : '';
  const dismissKey = `${d.platform || activePlatform}:${d.releaseId}`;
  const isHidden = dismissed.has(dismissKey) || (d.platform === 'discogs' && dismissed.has(String(d.releaseId)));
  const dismissBtn = isHidden
    ? `<button class="dismiss restore" data-rid="${esc(dismissKey)}" title="Restore this deal">↩</button>`
    : `<button class="dismiss" data-rid="${esc(dismissKey)}" title="Hide this deal">×</button>`;
  const spark = sparkline(d.spark);
  const priceHistory = priceHistoryDisplay(d);
  const historyTags = listingHistoryTags(d);
  const ships = d.shipsFrom ? `<span class="tag">from ${esc(d.shipsFrom)}</span>` : '';
  const thumb = d.thumb
    ? `<img class="thumb" src="${esc(d.thumb)}" alt="" referrerpolicy="no-referrer" />`
    : `<div class="thumb"></div>`;
  // Shipping line. A scan-confirmed copy carries the REAL shipping Discogs charges to ship to us
  // (shown plainly, no "est."); a cloud/unconfirmed deal has no per-copy shipping, so it falls back
  // to the slider estimate — clearly marked "(est.)" so the two are never confused.
  const itemTxt = (d.platform === 'vinted' || d.platform === 'ebay' || d.platform === 'tradera') && d.itemPrice != null
    ? `${money(d.itemPrice, d.currency)} item${d.serviceFee ? ` + ${money(d.serviceFee, d.currency)} buyer protection` : ''}`
    : `${money(d.lowest, d.currency)} item`;
  const shippingLabel = d.importCharges > 0 ? 'delivery/import' : 'shipping';
  const shipNote = d._shipReal
    ? (d._ship > 0 ? `${itemTxt} + ${money(d._ship, d.currency)} ${shippingLabel}` : `${itemTxt} · free shipping`)
    : (d._ship > 0 ? `${itemTxt} + ${money(d._ship, d.currency)} shipping (est.)` : `${itemTxt} · shipping unknown`);
  const shipTitle = d._shipReal
    ? (d.shippingSource === 'base' ? 'Real shipping (seller&#39;s flat rate, from the live listing)' : (d.shippingSource === 'ebay-api' ? 'Delivery and import charges returned by the official eBay Browse API' : 'Real shipping to your location, from the live listing'))
    : 'Estimated shipping (slider) — this deal has no per-copy shipping; run ⚡ Full scan for the real amount';
  const save = d._savings != null ? ` · save ${money(d._savings, d.currency)}` : '';
  const forSale = d.vgPlusCount != null
    ? `${esc(String(d.vgPlusCount))} VG+ of ${esc(String(d.numForSale ?? '?'))} for sale`
    : `${esc(String(d.numForSale ?? '?'))} for sale`;
  const worn = d.cheaperWornPrice != null
    ? `<div class="note">↘ a worse copy is cheaper at ${money(d.cheaperWornPrice, d.currency)}${d.cheaperWornCondition ? ` (${esc(gradeShort(d.cheaperWornCondition))})` : ''} — we picked the VG+ one</div>` : '';
  // Cluster: several VG+ copies all far under the reference = a real price drop, not a lone fluke.
  const cluster = d.cheapVgPlusCount > 1
    ? `<div class="note drop">📉 ${d.cheapVgPlusCount} VG+ copies ${money(d.cheapVgPlusLow, d.currency)}–${money(d.cheapVgPlusHigh, d.currency)} — likely a real price drop</div>` : '';
  // Slightly-dearer-but-better-grade alternative.
  const alt = (d.altGrade && d.altPrice != null)
    ? `<div class="note">↑ or ${money(d.altPrice, d.currency)} for a ${esc(gradeShort(d.altGrade))} copy${d.altUrl ? ` <a class="altlink" data-url="${esc(d.altUrl)}" href="#">view</a>` : ''}</div>` : '';
  const buyLabel = d.platform === 'vinted'
    ? 'Open this listing on Vinted &rarr;'
    : (d.platform === 'ebay' ? 'Open this listing on eBay &rarr;' : (d.platform === 'tradera' ? 'Open this listing on Tradera &rarr;' : (d.listingUrl ? 'Buy this copy on Discogs &rarr;' : 'View &amp; buy on Discogs &rarr;')));
  // The alerted price is gone from the marketplace — state the fact, no guessing about why.
  const gone = d._gone
    ? `<span class="tag gone" title="The cloud watcher's latest check shows this price is no longer on the marketplace">⌛ no longer listed — ${d.current && d.current.lowest != null ? `cheapest is now ${money(d.current.lowest, d.currency)}` : 'no copies for sale'}</span>` : '';
  return `<article class="card${d.freshListing ? ' is-fresh' : ''}${d.conditionConfirmed ? ' is-verified' : ''}${isHidden ? ' is-hidden' : ''}${d._gone ? ' is-gone' : ''}">
    ${dismissBtn}
    <span class="when">${d.platform === 'vinted' || d.platform === 'ebay' || d.platform === 'tradera' ? ago(d.ts) : (viewMode === 'scan' ? 'live' : ago(d.ts))}</span>
    ${thumb}
    <div class="body">
      <p class="title">${esc(d.title || 'Release ' + d.releaseId)}</p>
      <p class="artist">${esc(d.artist || '')}</p>
      <div class="price-row">
        <span class="price">${money(d._total, d.currency)}</span>
        <span class="discount">${pct(d._eff)} off</span>
        ${spark}
      </div>
      <div class="subprice ${d._shipReal ? 'ship-real' : 'ship-est'}" title="${shipTitle}">${shipNote}</div>
      <div class="ref">vs ${money(d.reference, d.currency)} ${REF_LABEL[d.referenceSource] || 'ref'}${d.soldLow != null && d.soldHigh != null ? ` (${money(d.soldLow, d.currency)}–${money(d.soldHigh, d.currency)})` : ''}${save} · ${forSale}</div>
      ${cluster}
      ${priceHistory}
      ${worn}
      ${alt}
      <div class="meta">${gone}${fresh}${conditionChip(d)}${ships}${historyTags}</div>
      <button class="buy" data-url="${esc(d.url)}">${buyLabel}</button>
    </div>
  </article>`;
}

// --- Near-misses -----------------------------------------------------------
// A release that LOOKED cheap (passed the scan's Phase-1 prelim) but was rejected in confirmation.
// Opt-in (the "Show near-misses" box) and scan-only — it answers "why isn't release X showing?".
function nearMissReason(d) {
  const ref = d.reference != null ? `${money(d.reference, d.currency)} ${REF_LABEL[d.referenceSource] || 'ref'}` : 'its reference';
  const threshold = Number.isFinite(Number(d.scanThreshold)) ? Number(d.scanThreshold) : 0.4;
  const thresholdPct = Math.round(threshold * 100);
  if (d.reasonCode === 'no-vgplus') {
    const cheap = d.cheapestPrice != null ? money(d.cheapestPrice, d.currency) : 'the cheapest copy';
    const g = d.cheapestGrade ? ` (${esc(gradeShort(d.cheapestGrade))})` : '';
    const seen = d.copiesSeen ? ` ${d.copiesSeen} copies for sale, none VG+.` : '';
    return `No VG+ copy for sale — cheapest is ${cheap}${g}, below VG+.${seen}`;
  }
  // How far under the configured bar was it? "2% short" is worth a look; "30% short" isn't — surfacing the
  // gap makes the near-miss list scannable (it's already sorted closest-first within each reason).
  const gapTxt = (eff) => {
    if (eff == null) return '';
    const gap = Math.round((threshold - eff) * 100);
    return gap <= 0 ? '' : (gap <= 5 ? ` <b>Only ${gap}% short of the bar.</b>` : ` ${gap}% short of the bar.`);
  };
  if (d.reasonCode === 'vgplus-not-cheap') {
    const ship = d.shipping != null && d.shipping > 0 ? ` + ${money(d.shipping, d.currency)} ship` : '';
    return `Cheapest VG+ copy is ${money(d.bestPrice, d.currency)}${ship} = <b>${pct(d.effectiveDiscount)} off</b> vs ${ref} — under the ${thresholdPct}% scan threshold.${gapTxt(d.effectiveDiscount ?? d.discount)}`;
  }
  if (d.reasonCode === 'unconfirmed-not-cheap') {
    return `Couldn't read condition. Cheapest ${money(d.lowest, d.currency)} ≈ <b>${pct(d.discount)} off</b> vs ${ref} — under ${thresholdPct}%.${gapTxt(d.discount)}`;
  }
  return 'Looked cheap but didn’t qualify.';
}

function nearMissCard(d) {
  const thumb = d.thumb
    ? `<img class="thumb" src="${esc(d.thumb)}" alt="" referrerpolicy="no-referrer" />`
    : `<div class="thumb"></div>`;
  return `<article class="card is-nearmiss">
    <span class="when">missed</span>
    ${thumb}
    <div class="body">
      <p class="title">${esc(d.title || 'Release ' + d.releaseId)}</p>
      <p class="artist">${esc(d.artist || '')}</p>
      <div class="why">${nearMissReason(d)}</div>
      <button class="buy ghostbuy" data-url="${esc(d.url || d.releaseUrl)}">View on Discogs &rarr;</button>
    </div>
  </article>`;
}

// Near-misses ignore the deal sliders (they explicitly DIDN'T qualify) — only the search box applies,
// so you can look one up by name.
function filterNearMisses(list) {
  const q = $('search').value.trim().toLowerCase();
  if (!q) return list;
  return list.filter((d) => `${d.artist || ''} ${d.title || ''}`.toLowerCase().includes(q));
}

// --- 💎 Rare gems tab ---------------------------------------------------------
// A gem = a wantlist release that had ZERO copies for sale and just got its first. Price is
// deliberately not a filter here (availability IS the signal), so the tab bypasses the deal
// sliders entirely — only the search box applies (to gems AND the watch list).
function gemCard(g) {
  const thumb = g.thumb
    ? `<img class="thumb" src="${esc(g.thumb)}" alt="" referrerpolicy="no-referrer" />`
    : `<div class="thumb"></div>`;
  const appeared = g.numForSale === 1 ? 'first copy appeared' : `${esc(String(g.numForSale))} copies appeared`;
  // Real recent sales (last 10, <=2yr — from the local scan's Sales History login) beat a single
  // blended median for a rare/appreciating record, so they replace the "worth ~X" line when present.
  const recentSales = Array.isArray(g.recentSales) && g.recentSales.length
    ? `<div class="recent-sales">
        <div class="label">Recent sales (last ${g.recentSales.length}, &le;2 yrs)</div>
        <div class="chips">${g.recentSales.map((s) => `<span class="sale-chip">${money(s.price, g.currency)}${s.date ? `<span class="d">${esc(fmtDateShort(s.date))}</span>` : ''}</span>`).join('')}</div>
      </div>`
    : '';
  const ref = recentSales || (g.reference != null
    ? `<div class="ref">worth ~${money(g.reference, g.currency)} (${REF_LABEL[g.referenceSource] || 'reference'})</div>` : '');
  // Live verification (same pipeline as the deals): still for sale, and in what condition?
  // A gone gem gets a full-width banner, not a subtle tag — a sold/delisted copy must never
  // look buyable at a glance (gone comes from the scan history AND the live verify).
  const live = g.platform === 'discogs' && !g.gone && g.verified && g.currentMedia
    ? `<span class="tag good" title="Confirmed from the live marketplace listing">✓ media ${esc(gradeShort(g.currentMedia))}${g.currentLowest != null && g.currentLowest !== g.lowest ? ` · now ${money(g.currentLowest, g.currency)}` : ''}</span>`
    : '';
  const goneBanner = g.gone
    ? `<div class="gem-gone-banner" title="No copy is for sale anymore — it was sold or the seller delisted it">⌛ NO LONGER LISTED — sold or delisted</div>`
    : '';
  const gemSignal = g.platform === 'vinted'
    ? '💎 absent in a targeted search — now surfaced'
    : (g.platform === 'ebay' ? '💎 absent on eBay — now surfaced' : (g.platform === 'tradera' ? '💎 absent on Tradera — now surfaced' : `💎 was 0 for sale — ${appeared}`));
  const buyLabel = g.platform === 'vinted'
    ? 'Open this listing on Vinted &rarr;'
    : (g.platform === 'ebay' ? 'Open this listing on eBay &rarr;' : (g.platform === 'tradera' ? 'Open this listing on Tradera &rarr;' : (g.gone ? 'View release on Discogs &rarr;' : 'View &amp; buy on Discogs &rarr;')));
  return `<article class="card is-gem${g.gone ? ' is-gone' : ''}">
    <span class="when">${g.ts ? ago(g.ts) : ''}</span>
    ${thumb}
    <div class="body">
      <p class="title">${esc(g.title || 'Release ' + g.releaseId)}</p>
      <p class="artist">${esc(g.artist || '')}${g.year ? ` · ${esc(String(g.year))}` : ''}</p>
      ${goneBanner}
      <div class="meta"><span class="tag gem">${gemSignal}</span>${live}</div>
      <div class="price-row"><span class="price gem-price">${money(g.lowest, g.currency)}</span><span class="gem-ask">${g.gone ? 'was asking — gone now' : (g.platform === 'vinted' ? 'at detection — open to verify' : (g.platform === 'ebay' ? 'item price from eBay API' : (g.platform === 'tradera' ? 'fixed price converted from SEK' : 'asking price — unfiltered')))}</span></div>
      ${ref}
      <button class="buy gembuy" data-url="${esc(g.url)}">${buyLabel}</button>
    </div>
  </article>`;
}

function zwRow(r) {
  const name = `${r.artist ? r.artist + ' – ' : ''}${r.title || 'Release ' + r.releaseId}`;
  const targetUrl = activePlatform === 'vinted'
    ? (r.url || `https://www.vinted.nl/catalog?search_text=${encodeURIComponent(`${r.artist || ''} ${r.title || ''}`.trim())}&catalog_ids=3041`)
    : (activePlatform === 'ebay' ? (r.url || `https://www.ebay.nl/sch/i.html?_nkw=${encodeURIComponent(`${r.artist || ''} ${r.title || ''} vinyl`.trim())}`) : (activePlatform === 'tradera' ? (r.url || `https://www.tradera.com/search?q=${encodeURIComponent(`${r.artist || ''} ${r.title || ''} vinyl`.trim())}`) : `https://www.discogs.com/release/${r.releaseId}`));
  return `<div class="zw-row">
    <span class="zw-dot"></span>
    <span class="zw-title" title="${esc(name)}">${esc(name)}</span>
    ${r.year ? `<span class="zw-year">${esc(String(r.year))}</span>` : ''}
    <a class="zw-link" data-url="${esc(targetUrl)}" href="#">view</a>
  </div>`;
}

function renderGems() {
  const wrap = $('deals');
  const empty = $('empty');
  const q = $('search').value.trim().toLowerCase();
  const match = (x) => !q || `${x.artist || ''} ${x.title || ''}`.toLowerCase().includes(q);
  const gems = (gemsData.gems || []).filter(match);
  const zw = (gemsData.zeroWatch || []).filter(match);
  $('resultCount').textContent = `${gems.length} surfaced · ${zw.length} watched`;
  $('pill-deals').textContent = `${(gemsData.gems || []).length} gem${(gemsData.gems || []).length === 1 ? '' : 's'}`;

  if (!gems.length && !zw.length) {
    wrap.innerHTML = '';
    empty.classList.remove('hidden');
    empty.textContent = q
      ? 'Nothing on the Rare tab matches your search.'
      : (activePlatform === 'vinted'
          ? 'No Vinted rare gems yet. Deep Hunt confirms titles with no matching listing one by one; when one later appears, it surfaces here.'
          : (activePlatform === 'ebay'
              ? 'No eBay rare gems yet. Once the API has confirmed a pressing has no matching listing, its next appearance surfaces here.'
              : (activePlatform === 'tradera'
                  ? 'No Tradera rare gems yet. Once the API has confirmed a pressing has no matching fixed-price listing, its next appearance surfaces here.'
                  : 'No rare gems yet. Once your wantlist has been swept, releases with ZERO copies for sale are watched here — and the moment the first copy appears it shows up (and lands in your inbox), whatever the price.')));
    return;
  }
  empty.classList.add('hidden');

  let html = '';
  if (gems.length) {
    html += `<div class="gems-head">💎 Rare appearances — ${activePlatform === 'vinted' ? 'a matching Vinted listing surfaced after a confirmed empty search' : (activePlatform === 'ebay' ? 'a matching eBay listing surfaced after a confirmed empty API search' : (activePlatform === 'tradera' ? 'a matching fixed-price Tradera listing surfaced after a confirmed empty API search' : 'the first copy showed up after none at all'))}</div>`;
    html += gems.map(gemCard).join('');
  } else if (!q) {
    html += `<div class="gems-head muted">💎 No rare appearances yet — the list below is being watched. The moment a first copy shows up it lands here and in your inbox, whatever the price.</div>`;
  }
  if (zw.length) {
    html += `<div class="zw-head">👁 Watching ${zw.length} wantlist release${zw.length === 1 ? '' : 's'} with <b>no matching ${activePlatform === 'vinted' ? 'Vinted listing' : (activePlatform === 'ebay' ? 'eBay listing' : (activePlatform === 'tradera' ? 'fixed-price Tradera listing' : 'copies for sale'))}</b> — the moment one appears it alerts, at any price</div>`;
    html += `<div class="zw-list">${zw.map(zwRow).join('')}</div>`;
  }
  wrap.innerHTML = html;
  wrap.querySelectorAll('.buy').forEach((b) => b.addEventListener('click', () => openUrl(b.getAttribute('data-url'))));
  wrap.querySelectorAll('.zw-link').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); openUrl(a.getAttribute('data-url')); }));
}

function updateGemsBadge() {
  const n = (gemsData.gems || []).length;
  const el = $('gems-count');
  el.textContent = n ? String(n) : '';
  el.classList.toggle('hidden', !n);
}

function normalizeGems(g) {
  if (Array.isArray(g)) return { ts: null, gems: g, zeroWatch: [] };
  if (!g || typeof g !== 'object') return { ts: null, gems: [], zeroWatch: [] };
  return { ts: g.ts || null, gems: Array.isArray(g.gems) ? g.gems : [], zeroWatch: Array.isArray(g.zeroWatch) ? g.zeroWatch : [] };
}

function notifyNewGems(gems) {
  if (firstGemLoad) { firstGemLoad = false; gems.forEach((g) => seenGemIds.add(g.id)); return; }
  const fresh = gems.filter((g) => !seenGemIds.has(g.id));
  fresh.forEach((g) => seenGemIds.add(g.id));
  if (fresh.length && 'Notification' in window && Notification.permission === 'granted') {
    const g = fresh[0];
    const extra = fresh.length > 1 ? ` (+${fresh.length - 1} more)` : '';
    const n = new Notification(`💎 Rare find: ${g.artist || ''} – ${g.title || ''}`, {
      body: `Had 0 copies for sale — first one appeared at ${money(g.lowest, g.currency)}${extra}`,
    });
    n.onclick = () => { openUrl(g.url); window.focus(); };
  }
}

async function refreshGems() {
  if (activePlatform === 'vinted') { await refreshVintedSnapshot(); return; }
  if (activePlatform === 'ebay') { await refreshEbaySnapshot(); return; }
  if (activePlatform === 'tradera') { await refreshTraderaSnapshot(); return; }
  if (!hasApi) {
    platformViews.discogs.gems = DEMO_GEMS;
    if (activePlatform === 'discogs') { gemsData = DEMO_GEMS; updateGemsBadge(); if (activeTab === 'gems') render(); }
    return;
  }
  try {
    const nextGems = normalizeGems(await window.api.getGems());
    platformViews.discogs.gems = nextGems;
    notifyNewGems(nextGems.gems);
    if (activePlatform === 'discogs') {
      gemsData = nextGems;
      updateGemsBadge();
      if (activeTab === 'gems') render();
      maybeVerify(); // gems join the same live listings check (cached in main, usually free)
    }
  } catch { /* keep the last known gems — the deals path surfaces connectivity problems */ }
}

// --- Scout: valuable records outside the wantlist ---------------------------
const SCOUT_PREFS_KEY = 'ddw-scout-prefs-v1';

function normalizeScoutData(value) {
  if (!value || typeof value !== 'object') return { ts: null, query: null, inspected: 0, candidates: 0, excludedWantlist: 0, aborted: false, results: [] };
  return {
    ts: value.ts || null,
    query: value.query || null,
    inspected: Number(value.inspected) || 0,
    candidates: Number(value.candidates) || 0,
    excludedWantlist: Number(value.excludedWantlist) || 0,
    aborted: !!value.aborted,
    results: Array.isArray(value.results) ? value.results : [],
  };
}

function currentScoutOptions() {
  return {
    field: $('scout-field').value,
    query: $('scout-query').value.trim(),
    minValue: Number($('scout-min-value').value) || 80,
    limit: Number($('scout-limit').value) || 100,
    currency: 'EUR',
  };
}

function loadScoutPrefs() {
  try { return JSON.parse(localStorage.getItem(SCOUT_PREFS_KEY) || '{}'); }
  catch { return {}; }
}

function applyScoutPrefs(prefs) {
  if (prefs.field === 'genre' || prefs.field === 'style') $('scout-field').value = prefs.field;
  if (typeof prefs.query === 'string' && prefs.query.trim()) $('scout-query').value = prefs.query.trim();
  if ([50, 100, 200].includes(Number(prefs.limit))) $('scout-limit').value = String(prefs.limit);
  if (Number(prefs.minValue) >= 1) $('scout-min-value').value = String(prefs.minValue);
}

function scoutCard(item) {
  const thumb = item.thumb
    ? `<img class="thumb" src="${esc(item.thumb)}" alt="" referrerpolicy="no-referrer" />`
    : '<div class="thumb"></div>';
  const place = [item.year, item.country].filter(Boolean).join(' · ');
  const valueLabel = item.valueSource === 'sold-median' ? 'recent real sold median' : 'Discogs VG+ price suggestion';
  const copies = Number(item.numForSale);
  const availability = Number.isFinite(copies)
    ? (copies === 0 ? 'none for sale' : `${copies} for sale`)
    : 'availability unknown';
  const rarityClass = Number.isFinite(copies) && copies <= 3 ? ' scout-rare' : '';
  const taxonomy = Array.isArray(item.styles) && item.styles.length ? item.styles : (item.genres || []);
  const style = taxonomy.slice(0, 2).join(' · ');
  const format = (item.formats || []).slice(0, 2).join(' · ');
  const label = (item.labels || []).slice(0, 1).join('');
  const wantText = `${Number(item.want) || 0} want · ${Number(item.have) || 0} have`;
  const asking = item.lowestPrice != null
    ? `lowest current asking price ${money(item.lowestPrice, item.currency)} (any condition)`
    : (copies === 0 ? 'currently unavailable' : 'current asking price unavailable');
  const added = !!item.addedToWantlist;
  return `<article class="card is-scout">
    ${thumb}
    <div class="body">
      <p class="title">${esc(item.title || 'Release ' + item.releaseId)}</p>
      <p class="artist">${esc(item.artist || '')}${place ? ` · ${esc(place)}` : ''}</p>
      <div class="price-row"><span class="price">${money(item.estimatedValue, item.currency)}</span><span class="scout-value-label">estimated VG+ value</span></div>
      <div class="ref">${esc(valueLabel)} · ${esc(asking)}</div>
      <div class="meta">
        <span class="tag${rarityClass}">${esc(availability)}</span>
        <span class="tag scout-demand">${esc(wantText)}</span>
        ${style ? `<span class="tag">${esc(style)}</span>` : ''}
        ${format ? `<span class="tag">${esc(format)}</span>` : ''}
        ${label ? `<span class="tag">${esc(label)}${item.catno ? ` · ${esc(item.catno)}` : ''}</span>` : ''}
      </div>
      <div class="scout-actions">
        <button class="buy scout-open" data-url="${esc(item.marketplaceUrl || item.releaseUrl)}">View marketplace →</button>
        <button class="want-add" data-rid="${esc(item.releaseId)}"${added ? ' disabled' : ''}>${added ? '✓ In wantlist' : '+ Add to wantlist'}</button>
      </div>
    </div>
  </article>`;
}

function renderScout() {
  const wrap = $('deals');
  const empty = $('empty');
  const results = scoutData.results || [];
  const query = scoutData.query;
  $('pill-deals').textContent = `${results.length} scouted`;
  $('resultCount').textContent = scoutData.ts
    ? `${results.length} found · ${scoutData.inspected} inspected${scoutData.excludedWantlist ? ` · ${scoutData.excludedWantlist} already wanted` : ''}${scoutData.aborted ? ' · stopped early' : ''}`
    : '';
  if (!results.length) {
    wrap.innerHTML = '';
    empty.classList.remove('hidden');
    empty.textContent = scoutData.ts
      ? `No ${query ? query.query : ''} vinyl above ${money(query ? query.minValue : 80, query ? query.currency : 'EUR')} was found in the ${scoutData.inspected} releases inspected. Try a deeper scan or lower the value floor.`
      : 'Choose a Discogs style or genre and start scouting. Results already on your wantlist are excluded automatically.';
    return;
  }
  empty.classList.add('hidden');
  wrap.innerHTML = results.map(scoutCard).join('');
  wrap.querySelectorAll('.scout-open').forEach((button) => button.addEventListener('click', () => openUrl(button.getAttribute('data-url'))));
  wrap.querySelectorAll('.want-add').forEach((button) => button.addEventListener('click', () => addScoutWant(button)));
}

function setScoutUI(on) {
  scouting = on;
  for (const id of ['scout-field', 'scout-query', 'scout-min-value', 'scout-limit', 'scout-run']) $(id).disabled = on;
  $('scout-run').textContent = on ? 'Scouting…' : 'Start scouting';
  $('scout-progress').classList.toggle('hidden', !on);
  $('btn-scan-all').disabled = on || scanning || cityDigging;
  $('btn-fullscan').disabled = on || scanning || cityDigging;
  $('city-run').disabled = on || cityDigging;
  if (on) setServiceBadge(lastHealth); else refreshHealth();
}

async function startScout(event) {
  if (event) event.preventDefault();
  if (scouting || scanning || cityDigging) return;
  const opts = currentScoutOptions();
  if (!opts.query) { $('scout-query').focus(); return; }
  try { localStorage.setItem(SCOUT_PREFS_KEY, JSON.stringify(opts)); } catch { /* private mode */ }
  if (!hasApi) {
    scoutData = normalizeScoutData(DEMO_SCOUT);
    renderScout();
    return;
  }
  setScoutUI(true);
  $('scout-progress-fill').style.width = '1%';
  $('scout-status').textContent = 'Reading your wantlist so existing picks can be excluded…';
  try {
    const result = await window.api.scoutRun(opts);
    if (result && result.postponed) {
      const mins = result.cloudBusy && result.cloudBusy.endsInMs ? Math.ceil(result.cloudBusy.endsInMs / 60000) : null;
      throw new Error(`The cloud watcher is scanning right now. Try Scout again${mins ? ` in about ${mins} minutes` : ' when it finishes'}.`);
    }
    scoutData = normalizeScoutData(result);
    renderScout();
  } catch (error) {
    $('deals').innerHTML = '';
    $('empty').classList.remove('hidden');
    $('empty').textContent = 'Scout failed: ' + (error && error.message ? error.message : error);
  } finally {
    setScoutUI(false);
  }
}

async function addScoutWant(button) {
  if (!hasApi || button.disabled) return;
  const releaseId = Number(button.getAttribute('data-rid'));
  button.disabled = true;
  button.textContent = 'Adding…';
  try {
    await window.api.scoutAddWant(releaseId);
    scoutData = { ...scoutData, results: scoutData.results.map((item) => Number(item.releaseId) === releaseId ? { ...item, addedToWantlist: true } : item) };
    renderScout();
  } catch (error) {
    button.disabled = false;
    button.textContent = 'Retry add to wantlist';
    button.title = error && error.message ? error.message : String(error);
  }
}

function onScoutProgress(message) {
  if (!message) return;
  let pctDone = 2;
  if (message.phase === 'search') pctDone = 3 + Math.round((message.checked / Math.max(1, message.total)) * 17);
  if (message.phase === 'pricing') pctDone = 20 + Math.round((message.checked / Math.max(1, message.total)) * 80);
  if (message.phase === 'done') pctDone = 100;
  $('scout-progress-fill').style.width = Math.min(100, pctDone) + '%';
  if (message.phase === 'wantlist') $('scout-status').textContent = 'Reading your wantlist…';
  else if (message.phase === 'search') $('scout-status').textContent = `Searching Discogs ${message.checked}/${message.total} · ${message.found} outside your wantlist`;
  else if (message.phase === 'pricing') $('scout-status').textContent = `Checking value ${message.checked}/${message.total} · ${message.found} above your threshold`;
  else if (message.phase === 'done') $('scout-status').textContent = `Done · ${message.found} records found${message.aborted ? ' (stopped early)' : ''}`;
}

// --- City Dig: physical stores, then an explicit inventory action -----------------------------
const CITY_PREFS_KEY = 'ddw-city-dig-prefs-v1';
const CITY_CONDITION_RANK = { 'Mint (M)': 0, 'Near Mint (NM or M-)': 1, 'Very Good Plus (VG+)': 2, 'Very Good (VG)': 3, 'Good Plus (G+)': 4, 'Good (G)': 5, 'Fair (F)': 6, 'Poor (P)': 7 };
const cityNumber = (value) => Number.isFinite(Number(value)) ? new Intl.NumberFormat('en-GB').format(Number(value)) : '—';

function currentCity() { return cityCities.find((city) => city.id === 'antwerp') || cityCities[0] || null; }

function selectedCitySellers() {
  return (currentCity()?.stores || []).filter((store) => store.sellerUsername).map((store) => store.sellerUsername);
}

function cityRunIdleLabel() {
  const count = selectedCitySellers().length;
  return `Load first 100 from ${count} Discogs store${count === 1 ? '' : 's'}`;
}

function cityStoreUrl(store) {
  if (store.sellerUsername) return `https://www.discogs.com/seller/${encodeURIComponent(store.sellerUsername)}/profile`;
  return store.website || store.osmUrl || '';
}

function cityStorePresentation(store) {
  const count = store.sellerUsername ? (cityCounts[store.sellerUsername] ?? store.inventoryCount) : null;
  if (store.sellerUsername) return { marker: 'online', headline: cityNumber(count), detail: store.inventoryScope === 'shared' ? 'shared catalog' : 'for sale', action: 'Discogs ↗', title: `Verified Discogs seller @${store.sellerUsername}${store.inventoryScope === 'shared' ? ' · inventory is shared with another branch' : ''}` };
  if (store.channel === 'discogs-unmatched') return { marker: 'pending', headline: 'Discogs?', detail: 'account to match', action: 'Website ↗', title: 'Discogs sales have been reported for this shop, but its exact current seller username still needs a safe match' };
  if (store.channel === 'webshop') return { marker: 'webshop', headline: 'Webshop', detail: 'browse online', action: 'Open ↗', title: 'Independent shop inventory is available online' };
  if (store.channel === 'website') return { marker: 'webshop', headline: 'Website', detail: 'store info', action: 'Open ↗', title: 'Store website found; no exact Discogs seller confirmed' };
  if (store.channel === 'seasonal') return { marker: 'pending', headline: 'Seasonal', detail: 'check first', action: 'Website ↗', title: 'Seasonal Antwerp store; check the website before visiting' };
  return { marker: 'offline', headline: 'In store', detail: 'no online stock', action: 'Map ↗', title: 'Physical record store found; no current online inventory confirmed' };
}

const mapMarkerIcon = (number, kind) => window.L.divIcon({
  className: 'city-map-marker-wrap',
  html: `<span class="city-map-marker ${kind}"><b>${number || ''}</b></span>`,
  iconSize: kind === 'city' ? [18, 18] : [26, 30],
  iconAnchor: kind === 'city' ? [9, 9] : [13, 27],
  popupAnchor: kind === 'city' ? [0, -9] : [0, -27],
});

function cityStorePopup(store, index) {
  const state = cityStorePresentation(store);
  const url = cityStoreUrl(store);
  return `<strong>${index + 1}. ${esc(store.name)}</strong><span>${esc(store.address)}</span><b>${esc(state.headline)} · ${esc(state.detail)}</b>${url ? `<a class="city-popup-link" href="${esc(url)}">${esc(state.action)}</a>` : ''}`;
}

function selectCityStore(storeId, opts = {}) {
  const city = currentCity();
  const store = city?.stores.find((candidate) => candidate.id === storeId);
  if (!store) return;
  document.querySelectorAll('.city-store').forEach((row) => row.classList.toggle('active', row.dataset.store === storeId));
  const row = document.querySelector(`.city-store[data-store="${storeId}"]`);
  if (row && opts.scroll !== false) row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  const marker = cityStoreMarkers.get(storeId);
  if (cityLocalMap && opts.pan !== false) cityLocalMap.flyTo([store.lat, store.lon], Math.max(16, cityLocalMap.getZoom()), { duration: .35 });
  if (marker && opts.popup !== false) marker.openPopup();
}

function focusCurrentCity() {
  const city = currentCity();
  if (!cityWorldMap || !cityLocalMap || !city) return;
  cityWorldMap.flyTo([city.center.lat, city.center.lon], 5, { duration: .65 });
  const bounds = window.L.latLngBounds(city.stores.map((store) => [store.lat, store.lon]));
  cityLocalMap.fitBounds(bounds, { padding: [22, 22], maxZoom: 15 });
}

function refreshCityMapLayout() {
  if (cityWorldMap) cityWorldMap.invalidateSize({ pan: false });
  if (cityLocalMap) cityLocalMap.invalidateSize({ pan: false });
}

function renderCityMap() {
  const city = currentCity();
  if (!city || cityWorldMap || cityLocalMap) return;
  if (!window.L) {
    $('city-world-map').innerHTML = '<div class="map-unavailable">The interactive world map could not start.</div>';
    $('city-local-map').innerHTML = '<div class="map-unavailable">The interactive Antwerp map could not start.</div>';
    return;
  }

  const tileOptions = {
    attribution: '<a href="https://www.openstreetmap.org/copyright">© OpenStreetMap contributors</a>',
    minZoom: 1,
    maxZoom: 19,
    noWrap: true,
  };
  cityWorldMap = window.L.map('city-world-map', { minZoom: 1, maxZoom: 7, worldCopyJump: false }).setView([25, 4], 1);
  window.L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', tileOptions).addTo(cityWorldMap);
  cityWorldMap.attributionControl.setPrefix(false);

  for (const mappedCity of cityCities) {
    const marker = window.L.marker([mappedCity.center.lat, mappedCity.center.lon], {
      icon: mapMarkerIcon('', 'city'),
      title: `Open ${mappedCity.name}`,
      alt: `${mappedCity.name}, ${mappedCity.country}`,
      keyboard: true,
    }).addTo(cityWorldMap);
    marker.bindTooltip(mappedCity.name, { permanent: true, direction: 'top', offset: [0, -8] });
    marker.on('click', () => focusCurrentCity());
  }

  cityLocalMap = window.L.map('city-local-map', { minZoom: 12, maxZoom: 19 });
  window.L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', tileOptions).addTo(cityLocalMap);
  cityLocalMap.attributionControl.setPrefix(false);
  const localBounds = window.L.latLngBounds([]);
  city.stores.forEach((store, index) => {
    localBounds.extend([store.lat, store.lon]);
    const marker = window.L.marker([store.lat, store.lon], {
      icon: mapMarkerIcon(index + 1, cityStorePresentation(store).marker),
      title: store.name,
      alt: `${store.name}, ${store.address}`,
      keyboard: true,
    }).addTo(cityLocalMap);
    marker.bindTooltip(store.name, { direction: 'top', offset: [0, -25] });
    marker.bindPopup(cityStorePopup(store, index));
    marker.on('click', () => selectCityStore(store.id, { pan: false, popup: false }));
    cityStoreMarkers.set(store.id, marker);
  });
  cityLocalMap.fitBounds(localBounds, { padding: [22, 22], maxZoom: 15 });

  for (const mapElement of [$('city-world-map'), $('city-local-map')]) {
    mapElement.addEventListener('click', (event) => {
      const link = event.target.closest && event.target.closest('.leaflet-control-attribution a, .city-popup-link');
      if (!link) return;
      event.preventDefault();
      openUrl(link.href);
    });
  }
}

function renderCityDirectory(selected = null) {
  const city = currentCity();
  if (!city) return;
  const keep = selected || new Set(selectedCitySellers());
  const linked = city.stores.filter((store) => store.sellerUsername).length;
  const unmatched = city.stores.filter((store) => store.channel === 'discogs-unmatched').length;
  $('city-directory-copy').textContent = `${city.stores.length} physical record shops mapped · ${linked} exact Discogs stores connected${unmatched ? ` · ${unmatched} possible Discogs accounts still to match` : ''}. Opening this tab only checks the connected inventory totals.`;
  $('city-stores').innerHTML = city.stores.map((store, index) => {
    const online = !!store.sellerUsername;
    const checked = online && keep.has(store.sellerUsername);
    const state = cityStorePresentation(store);
    const url = cityStoreUrl(store);
    return `<div class="city-store ${esc(state.marker)}" data-store="${esc(store.id)}" title="${esc(state.title)}">
      <input type="checkbox" data-seller="${esc(store.sellerUsername || '')}"${checked ? ' checked' : ''} disabled />
      <span class="city-store-main"><strong>${index + 1}. ${esc(store.name)}</strong><small>${esc(store.address)}${online ? ` · @${esc(store.sellerUsername)}` : ''}</small></span>
      <span class="city-store-count"><b>${esc(state.headline)}</b><small>${esc(state.detail)}</small>${url ? `<button class="city-store-link" type="button" data-url="${esc(url)}">${esc(state.action)}</button>` : ''}</span>
    </div>`;
  }).join('');
  city.stores.forEach((store, index) => cityStoreMarkers.get(store.id)?.setPopupContent(cityStorePopup(store, index)));
  $('city-stores').querySelectorAll('.city-store').forEach((row) => row.addEventListener('click', () => selectCityStore(row.dataset.store, { scroll: false })));
  $('city-stores').querySelectorAll('.city-store-link').forEach((button) => button.addEventListener('click', (event) => { event.stopPropagation(); openUrl(button.dataset.url); }));
  if (!cityDigging) $('city-run').textContent = cityRunIdleLabel();
}

async function refreshCityCounts() {
  const city = currentCity();
  if (!city || cityDigging) return;
  const button = $('city-refresh-counts');
  const selected = new Set(selectedCitySellers());
  button.disabled = true;
  button.textContent = 'Refreshing counts…';
  try {
    if (hasApi && window.api.cityDigCounts) {
      const response = await window.api.cityDigCounts(city.id);
      cityCounts = response && response.counts ? response.counts : cityCounts;
    } else {
      cityCounts = Object.fromEntries(city.stores.filter((store) => store.sellerUsername).map((store) => [store.sellerUsername, store.inventoryCount]));
    }
    cityCountsLoaded = true;
  } catch { /* bundled counts remain a useful offline fallback */ }
  finally {
    renderCityDirectory(selected);
    button.disabled = false;
    button.textContent = 'Refresh inventory counts';
  }
}

function normalizeCityDigData(value) {
  if (!value || typeof value !== 'object') return { ts: null, city: null, query: null, inspected: 0, releasesChecked: 0, cacheHits: 0, skippedNonVinyl: 0, aborted: false, results: [] };
  return {
    ts: value.ts || null,
    city: value.city || null,
    query: value.query || null,
    inspected: Number(value.inspected) || 0,
    releasesChecked: Number(value.releasesChecked) || 0,
    cacheHits: Number(value.cacheHits) || 0,
    skippedNonVinyl: Number(value.skippedNonVinyl) || 0,
    aborted: !!value.aborted,
    results: Array.isArray(value.results) ? value.results : [],
  };
}

function currentCityOptions() {
  return {
    cityId: currentCity()?.id || 'antwerp',
    sellerUsernames: selectedCitySellers(),
    taxonomies: [...document.querySelectorAll('#city-taxonomies input:checked')].map((input) => input.value),
    limitPerSeller: 100,
    currency: 'EUR',
  };
}

function sortCityResults(items, mode, requested) {
  const list = items.slice();
  if (mode === 'price') list.sort((a, b) => (Number(a.price) || 1e9) - (Number(b.price) || 1e9));
  else if (mode === 'newest') list.sort((a, b) => String(b.posted || '').localeCompare(String(a.posted || '')));
  else if (mode === 'condition') list.sort((a, b) => (CITY_CONDITION_RANK[a.condition] ?? 9) - (CITY_CONDITION_RANK[b.condition] ?? 9));
  else {
    const weights = new Map((requested || []).map((value, index) => [String(value).toLowerCase(), (requested.length - index) * 100]));
    const score = (item) => (item.matchedTaxonomies || []).reduce((sum, value) => sum + (weights.get(String(value).toLowerCase()) || 0), 0) - (Number(item.price) || 0) / 100;
    list.sort((a, b) => score(b) - score(a));
  }
  return list;
}

function cityCard(item) {
  const thumb = item.thumb ? `<img class="thumb" src="${esc(item.thumb)}" alt="" referrerpolicy="no-referrer" />` : '<div class="thumb"></div>';
  const place = [item.year, item.country].filter(Boolean).join(' · ');
  const matches = (item.matchedTaxonomies || []).map((value) => `<span class="tag city-match">${esc(value)}</span>`).join('');
  const taxonomy = [...(item.styles || []), ...(item.genres || [])].filter((value) => !(item.matchedTaxonomies || []).includes(value)).slice(0, 2).map((value) => `<span class="tag">${esc(value)}</span>`).join('');
  const taxonomyState = item.taxonomyPending ? '<span class="tag">genre pending</span>' : '';
  const label = item.labels && item.labels[0] ? item.labels[0] : null;
  return `<article class="card is-city">
    ${thumb}
    <div class="body">
      <p class="title">${esc(item.title || 'Release ' + item.releaseId)}</p>
      <p class="artist">${esc(item.artist || '')}${place ? ` · ${esc(place)}` : ''}</p>
      <div class="price-row"><span class="price">${money(item.price, item.currency)}</span><span class="scout-value-label">asking price</span></div>
      <div class="ref">${esc(item.condition || 'condition unknown')} · sleeve ${esc(item.sleeveCondition || 'unknown')}</div>
      <div class="meta"><span class="tag city-store-tag">${esc(item.storeName)}</span>${matches}${taxonomy}${taxonomyState}${label ? `<span class="tag">${esc(label.name)}${label.catno ? ` · ${esc(label.catno)}` : ''}</span>` : ''}</div>
      <p class="city-listing-meta">${esc(item.format || 'Vinyl')}${item.posted ? ` · listed ${esc(fmtDateShort(item.posted))}` : ''} · ${esc(item.storeAddress || '')}</p>
      <div class="scout-actions"><button class="buy city-buy" data-url="${esc(item.listingUrl)}">Open listing →</button><button class="want-add city-seller" data-url="${esc(item.sellerUrl)}">Full store ↗</button></div>
    </div>
  </article>`;
}

function renderCityDig() {
  const wrap = $('deals');
  const empty = $('empty');
  const query = cityDigData.query || currentCityOptions();
  const search = $('search').value.trim().toLowerCase();
  let results = cityDigData.results.filter((item) => !search || `${item.artist || ''} ${item.title || ''} ${item.storeName || ''} ${(item.styles || []).join(' ')}`.toLowerCase().includes(search));
  results = sortCityResults(results, $('city-sort').value, query.taxonomies || []);
  $('pill-deals').textContent = `${results.length} city finds`;
  const storeCount = new Set(results.map((item) => item.sellerUsername).filter(Boolean)).size;
  $('resultCount').textContent = cityDigData.ts ? `${results.length} items · ${storeCount} stores · ${cityDigData.cacheHits} genre-ready` : '';
  if (!results.length) {
    wrap.innerHTML = '';
    empty.classList.remove('hidden');
    empty.textContent = cityDigData.ts
      ? `No vinyl listings were returned by the linked stores.`
      : 'Store totals are ready above. Load the first 100 vinyl listings from every connected Discogs store when you want to dig.';
    return;
  }
  empty.classList.add('hidden');
  wrap.innerHTML = results.map(cityCard).join('');
  wrap.querySelectorAll('.city-buy, .city-seller').forEach((button) => button.addEventListener('click', () => openUrl(button.dataset.url)));
}

function setCityDigUI(on) {
  cityDigging = on;
  $('city-run').disabled = on;
  $('city-limit').disabled = true;
  $('city-progress').classList.toggle('hidden', !on);
  $('city-run').textContent = on ? 'Loading every Discogs store…' : cityRunIdleLabel();
  document.querySelectorAll('.city-store input').forEach((input) => { input.disabled = true; });
  document.querySelectorAll('#city-taxonomies input').forEach((input) => { input.disabled = on; });
  $('btn-scan-all').disabled = on || scanning || scouting;
  $('btn-fullscan').disabled = on || scanning || scouting;
}

async function startCityDig(event) {
  if (event) event.preventDefault();
  if (cityDigging || scanning || scouting) return;
  const opts = currentCityOptions();
  if (!opts.sellerUsernames.length) return;
  try { localStorage.setItem(CITY_PREFS_KEY, JSON.stringify(opts)); } catch { /* best effort */ }
  if (!hasApi) {
    cityDigData = normalizeCityDigData(DEMO_CITY_DIG);
    renderCityDig();
    return;
  }
  setCityDigUI(true);
  $('city-progress-fill').style.width = '2%';
  $('city-status').textContent = 'Reading store inventory pages…';
  try {
    cityDigData = normalizeCityDigData(await window.api.cityDigRun(opts));
    renderCityDig();
  } catch (error) {
    $('deals').innerHTML = '';
    $('empty').classList.remove('hidden');
    $('empty').textContent = 'City Dig failed: ' + (error && error.message ? error.message : error);
  } finally { setCityDigUI(false); }
}

function onCityDigProgress(message) {
  if (!message) return;
  let pctDone = 3;
  if (message.phase === 'inventory') pctDone = 3 + Math.round((((message.storeIndex || 0) + (message.checked / Math.max(1, message.total))) / Math.max(1, message.stores)) * 97);
  if (message.phase === 'done') pctDone = 100;
  $('city-progress-fill').style.width = Math.min(100, pctDone) + '%';
  if (message.phase === 'inventory') $('city-status').textContent = `Reading ${message.store} · ${message.checked}/${message.total} newest listings`;
  else if (message.phase === 'done') $('city-status').textContent = `Done · ${message.found} vinyl listings loaded${message.aborted ? ' (stopped early)' : ''}`;
}

function stashPlatformView() {
  const view = platformViews[activePlatform];
  view.deals = allDeals;
  view.nearMisses = allNearMisses;
  view.gems = gemsData;
  view.viewMode = viewMode;
  view.scannedOnce = scannedOnce;
}

function restorePlatformView(platform) {
  const view = platformViews[platform];
  allDeals = view.deals || [];
  allNearMisses = view.nearMisses || [];
  gemsData = view.gems || { ts: null, gems: [], zeroWatch: [] };
  viewMode = view.viewMode || (platform === 'discogs' ? 'scan' : platform);
  scannedOnce = !!view.scannedOnce;
  enrichCache = { src: null, ship: null, list: [] };
}

function normalizeVintedSnapshot(value) {
  const input = value && typeof value === 'object' ? value : {};
  const status = input.status && typeof input.status === 'object' ? input.status : {};
  const backfill = status.backfill && typeof status.backfill === 'object' ? status.backfill : {};
  return {
    status: {
      enabled: !!status.enabled,
      running: !!status.running,
      health: status.health || (status.enabled ? 'idle' : 'disabled'),
      lastPollAt: status.lastPollAt || null,
      nextPollAt: status.nextPollAt || null,
      pollSeconds: Number(status.pollSeconds) || 15,
      targetCount: Number(status.targetCount) || 0,
      requestsLastHour: Number(status.requestsLastHour) || 0,
      message: status.message || null,
      error: status.error || null,
      backfill: {
        active: !!backfill.active,
        cursor: Math.max(0, Number(backfill.cursor) || 0),
        checked: Math.max(0, Number(backfill.checked) || 0),
        total: Math.max(0, Number(backfill.total) || 0),
        listingsFound: Math.max(0, Number(backfill.listingsFound) || 0),
        dealsFound: Math.max(0, Number(backfill.dealsFound) || 0),
        gemsFound: Math.max(0, Number(backfill.gemsFound) || 0),
        startedAt: backfill.startedAt || null,
        completedAt: backfill.completedAt || null,
        cancelledAt: backfill.cancelledAt || null,
      },
    },
    deals: Array.isArray(input.deals) ? input.deals : [],
    gems: normalizeGems(input.gems),
  };
}

function renderVintedStatus() {
  const s = vintedStatus || {};
  const backfill = s.backfill || {};
  $('vinted-enabled').checked = !!s.enabled;
  if ([...$('vinted-poll-interval').options].some((option) => Number(option.value) === Number(s.pollSeconds))) {
    $('vinted-poll-interval').value = String(s.pollSeconds);
  }
  const health = $('vinted-health');
  const paused = s.health === 'paused' || s.health === 'backoff';
  health.className = 'vinted-health ' + (s.health === 'error' ? 'is-error' : (paused ? 'is-paused' : (s.running || backfill.active ? 'is-scanning' : (s.health === 'live' ? 'is-live' : 'is-idle'))));
  $('vinted-health-label').textContent = s.health === 'error' ? 'Error' : (paused ? 'Paused' : (backfill.active ? (s.running ? 'Backfilling' : 'Backfill queued') : (s.running ? 'Scanning' : (s.health === 'live' ? 'Live' : (s.enabled ? 'Ready' : 'Off')))));
  $('vinted-last-scan').textContent = s.lastPollAt ? ago(s.lastPollAt) : 'Not yet';
  $('vinted-next-scan').textContent = (s.enabled || backfill.active) && s.nextPollAt ? until(s.nextPollAt) : '—';
  const total = backfill.total || s.targetCount || 0;
  $('vinted-backfill-progress').textContent = backfill.active
    ? `${backfill.checked}/${total || '?'} · ${backfill.listingsFound} listing${backfill.listingsFound === 1 ? '' : 's'} · ${backfill.dealsFound} deal${backfill.dealsFound === 1 ? '' : 's'}`
    : (backfill.completedAt
        ? `Complete · ${backfill.checked}/${total || backfill.checked} · ${backfill.dealsFound} deal${backfill.dealsFound === 1 ? '' : 's'}`
        : (backfill.cancelledAt ? `Paused · ${backfill.checked}/${total || '?'}` : 'Not started'));
  const backfillButton = $('vinted-backfill');
  backfillButton.classList.toggle('is-active', !!backfill.active);
  backfillButton.textContent = backfill.active
    ? 'Stop existing scan'
    : (backfill.cancelledAt && backfill.checked < total ? 'Resume existing scan' : (backfill.completedAt ? 'Scan existing again' : 'Scan existing listings'));
  const requests = `${Number(s.requestsLastHour) || 0} request${Number(s.requestsLastHour) === 1 ? '' : 's'} this session (last-hour window)`;
  $('vinted-status-message').textContent = s.error
    || (s.message ? `${s.message} ${requests}.` : (s.enabled ? `Sniper armed · ${requests}. Deep Hunt checks older matches separately.` : 'Enable the sniper when you are ready to watch new listings.'));
  $('vinted-scan-now').disabled = !!s.running || scanAllRunning;
}

function notifyVinted(items, kind = 'deal') {
  if (!Array.isArray(items) || !items.length || !('Notification' in window) || Notification.permission !== 'granted') return;
  const item = items[0];
  const extra = items.length > 1 ? ` (+${items.length - 1} more)` : '';
  const title = kind === 'gem'
    ? `💎 Vinted rare gem: ${item.artist || ''} – ${item.title || ''}`
    : `💸 Vinted deal: ${money(item.lowest, item.currency)} (${pct(item.discount)} off)`;
  const body = kind === 'gem'
    ? `A matching listing surfaced after an empty search at ${money(item.lowest, item.currency)}${extra}`
    : `${item.artist || ''} – ${item.title || ''}${extra}`;
  const notification = new Notification(title, { body });
  notification.onclick = () => { openUrl(item.url); window.focus(); };
}

function applyVintedSnapshot(value, { notify = false } = {}) {
  const next = normalizeVintedSnapshot(value);
  vintedStatus = next.status;
  platformViews.vinted.deals = next.deals;
  platformViews.vinted.gems = next.gems;
  platformViews.vinted.nearMisses = [];
  platformViews.vinted.viewMode = 'vinted';
  platformViews.vinted.scannedOnce = !!next.status.lastPollAt;
  if (activePlatform === 'vinted') restorePlatformView('vinted');
  renderVintedStatus();
  syncMarketplaceAllScan('vinted', next.status);
  updateGemsBadge();
  if (activePlatform === 'vinted') render();
  if (notify && value) {
    notifyVinted(value.newDeals, 'deal');
    notifyVinted(value.newGems, 'gem');
  }
}

async function refreshVintedSnapshot() {
  if (!hasApi || !window.api.vintedSnapshot || vintedRefreshBusy) return;
  vintedRefreshBusy = true;
  try { applyVintedSnapshot(await window.api.vintedSnapshot()); }
  catch (error) {
    vintedStatus = { ...vintedStatus, health: 'error', error: error && error.message ? error.message : String(error) };
    renderVintedStatus();
  } finally { vintedRefreshBusy = false; }
}

function normalizeEbaySnapshot(value) {
  const input = value && typeof value === 'object' ? value : {};
  const status = input.status && typeof input.status === 'object' ? input.status : {};
  const progress = status.progress && typeof status.progress === 'object' ? status.progress : null;
  return {
    status: {
      enabled: !!status.enabled,
      configured: !!status.configured,
      running: !!status.running,
      health: status.health || (status.configured ? 'idle' : 'setup'),
      pollMinutes: Number(status.pollMinutes) || 15,
      lastPollAt: status.lastPollAt || null,
      nextPollAt: status.nextPollAt || null,
      callsToday: Math.max(0, Number(status.callsToday) || 0),
      dailyLimit: Math.max(1, Number(status.dailyLimit) || 4800),
      targetCount: Math.max(0, Number(status.targetCount) || 0),
      progress,
      message: status.message || null,
      error: status.error || null,
    },
    deals: Array.isArray(input.deals) ? input.deals : [],
    gems: normalizeGems(input.gems),
  };
}

function renderEbayStatus() {
  const s = ebayStatus || {};
  $('ebay-enabled').checked = !!s.enabled;
  if ([...$('ebay-poll-interval').options].some((option) => Number(option.value) === Number(s.pollMinutes))) $('ebay-poll-interval').value = String(s.pollMinutes);
  const health = $('ebay-health');
  health.className = 'vinted-health ' + (s.health === 'error' ? 'is-error' : (s.running ? 'is-scanning' : (s.health === 'live' ? 'is-live' : (s.configured ? 'is-idle' : 'is-paused'))));
  $('ebay-health-label').textContent = s.health === 'error' ? 'Error' : (s.running ? 'Scanning' : (s.health === 'live' ? 'Live' : (s.configured ? (s.enabled ? 'Ready' : 'Connected') : 'Setup needed')));
  $('ebay-last-scan').textContent = s.lastPollAt ? ago(s.lastPollAt) : 'Not yet';
  $('ebay-next-scan').textContent = s.enabled && s.nextPollAt ? until(s.nextPollAt) : '—';
  $('ebay-api-calls').textContent = `${Number(s.callsToday || 0).toLocaleString()} / ${Number(s.dailyLimit || 4800).toLocaleString()}`;
  const progress = s.progress && s.progress.total ? `Scanning ${s.progress.checked || 0}/${s.progress.total}${s.progress.current ? ` · ${s.progress.current}` : ''}. ` : '';
  $('ebay-status-message').textContent = s.error || `${progress}${s.message || (s.configured ? 'Official Browse API ready.' : 'Add your eBay developer credentials to connect the official API.')}`;
  $('ebay-scan-now').disabled = !!s.running || !s.configured || scanAllRunning;
  $('ebay-enabled').disabled = !s.configured;
}

function notifyEbay(items, kind = 'deal') {
  if (!Array.isArray(items) || !items.length || !('Notification' in window) || Notification.permission !== 'granted') return;
  const item = items[0]; const extra = items.length > 1 ? ` (+${items.length - 1} more)` : '';
  const title = kind === 'gem' ? `💎 eBay rare gem: ${item.artist || ''} – ${item.title || ''}` : `💸 eBay deal: ${money(item.lowest, item.currency)} (${pct(item.discount)} off)`;
  const notification = new Notification(title, { body: `${item.artist || ''} – ${item.title || ''}${extra}` });
  notification.onclick = () => { openUrl(item.url); window.focus(); };
}

function applyEbaySnapshot(value, { notify = false } = {}) {
  const next = normalizeEbaySnapshot(value);
  ebayStatus = next.status;
  platformViews.ebay = { deals: next.deals, nearMisses: [], gems: next.gems, viewMode: 'ebay', scannedOnce: !!next.status.lastPollAt };
  if (activePlatform === 'ebay') restorePlatformView('ebay');
  renderEbayStatus(); updateGemsBadge();
  syncMarketplaceAllScan('ebay', next.status);
  if (activePlatform === 'ebay') render();
  if (notify && value) { notifyEbay(value.newDeals, 'deal'); notifyEbay(value.newGems, 'gem'); }
}

async function refreshEbaySnapshot() {
  if (!hasApi || !window.api.ebaySnapshot || ebayRefreshBusy) return;
  ebayRefreshBusy = true;
  try { applyEbaySnapshot(await window.api.ebaySnapshot()); }
  catch (error) { ebayStatus = { ...ebayStatus, health: 'error', error: error && error.message ? error.message : String(error) }; renderEbayStatus(); }
  finally { ebayRefreshBusy = false; }
}

function normalizeTraderaSnapshot(value) {
  const input = value && typeof value === 'object' ? value : {};
  const status = input.status && typeof input.status === 'object' ? input.status : {};
  const progress = status.progress && typeof status.progress === 'object' ? status.progress : null;
  return {
    status: {
      enabled: !!status.enabled,
      configured: !!status.configured,
      running: !!status.running,
      health: status.health || (status.configured ? 'idle' : 'setup'),
      pollMinutes: Number(status.pollMinutes) || 30,
      lastPollAt: status.lastPollAt || null,
      nextPollAt: status.nextPollAt || null,
      callsToday: Math.max(0, Number(status.callsToday) || 0),
      dailyLimit: Math.max(1, Number(status.dailyLimit) || 9500),
      targetCount: Math.max(0, Number(status.targetCount) || 0),
      progress,
      fx: status.fx && typeof status.fx === 'object' ? status.fx : null,
      message: status.message || null,
      error: status.error || null,
    },
    deals: Array.isArray(input.deals) ? input.deals : [],
    gems: normalizeGems(input.gems),
  };
}

function renderTraderaStatus() {
  const s = traderaStatus || {};
  $('tradera-enabled').checked = !!s.enabled;
  if ([...$('tradera-poll-interval').options].some((option) => Number(option.value) === Number(s.pollMinutes))) $('tradera-poll-interval').value = String(s.pollMinutes);
  const health = $('tradera-health');
  health.className = 'vinted-health ' + (s.health === 'error' ? 'is-error' : (s.running ? 'is-scanning' : (s.health === 'live' ? 'is-live' : (s.configured ? 'is-idle' : 'is-paused'))));
  $('tradera-health-label').textContent = s.health === 'error' ? 'Error' : (s.running ? 'Scanning' : (s.health === 'live' ? 'Live' : (s.configured ? (s.enabled ? 'Ready' : 'Connected') : 'Setup needed')));
  $('tradera-last-scan').textContent = s.lastPollAt ? ago(s.lastPollAt) : 'Not yet';
  $('tradera-next-scan').textContent = s.enabled && s.nextPollAt ? until(s.nextPollAt) : '—';
  $('tradera-api-calls').textContent = `${Number(s.callsToday || 0).toLocaleString()} / ${Number(s.dailyLimit || 9500).toLocaleString()}`;
  const progress = s.progress && s.progress.total ? `Scanning ${s.progress.checked || 0}/${s.progress.total}${s.progress.current ? ` · ${s.progress.current}` : ''}. ` : '';
  const fx = s.fx && Number(s.fx.rate) > 0 ? ` SEK→${s.fx.to} via ${s.fx.source === 'identity' ? 'identity' : 'ECB'}${s.fx.stale ? ' (cached)' : ''}.` : '';
  $('tradera-status-message').textContent = s.error || `${progress}${s.message || (s.configured ? 'Official REST v4 ready.' : 'Add your Tradera developer credentials to connect the official API.')}${fx}`;
  $('tradera-scan-now').disabled = !!s.running || !s.configured || scanAllRunning;
  $('tradera-enabled').disabled = !s.configured;
}

function notifyTradera(items, kind = 'deal') {
  if (!Array.isArray(items) || !items.length || !('Notification' in window) || Notification.permission !== 'granted') return;
  const item = items[0]; const extra = items.length > 1 ? ` (+${items.length - 1} more)` : '';
  const title = kind === 'gem' ? `💎 Tradera rare gem: ${item.artist || ''} – ${item.title || ''}` : `💸 Tradera deal: ${money(item.lowest, item.currency)} (${pct(item.discount)} off)`;
  const notification = new Notification(title, { body: `${item.artist || ''} – ${item.title || ''}${extra}` });
  notification.onclick = () => { openUrl(item.url); window.focus(); };
}

function applyTraderaSnapshot(value, { notify = false } = {}) {
  const next = normalizeTraderaSnapshot(value);
  traderaStatus = next.status;
  platformViews.tradera = { deals: next.deals, nearMisses: [], gems: next.gems, viewMode: 'tradera', scannedOnce: !!next.status.lastPollAt };
  if (activePlatform === 'tradera') restorePlatformView('tradera');
  renderTraderaStatus(); updateGemsBadge();
  syncMarketplaceAllScan('tradera', next.status);
  if (activePlatform === 'tradera') render();
  if (notify && value) { notifyTradera(value.newDeals, 'deal'); notifyTradera(value.newGems, 'gem'); }
}

async function refreshTraderaSnapshot() {
  if (!hasApi || !window.api.traderaSnapshot || traderaRefreshBusy) return;
  traderaRefreshBusy = true;
  try { applyTraderaSnapshot(await window.api.traderaSnapshot()); }
  catch (error) { traderaStatus = { ...traderaStatus, health: 'error', error: error && error.message ? error.message : String(error) }; renderTraderaStatus(); }
  finally { traderaRefreshBusy = false; }
}

async function setPlatform(platform) {
  const next = ['discogs', 'vinted', 'ebay', 'tradera'].includes(platform) ? platform : 'discogs';
  if (next !== activePlatform) {
    stashPlatformView();
    activePlatform = next;
    try { localStorage.setItem('deal-shark-platform', next); } catch { /* best effort */ }
  }
  if (activePlatform !== 'discogs' && (activeTab === 'scout' || activeTab === 'city')) activeTab = 'deals';
  restorePlatformView(activePlatform);
  document.body.classList.toggle('platform-vinted', activePlatform === 'vinted');
  document.body.classList.toggle('platform-ebay', activePlatform === 'ebay');
  document.body.classList.toggle('platform-tradera', activePlatform === 'tradera');
  $('platform-select').value = activePlatform;
  $('platform-context-label').textContent = activePlatform === 'vinted'
    ? 'Anonymous newest-listings feed · matching and history stay on this PC'
    : (activePlatform === 'ebay' ? 'Official Browse API · exact pressing match · landed-cost comparison' : (activePlatform === 'tradera' ? 'Official REST v4 · fixed price only · ECB currency conversion' : 'Wantlist, sold medians and connected sellers'));
  $('vinted-panel').classList.toggle('hidden', activePlatform !== 'vinted');
  $('ebay-panel').classList.toggle('hidden', activePlatform !== 'ebay');
  $('tradera-panel').classList.toggle('hidden', activePlatform !== 'tradera');
  $('btn-fullscan').querySelector('span').textContent = `${ALL_SCAN_LABELS[activePlatform]} only`;
  $('btn-fullscan').title = activePlatform === 'vinted' ? 'Check the Vinted newest feed now'
    : (activePlatform === 'ebay' ? 'Search the official eBay Browse API for every wantlist pressing' : (activePlatform === 'tradera' ? 'Search the official Tradera REST API for every wantlist pressing' : 'Scan the full wantlist with real condition, shipping and fresh sold medians'));
  $('vgPlusOnly').closest('.switch-row').classList.toggle('hidden', activePlatform !== 'discogs');
  $('showNearMiss').closest('.switch-row').classList.toggle('hidden', activePlatform !== 'discogs');
  updateGemsBadge();
  setTab(activeTab);
  if (activePlatform === 'vinted') await refreshVintedSnapshot();
  else if (activePlatform === 'ebay') await refreshEbaySnapshot();
  else if (activePlatform === 'tradera') await refreshTraderaSnapshot();
  else { refreshGems(); render(); }
}

function setTab(tab) {
  if (activePlatform !== 'discogs' && (tab === 'scout' || tab === 'city')) tab = 'deals';
  activeTab = tab;
  document.body.classList.toggle('tab-gems', tab === 'gems');
  document.body.classList.toggle('tab-scout', tab === 'scout');
  document.body.classList.toggle('tab-city', tab === 'city');
  $('tab-deals').classList.toggle('active', tab === 'deals');
  $('tab-gems').classList.toggle('active', tab === 'gems');
  $('tab-scout').classList.toggle('active', tab === 'scout');
  $('tab-city').classList.toggle('active', tab === 'city');
  $('tab-deals').setAttribute('aria-selected', tab === 'deals' ? 'true' : 'false');
  $('tab-gems').setAttribute('aria-selected', tab === 'gems' ? 'true' : 'false');
  $('tab-scout').setAttribute('aria-selected', tab === 'scout' ? 'true' : 'false');
  $('tab-city').setAttribute('aria-selected', tab === 'city' ? 'true' : 'false');
  $('scout-panel').classList.toggle('hidden', tab !== 'scout');
  $('city-panel').classList.toggle('hidden', tab !== 'city');
  updateViewCopy();
  render();
  if (tab === 'city') {
    renderCityMap();
    requestAnimationFrame(refreshCityMapLayout);
    if (!cityCountsLoaded) refreshCityCounts();
  }
}

function applyFilters(deals, opts = {}) {
  const q = $('search').value.trim().toLowerCase();
  const minV = parseFloat($('minValue').value) || 0;
  const minD = parseInt($('minDiscount').value, 10) / 100;
  const maxT = parseFloat($('maxTotal').value) || 0;
  const freshOnly = $('freshOnly').checked;
  // opts.ignoreVg lets render() count how many deals are removed SOLELY by "VG+ only".
  const vgOnly = activePlatform !== 'discogs' ? false : (opts.ignoreVg ? false : $('vgPlusOnly').checked);
  const showHidden = $('showHidden').checked;
  return deals.filter((d) => {
    const dismissKey = `${d.platform || activePlatform}:${d.releaseId}`;
    if (!showHidden && (dismissed.has(dismissKey) || (d.platform === 'discogs' && dismissed.has(String(d.releaseId))))) return false;
    if (minV > 0 && (d.reference == null || d.reference < minV)) return false;
    if ((d._eff ?? 0) < minD) return false;
    if (maxT > 0 && (d._total == null || d._total > maxT)) return false;
    if (freshOnly && !d.freshListing) return false;
    if (vgOnly && !isVgPlus(d)) return false;
    if (q) {
      const hay = `${d.artist || ''} ${d.title || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function sortDeals(list, mode) {
  const c = list.slice();
  if (mode === 'discount') c.sort((a, b) => (b._eff ?? 0) - (a._eff ?? 0));
  else if (mode === 'total') c.sort((a, b) => (a._total ?? 1e9) - (b._total ?? 1e9));
  else if (mode === 'savings') c.sort((a, b) => (b._savings ?? 0) - (a._savings ?? 0));
  else if (mode === 'newest') c.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  else c.sort((a, b) => (b._score ?? 0) - (a._score ?? 0)); // best
  return c;
}

// Enrichment cache: enrich() only depends on the loaded deals + the shipping slider, but render()
// runs on every keypress/slider move — re-enriching hundreds of deals per keystroke made the filter
// inputs laggy. allDeals is only ever REASSIGNED (never mutated in place), so a reference check is
// a safe cache key.
let enrichCache = { src: null, ship: null, list: [] };

function render() {
  if (activeTab === 'gems') return renderGems();
  if (activeTab === 'scout') return renderScout();
  if (activeTab === 'city') return renderCityDig();
  const ship = shipVal();
  if (enrichCache.src !== allDeals || enrichCache.ship !== ship) enrichCache = { src: allDeals, ship, list: allDeals.map(enrich) };
  const enriched = enrichCache.list;
  let deals = applyFilters(enriched);
  // How many deals pass every OTHER filter but are removed SOLELY by "VG+ only"? Cloud/email deals
  // can never carry a confirmed grade, so "VG+ only" silently hides every one of them — which is
  // exactly why a deal you were emailed can be invisible here. Surface the number so it's never silent.
  const vgHidden = activePlatform === 'discogs' && $('vgPlusOnly').checked ? Math.max(0, applyFilters(enriched, { ignoreVg: true }).length - deals.length) : 0;
  deals = sortDeals(deals, $('sortBy').value);
  // Cards whose price no longer exists on the marketplace are history, not deals: they move to a
  // collapsed section at the bottom instead of sitting (struck-through) between the live cards.
  const goneDeals = deals.filter((d) => d._gone);
  deals = deals.filter((d) => !d._gone);
  // Near-misses: opt-in, scan-only. Rendered below the deals with the reason each didn't qualify.
  const showMiss = $('showNearMiss').checked && viewMode === 'scan' && allNearMisses.length > 0;
  const misses = showMiss ? filterNearMisses(allNearMisses) : [];
  const wrap = $('deals');
  const empty = $('empty');
  const hiddenCount = allDeals.reduce((acc, d) => {
    const key = `${d.platform || activePlatform}:${d.releaseId}`;
    return acc + ((dismissed.has(key) || (d.platform === 'discogs' && dismissed.has(String(d.releaseId)))) ? 1 : 0);
  }, 0);
  const hiddenNote = hiddenCount ? ` · ${hiddenCount} hidden` : '';
  const vgNote = vgHidden ? ` · ${vgHidden} hidden by “VG+ only”` : '';
  $('pill-deals').textContent = `${allDeals.length} deal${allDeals.length === 1 ? '' : 's'}`;
  const verifyNote = activePlatform === 'discogs' && verifyInfo.running ? ` · ✓ checking listings ${Math.min(verifyInfo.done + 1, verifyInfo.total)}/${verifyInfo.total}…` : '';
  const sourceNote = activePlatform === 'vinted' ? ' · Vinted sniper' : (activePlatform === 'ebay' ? ' · eBay Browse API' : (activePlatform === 'tradera' ? ' · Tradera REST v4' : (viewMode === 'scan' ? ' · live scan' : '')));
  $('resultCount').textContent = (deals.length || verifyNote) ? `${deals.length} of ${allDeals.length}${hiddenNote}${vgNote}${sourceNote}${verifyNote}` : '';
  if (!deals.length && !misses.length && !goneDeals.length) {
    wrap.innerHTML = '';
    empty.classList.remove('hidden');
    empty.textContent = allDeals.length
      ? (vgHidden
          ? `${vgHidden} deal${vgHidden === 1 ? '' : 's'} hidden by “VG+ only” — untick it to see ${vgHidden === 1 ? 'it' : 'them'} (cloud/email deals can’t be condition-verified).`
          : 'No deals match your filters — loosen the sliders.')
      : (activePlatform === 'vinted'
          ? (vintedStatus.running
              ? 'Sniper is checking Vinted. No wantlist match meets your discount rules yet.'
              : 'No Vinted deals yet. Enable the background sniper or scan Vinted now.')
          : (activePlatform === 'ebay'
              ? (ebayStatus.running ? 'The official eBay API is scanning your wantlist.' : (ebayStatus.configured ? 'No eBay deals yet. Run a scan or enable background watch.' : 'Configure your eBay App ID and Cert ID to start.'))
              : (activePlatform === 'tradera'
                  ? (traderaStatus.running ? 'The official Tradera API is scanning your wantlist.' : (traderaStatus.configured ? 'No fixed-price Tradera deals yet. Run a scan or enable background watch.' : 'Configure your Tradera App ID and App Key to start.'))
                  : (viewMode === 'scan'
          ? (scannedOnce
              ? 'Scan finished — no confirmed VG+ copies meet your discount threshold right now.'
              : 'No scan yet. Hit ⚡ Full scan to sweep your wantlist for verified-VG+ bargains.')
          : 'No deals yet — hit ⚡ Full scan.'))));
    return;
  }
  empty.classList.add('hidden');
  let html = deals.map(card).join('');
  if (misses.length) {
    html += `<div class="nearmiss-head">↓ Near-misses — looked cheap but didn’t qualify (${misses.length})</div>`;
    html += misses.map(nearMissCard).join('');
  }
  if (goneDeals.length) {
    html += `<details class="gone-history"${goneHistoryOpen ? ' open' : ''}><summary>⌛ No longer listed — kept as history (${goneDeals.length})</summary><div class="gone-grid">${goneDeals.map(card).join('')}</div></details>`;
  }
  wrap.innerHTML = html;
  const hist = wrap.querySelector('.gone-history');
  if (hist) hist.addEventListener('toggle', () => { goneHistoryOpen = hist.open; });
  wrap.querySelectorAll('.buy').forEach((b) => b.addEventListener('click', () => openUrl(b.getAttribute('data-url'))));
  wrap.querySelectorAll('.altlink').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); openUrl(a.getAttribute('data-url')); }));
  wrap.querySelectorAll('.dismiss').forEach((b) => b.addEventListener('click', () => {
    const rid = b.getAttribute('data-rid');
    if (dismissed.has(rid)) dismissed.delete(rid); else dismissed.add(rid);
    saveDismissed();
    render();
  }));
}

// Supporting pills only (wantlist size). Connectivity + freshness now live in the service badge.
function setStatus(statusObj) {
  if (!statusObj) return;
  $('pill-wantlist').textContent = `wantlist ${statusObj.wantlistSize ?? '—'}`;
}

// --- Live-service badge ---------------------------------------------------
// Turns the health object from main into a colored, pulsing "is the watcher running?" indicator.
// This is the thing the user watches to know the email/sweep service is alive — not just that the
// deals source happens to be reachable.
let lastHealth = null;
let lastGithubRun = null; // remembered so a transient GitHub rate-limit doesn't blank the badge

function setServiceBadge(h) {
  const badge = $('svc-badge'), label = $('svc-label'), sweep = $('pill-sweep');
  let state = 'idle', text = 'checking…', sub = '', title = 'Service status', url = null;

  if (scouting) {
    state = 'scan'; text = 'Scouting…'; title = 'Scout is searching Discogs beyond your wantlist.';
  } else if (scanning) {
    state = 'scan'; text = 'Scanning…'; title = 'A local scan is running right now.';
  } else if (!h || h.mode === 'demo') {
    state = 'idle'; text = h ? 'demo' : 'checking…';
    title = h ? 'Preview mode — no live service connection.' : 'Checking the service…';
  } else if (h.mode === 'server') {
    if (!h.ok) { state = 'down'; text = 'Offline'; title = 'Cannot reach the watcher server: ' + (h.error || 'unknown'); }
    else {
      const last = h.status && h.status.lastSweepAt;
      const ageM = last ? (Date.now() - last) / 60000 : 0; // reachable but no sweep yet = freshly up, treat as live
      state = ageM < 30 ? 'live' : (ageM < 120 ? 'delayed' : 'down');
      text = state === 'live' ? 'Live' : (state === 'delayed' ? 'Idle' : 'Stale');
      sub = last ? `swept ${ago(last)}` : 'connected';
      title = `Watcher server reachable${last ? ` · last sweep ${ago(last)}` : ''}.`;
    }
  } else if (h.mode === 'local') {
    // Local-scan mode: no cloud service to monitor. The badge reflects the last scan instead.
    const last = h.lastScanAt;
    state = 'idle'; text = 'Local';
    sub = last ? `scanned ${ago(last)}` : 'no scan yet';
    title = 'Local-scan mode — no cloud watcher. Use ⚡ Full scan to refresh deals.';
  } else { // github
    const run = (h.ok && h.run) ? h.run : (h.rateLimited ? lastGithubRun : null);
    if (!run) {
      if (h.rateLimited) { state = 'idle'; text = 'checking…'; title = 'GitHub status check is rate-limited; retrying shortly. (The cron itself is unaffected.)'; }
      else if (h.notFound) { state = 'down'; text = 'No runs'; title = 'No workflow runs found for this repo yet.'; }
      else if (!h.ok) { state = 'down'; text = 'Unknown'; title = 'Cannot reach GitHub to check the service: ' + (h.error || 'unknown'); }
      else { state = 'down'; text = 'Never run'; title = 'The scheduled workflow has not run yet.'; }
    } else {
      const when = run.startedAt || run.updatedAt;
      const ageM = when ? (Date.now() - when) / 60000 : Infinity;
      const running = run.status && run.status !== 'completed';
      const failed = run.conclusion === 'failure';
      const concl = running ? 'in progress' : (run.conclusion || 'unknown');
      // GitHub deprioritizes scheduled runs on public repos and often delays/skips ticks, so the
      // bands are forgiving: amber "Delayed" (not red) absorbs the normal hiccups, and only a long
      // silence (>90 min ≈ 6 missed ticks) goes red. A FAILED run is always red — that's the case
      // that actually stops the deal emails.
      if (running && ageM < 45) { state = 'live'; text = 'Running now'; }
      else if (failed && ageM < 120) { state = 'fail'; text = 'Run failed'; }
      else if (ageM < 30) { state = 'live'; text = 'Live'; }
      else if (ageM < 90) { state = 'delayed'; text = 'Delayed'; }
      else { state = 'down'; text = 'Down'; }
      sub = when ? `ran ${ago(when)}` : '';
      if (h.rateLimited) sub = sub ? sub + ' · rechecking' : 'rechecking';
      title = state === 'fail'
        ? `Last scheduled run FAILED (${ago(when)}) — deal emails may not be sending. Click to inspect on GitHub.`
        : state === 'delayed'
          ? `Last run ${ago(when)} (${concl}). GitHub sometimes delays scheduled runs under load — usually self-corrects. Click to open Actions.`
          : state === 'down'
            ? `No scheduled run in over 90 minutes (last ${when ? ago(when) : 'never'}). The cron may be paused or broken — click to check GitHub Actions.`
            : `Live — sweeps every ~15 min. Last run ${ago(when)} (${concl}). Click to open Actions.`;
      url = run.url;
    }
    if (!url && h.repo) url = `https://github.com/${h.repo}/actions`;
  }

  badge.className = 'svc ' + state;
  label.textContent = text;
  badge.title = title;
  badge.dataset.url = url || '';
  if (sweep) sweep.textContent = sub;
}

// --- Cron pill: "when did the cloud cron actually FIRE?" -------------------
// Shows the last real firing of the email watcher's GitHub Actions cron — and how long ago — in
// EVERY source mode (in local-scan mode the repo is auto-derived from the checkout's git remote).
// The tooltip lists the recent fires + the measured cadence: GitHub deprioritizes public-repo
// schedule crons, so the REQUESTED */15 fires every ~60-90 min in practice — this pill is the
// honest view of that. Click opens the Actions page.
function setCronPill(h) {
  const el = $('pill-cron');
  if (!el) return;
  const c = h && (h.mode === 'github' ? h : h.cron); // github mode: the health object IS the cron info
  const run = (c && c.ok && c.run) ? c.run : null;
  if (!run) { if (!(c && c.rateLimited)) el.classList.add('hidden'); return; } // keep last known text through a rate-limit blip
  el.classList.remove('hidden');
  const when = run.startedAt || run.updatedAt;
  const running = run.status && run.status !== 'completed';
  if (running) el.textContent = `☁ cloud scan running · started ${ago(when)}`;
  else el.textContent = `☁ cloud scan ran ${ago(when)}${run.conclusion === 'failure' ? ' · ⚠ failed' : ''}`;
  el.classList.toggle('bad', run.conclusion === 'failure');

  const recent = (c.recent || []).filter((r) => r.startedAt);
  const lines = recent.slice(0, 6).map((r) => {
    const state = (r.status && r.status !== 'completed') ? 'running'
      : (r.conclusion === 'success' ? '✓' : (r.conclusion || '?'));
    const dur = (r.updatedAt && r.startedAt && r.status === 'completed') ? ` · ${Math.max(1, Math.round((r.updatedAt - r.startedAt) / 60000))} min` : '';
    return `• ${ago(r.startedAt)} — ${r.event === 'schedule' ? 'auto' : 'manual'} ${state}${dur}`;
  }).join('\n');
  // Measured cadence over the recent SCHEDULED runs (manual/dispatch runs excluded).
  const sched = recent.filter((r) => r.event === 'schedule').map((r) => r.startedAt).sort((a, b) => b - a);
  let cadence = '';
  if (sched.length >= 3) {
    const gaps = [];
    for (let i = 0; i < sched.length - 1; i++) gaps.push(sched[i] - sched[i + 1]);
    cadence = `\nRuns automatically every ~${Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length / 60000)} min in practice (GitHub delays the requested 15-min schedule on free repos).`;
  }
  el.title = `Cloud scan — the watcher on GitHub that sweeps your wantlist and emails deals. Recent runs:\n${lines}${cadence}\nClick to open the run on GitHub.`;
  el.dataset.url = run.url || (c.repo ? `https://github.com/${c.repo}/actions` : '');
}

async function refreshHealth() {
  if (scanning) { setServiceBadge(lastHealth); return; } // the scan owns the badge while it runs
  if (!hasApi) { setServiceBadge({ mode: 'demo' }); return; }
  let h = null;
  try { h = await window.api.getHealth(); } catch { h = null; }
  if (h && h.mode === 'github' && h.ok && h.run) lastGithubRun = h.run;
  lastHealth = h;
  setServiceBadge(h);
  setCronPill(h);
}

// --- Sold-medians push badge -------------------------------------------------
// The local scan's git push of soldmedians.json is what keeps the CLOUD emails judging against
// real market value. A failed push used to flash by in the scan-status line and vanish — weeks of
// silently-stale references. This badge persists the last outcome: green "medians ✓", red "push
// failed" (click = retry). Hidden entirely when pushing doesn't apply (packaged install / disabled).
let pushRetrying = false;
async function refreshPushStatus() {
  if (!hasApi || typeof window.api.getPushStatus !== 'function') return;
  const el = $('push-badge');
  if (!el || pushRetrying) return;
  let st = null;
  try { st = await window.api.getPushStatus(); } catch { st = null; }
  if (!st) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  if (st.ok) {
    el.className = 'pill push ok';
    el.textContent = `medians ✓ ${st.ts ? ago(st.ts) : ''}`.trim();
    el.title = st.pushed
      ? 'Sold-medians pushed to GitHub — the cloud emails judge against fresh real-market references.'
      : 'Sold-medians already up to date on GitHub.';
  } else {
    el.className = 'pill push bad';
    el.textContent = '⚠ medians push failed';
    el.title = `Pushing soldmedians.json to GitHub failed: ${st.reason || 'git error'}\nThe cloud emails are judging against stale references until this succeeds. Click to retry.`;
  }
}
async function retryPushClick() {
  if (!hasApi || typeof window.api.retryPush !== 'function' || pushRetrying) return;
  const el = $('push-badge');
  // Only a failed state needs the retry; a green badge click is a no-op.
  if (!el || !el.classList.contains('bad')) return;
  pushRetrying = true;
  el.textContent = 'pushing…';
  try { await window.api.retryPush(); } catch { /* outcome is persisted by main either way */ }
  pushRetrying = false;
  refreshPushStatus();
}

function notifyNew(deals) {
  if (firstLoad) { firstLoad = false; deals.forEach((d) => seenIds.add(d.id)); return; }
  const fresh = deals.filter((d) => !seenIds.has(d.id));
  fresh.forEach((d) => seenIds.add(d.id));
  if (fresh.length && 'Notification' in window && Notification.permission === 'granted') {
    const d = fresh[0];
    const extra = fresh.length > 1 ? ` (+${fresh.length - 1} more)` : '';
    const n = new Notification(`💸 Discogs deal: ${money(d.lowest, d.currency)} (${pct(d.discount)} off)`, {
      body: `${d.artist || ''} – ${d.title || ''}${extra}`,
    });
    // Click the notification -> open the deal straight on Discogs.
    n.onclick = () => { openUrl(d.url); window.focus(); };
  }
}

async function refresh() {
  if (activePlatform === 'vinted') { await refreshVintedSnapshot(); return; }
  if (activePlatform === 'ebay') { await refreshEbaySnapshot(); return; }
  if (activePlatform === 'tradera') { await refreshTraderaSnapshot(); return; }
  if (viewMode === 'scan') return; // don't clobber live scan results
  allNearMisses = []; // cloud deals.json carries no near-misses — they exist only in a local scan
  if (!hasApi) {
    try {
      const r = await fetch('deals.json', { cache: 'no-store' });
      allDeals = r.ok ? await r.json() : DEMO;
    } catch { allDeals = DEMO; }
    setStatus({ wantlistSize: '—' });
    render();
    return;
  }
  try {
    const [deals, status] = await Promise.all([window.api.getDeals(200), window.api.getStatus().catch(() => null)]);
    allDeals = Array.isArray(deals) ? deals : [];
    notifyNew(allDeals);
    setStatus(status || {});
    render();
    maybeVerify(); // fire-and-forget: live-check the visible cards (cached in main, so usually free)
  } catch (e) {
    refreshHealth(); // let the badge show the authoritative service state (down/rate-limited/etc.)
    $('empty').classList.remove('hidden');
    $('empty').textContent = 'Cannot reach the watcher: ' + e.message + '  — or just hit ⚡ Full scan.';
    $('deals').innerHTML = '';
  }
}

// --- Local "Scan now" full sweep ---
// The ETA is MEASURED in main.js (both the API sweep and the browser lane — see etaMs in runScrape)
// and arrives as m.etaMs; this only formats it. The old renderer-side guess (remaining × 1.05s)
// modeled only the API sweep and was wildly off whenever the browser work dominated.
function fmtEta(ms) {
  if (ms == null || !isFinite(ms)) return '';
  const secs = Math.max(0, Math.round(ms / 1000));
  if (secs < 60) return `~${secs}s left`;
  return `~${Math.ceil(secs / 60)} min left`;
}

function resetAllScanSources() {
  scanAllSources = Object.fromEntries(Object.keys(ALL_SCAN_LABELS).map((source) => [source, { status: 'queued' }]));
}

function renderAllScanStatus(finalText = '') {
  const finished = new Set(['done', 'skipped', 'error']);
  let finishedCount = 0; let runningCount = 0;
  Object.entries(ALL_SCAN_LABELS).forEach(([source, label]) => {
    const item = scanAllSources[source] || { status: 'queued' };
    const status = item.status || item.state || 'queued';
    const chip = $(`scan-all-${source}`);
    chip.dataset.state = status;
    if (finished.has(status)) finishedCount += 1;
    if (status === 'running') runningCount += 1;
    const detail = item.detail || item.reason || item.error || '';
    const stateLabel = status === 'done' ? 'done'
      : (status === 'error' ? 'failed'
        : (status === 'skipped' ? 'skipped' : (status === 'running' ? (detail || 'scanning') : 'waiting')));
    chip.textContent = `${label} · ${stateLabel}`;
    chip.title = detail || stateLabel;
  });
  $('scan-all-status').classList.remove('hidden');
  $('scan-fill').style.width = `${Math.round((finishedCount / Object.keys(ALL_SCAN_LABELS).length) * 100)}%`;
  if (finalText) $('scan-text').textContent = finalText;
  else if (scanAllRunning) $('scan-text').textContent = `Scanning all available marketplaces · ${finishedCount}/4 finished${runningCount ? ` · ${runningCount} active` : ''}`;
}

function onAllScanUpdate(message) {
  if (!message || !message.sources) return;
  scanAllSources = { ...scanAllSources, ...message.sources };
  renderAllScanStatus();
}

function syncMarketplaceAllScan(source, status) {
  if (!scanAllRunning || !scanAllSources[source] || (scanAllSources[source].status || scanAllSources[source].state) !== 'running') return;
  const progress = status && status.progress;
  const detail = progress && progress.total
    ? `${progress.checked || 0}/${progress.total}`
    : (status && status.running ? 'scanning' : scanAllSources[source].detail);
  scanAllSources[source] = { ...scanAllSources[source], detail };
  renderAllScanStatus();
}

function updateDiscogsAllScan(message) {
  if (!scanAllRunning || !scanAllSources.discogs || (scanAllSources.discogs.status || scanAllSources.discogs.state) !== 'running') return;
  let detail = 'scanning';
  if (message.phase === 'wantlist') detail = 'wantlist';
  else if (message.phase === 'prices') detail = `${message.checked || 0}/${message.total || '?'}`;
  else if (message.phase === 'warmup') detail = 'sold medians';
  else if (message.phase === 'pushing') detail = 'saving medians';
  else if (message.phase === 'gems') detail = 'rare gems';
  else if (message.phase === 'scan') detail = `${message.checked || 0}/${message.total || '?'}`;
  scanAllSources.discogs = { ...scanAllSources.discogs, detail };
  renderAllScanStatus();
}

function setScanUI(on) {
  scanning = on;
  $('scanbar').classList.toggle('hidden', !on);
  $('scan-all-status').classList.toggle('hidden', !scanAllRunning);
  $('btn-scan-all').disabled = on || scouting || cityDigging;
  $('btn-fullscan').disabled = on || scouting || cityDigging;
  $('scout-run').disabled = on || scouting || cityDigging;
  $('city-run').disabled = on || cityDigging;
  $('btn-scan-all').innerHTML = on && scanAllRunning
    ? '<span>Scanning all…</span>'
    : '<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v6h-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg><span>Scan all</span>';
  $('btn-fullscan').innerHTML = on
    ? '<span>Scanning…</span>'
    : `<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v6h-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg><span>${ALL_SCAN_LABELS[activePlatform]} only</span>`;
  // While a scan runs the badge says "Scanning…"; once it ends, re-check the real service state.
  if (on) setServiceBadge(lastHealth); else refreshHealth();
}

let scanRetryTimer = null; // pending retry after a cloud-busy postponement (one at a time)

function acceptDiscogsScan(res) {
  const deals = (res && res.deals) || [];
  const nearMisses = (res && res.nearMisses) || [];
  platformViews.discogs = { ...platformViews.discogs, deals, nearMisses, viewMode: 'scan', scannedOnce: true };
  seenIds = new Set(deals.map((deal) => deal.id));
  if (activePlatform === 'discogs') {
    restorePlatformView('discogs');
    setStatus({ wantlistSize: res ? (res.wantlistTotal ?? res.total) : '—' });
    render();
  }
}

async function startAllScans() {
  if (!hasApi || !window.api.scanAll) { alert('Scan all needs the desktop app (run it with npm start).'); return; }
  if (scanAllRunning || scanning || scouting || cityDigging) return;
  if (scanRetryTimer) { clearTimeout(scanRetryTimer); scanRetryTimer = null; }
  if (scanAllCompletionTimer) { clearTimeout(scanAllCompletionTimer); scanAllCompletionTimer = null; }
  scanAllRunning = true;
  resetAllScanSources();
  setScanUI(true);
  $('btn-scan-cancel').textContent = 'Stop Discogs';
  $('btn-scan-cancel').title = 'Stops the Discogs scan; marketplace API checks finish independently';
  renderAllScanStatus('Starting every available marketplace…');
  let finalText = '';
  try {
    const outcome = await window.api.scanAll();
    scanAllSources = { ...scanAllSources, ...((outcome && outcome.sources) || {}) };
    const results = (outcome && outcome.results) || {};
    if (results.discogs && !results.discogs.postponed) {
      acceptDiscogsScan(results.discogs);
      refreshGems();
    }
    if (results.vinted) applyVintedSnapshot(results.vinted);
    if (results.ebay) applyEbaySnapshot(results.ebay);
    if (results.tradera) applyTraderaSnapshot(results.tradera);
    const states = Object.values(scanAllSources).map((item) => item.status || item.state);
    const completed = states.filter((state) => state === 'done').length;
    const skipped = states.filter((state) => state === 'skipped').length;
    const failed = states.filter((state) => state === 'error').length;
    finalText = `All scans finished · ${completed} completed${skipped ? ` · ${skipped} skipped` : ''}${failed ? ` · ${failed} failed` : ''}`;
  } catch (error) {
    finalText = `Scan all failed to start: ${error && error.message ? error.message : String(error)}`;
  } finally {
    scanAllRunning = false;
    setScanUI(false);
    renderVintedStatus(); renderEbayStatus(); renderTraderaStatus();
    $('scanbar').classList.remove('hidden');
    $('scan-all-status').classList.remove('hidden');
    $('btn-scan-cancel').textContent = 'Stop';
    $('btn-scan-cancel').title = '';
    renderAllScanStatus(finalText || 'All scans finished');
    scanAllCompletionTimer = setTimeout(() => {
      scanAllCompletionTimer = null;
      if (!scanning && !scanAllRunning) {
        $('scanbar').classList.add('hidden');
        $('scan-all-status').classList.add('hidden');
      }
    }, 12_000);
  }
}

async function startScan(opts = {}) {
  if (scanAllRunning) return;
  if (activePlatform === 'vinted') {
    if (!hasApi || !window.api.vintedScanNow || vintedStatus.running) return;
    vintedStatus = { ...vintedStatus, running: true, health: 'scanning', message: 'Checking newest Vinted listings and one Deep Hunt target…' };
    renderVintedStatus();
    try { applyVintedSnapshot(await window.api.vintedScanNow(), { notify: true }); }
    catch (error) {
      vintedStatus = { ...vintedStatus, running: false, health: 'error', error: error && error.message ? error.message : String(error) };
      renderVintedStatus();
    }
    return;
  }
  if (activePlatform === 'ebay') {
    if (!hasApi || !window.api.ebayScanNow || ebayStatus.running || !ebayStatus.configured) {
      if (!ebayStatus.configured) openEbaySettings();
      return;
    }
    ebayStatus = { ...ebayStatus, running: true, health: 'scanning', progress: { checked: 0, total: ebayStatus.targetCount || 0 } };
    renderEbayStatus();
    try { applyEbaySnapshot(await window.api.ebayScanNow(), { notify: true }); }
    catch (error) { ebayStatus = { ...ebayStatus, running: false, health: 'error', error: error && error.message ? error.message : String(error) }; renderEbayStatus(); }
    return;
  }
  if (activePlatform === 'tradera') {
    if (!hasApi || !window.api.traderaScanNow || traderaStatus.running || !traderaStatus.configured) {
      if (!traderaStatus.configured) openTraderaSettings();
      return;
    }
    traderaStatus = { ...traderaStatus, running: true, health: 'scanning', progress: { checked: 0, total: traderaStatus.targetCount || 0 } };
    renderTraderaStatus();
    try { applyTraderaSnapshot(await window.api.traderaScanNow(), { notify: true }); }
    catch (error) { traderaStatus = { ...traderaStatus, running: false, health: 'error', error: error && error.message ? error.message : String(error) }; renderTraderaStatus(); }
    return;
  }
  if (!hasApi) { alert('Local scan needs the desktop app (run it with npm start).'); return; }
  if (scanning || scouting || cityDigging) return;
  if (scanRetryTimer) { clearTimeout(scanRetryTimer); scanRetryTimer = null; }
  setScanUI(true);
  $('scan-fill').style.width = '0%';
  $('scan-text').textContent = opts.quick ? 'Ranking your wantlist for a quick scan…' : 'Fetching your wantlist…';
  let postponed = null; // cloud-busy postponement — handled after the UI unlock below
  try {
    const res = await window.api.scrapeRun(opts);
    if (res && res.postponed) { postponed = res; } else {
    // A BACKGROUND auto-scan in a cloud source (github/server) runs only for its side effects —
    // refreshing sold-medians (which sharpen the cloud emails) and keeping the cron alive. It must
    // NOT hijack the view: the cloud feed (now auto-verified live) stays the shown truth, so a
    // launch never silently "jumps back" to a smaller local-scan snapshot. A MANUAL scan, or an
    // auto-scan when the user's source already IS local, switches to the scan results as before.
    if (opts.background) {
      // If the scan view is what's on screen (restored by boot after a restart), a background scan
      // just produced FRESHER results for that very view — show them instead of the stale snapshot.
      if (platformViews.discogs.viewMode === 'scan') acceptDiscogsScan(res);
      refreshGems();
      refresh(); // no-op in scan view; otherwise re-pull + re-verify the cloud feed
    } else {
      acceptDiscogsScan(res);
      refreshGems(); // the scan may have found rare gems / refreshed the zero-stock watch list
    }
    }
  } catch (e) {
    $('empty').classList.remove('hidden');
    $('empty').textContent = 'Scan failed: ' + e.message;
  } finally {
    setScanUI(false);
  }
  // Postponed: the cloud scan is sweeping right now, and both share ONE Discogs rate budget —
  // running them together makes each take hours (seen live 2026-07-18). Keep the bar visible with
  // the reason, and retry every few minutes; the scan starts the moment the cloud run is done.
  if (postponed) {
    const mins = postponed.cloudBusy && postponed.cloudBusy.endsInMs ? Math.ceil(postponed.cloudBusy.endsInMs / 60000) : null;
    $('scanbar').classList.remove('hidden');
    $('scan-fill').style.width = '0%';
    $('scan-text').textContent = `☁ The cloud scan is running right now — scanning locally at the same time would make both crawl (they share your Discogs rate limit). Your scan starts automatically when it finishes${mins ? ` (~${mins} min)` : ''}.`;
    scanRetryTimer = setTimeout(() => { scanRetryTimer = null; $('scanbar').classList.add('hidden'); startScan(opts); }, 3 * 60_000);
  }
}

// Auto-scan: keep the real per-copy condition + sold-medians fresh (and thus the cloud emails sharp)
// without the user having to remember to click "Scan now". Runs on launch — and periodically while
// the app stays open — only when the last scan is older than the configured age (0 = off). Because a
// scan pushes soldmedians.json as YOU, regular auto-scans also keep the GitHub cron from being
// disabled after 60 days of no user activity.
async function maybeAutoScan() {
  if (activePlatform !== 'discogs' || !hasApi || scanning || scouting) return; // both scans share one Discogs token/rate budget
  // Need a configured Discogs token, or a scan can't run (and would just error).
  let cfg; try { cfg = await window.api.getConfig(); } catch { cfg = null; }
  if (!cfg || !cfg.hasToken || !cfg.username) return;
  let s; try { s = await window.api.getSettings(); } catch { return; }
  const hrs = Number(s.autoScanOnLaunchHours || 0);
  if (!hrs) return;
  let last; try { last = await window.api.scrapeLast(); } catch { last = null; }
  const ageH = last && last.ts ? (Date.now() - last.ts) / 3600000 : Infinity;
  // In a cloud source the auto-scan is a background medians refresh — it must not replace the
  // (auto-verified) cloud view. Only when the user's source IS the local scan does it drive the view.
  const cloud = s.sourceType === 'github' || s.sourceType === 'server';
  if (ageH >= hrs) startScan({ background: cloud });
}

function onScanProgress(m) {
  if (!m) return;
  if (scanAllRunning) { updateDiscogsAllScan(m); return; }
  if (m.phase === 'wantlist') { $('scan-text').textContent = 'Fetching your wantlist…'; $('scan-fill').style.width = '3%'; return; }
  if (m.phase === 'prices') {
    const total = m.total || 1;
    $('scan-fill').style.width = Math.min(100, Math.round((m.checked / total) * 100)) + '%';
    $('scan-text').textContent = `Confirming condition ${m.checked}/${total} · ${m.found} VG+ deal${m.found === 1 ? '' : 's'}`;
    return;
  }
  if (m.phase === 'warmup') {
    $('scan-fill').style.width = '100%';
    const eta = fmtEta(m.etaMs);
    $('scan-text').textContent = `Refreshing sold-medians ${m.checked}/${m.total}…${eta ? ` ${eta} ·` : ''} (real market value — also sharpens cloud emails)`;
    return;
  }
  if (m.phase === 'pushing') { $('scan-text').textContent = 'Saving sold-medians to GitHub for the email watcher…'; return; }
  if (m.phase === 'gems') {
    $('scan-fill').style.width = '100%';
    $('scan-text').textContent = `Checking recent sales for rare gems ${m.checked}/${m.total}…`;
    return;
  }
  if (m.phase === 'done') {
    $('scan-fill').style.width = '100%';
    const dropped = m.droppedNoVgPlus ? ` · ${m.droppedNoVgPlus} skipped (no VG+ copy)` : '';
    // Surface the auto-push outcome so the user knows the cloud emails were updated (or why not).
    let push = '';
    if (m.mediansPush) {
      if (m.mediansPush.pushed) push = ' · medians pushed to GitHub ✓';
      else if (m.mediansPush.ok) push = ' · medians already up to date';
      else push = ` · ⚠ medians push failed (${m.mediansPush.reason || 'git error'}) — commit manually`;
    }
    const ship = m.realShip != null && m.found ? ` · ${m.realShip}/${m.found} with real shipping` : '';
    const cov = m.quick ? ` · quick scan (top ${m.total} of ${m.wantlistTotal})` : '';
    const miss = m.nearMisses ? ` · ${m.nearMisses} near-miss${m.nearMisses === 1 ? '' : 'es'} (tick “Show near-misses”)` : '';
    const warm = m.warmedReal ? ` · ${m.warmedReal} sold-median${m.warmedReal === 1 ? '' : 's'} ${m.fullMedians ? 'refreshed' : 'learned'}` : '';
    const gem = m.gems ? ` · 💎 ${m.gems} rare gem${m.gems === 1 ? '' : 's'} (see the Rare tab)` : '';
    const cf = m.cfFailed ? ` · ⚠ ${m.cfFailed} release${m.cfFailed === 1 ? '' : 's'} didn’t clear Cloudflare (estimate shown — retried next scan)` : '';
    $('scan-text').textContent = `Done — ${m.found} VG+ deal${m.found === 1 ? '' : 's'}${gem}${ship}${dropped}${cf}${cov}${m.aborted ? ' (stopped early)' : ''}.${push}${warm}${miss}`;
    refreshPushStatus(); // the scan may just have pushed (or failed to push) the medians
    return;
  }
  // 'scan' phase: the API sweep and the browser confirmation run concurrently now, so one message
  // carries both — the bar tracks the sweep (the dominant timeline) and the text adds the live deal
  // count plus, once the sweep is done, how many candidates are still being confirmed.
  const total = m.total || 1;
  const pctDone = Math.min(100, Math.round((m.checked / total) * 100));
  $('scan-fill').style.width = pctDone + '%';
  const found = m.found || 0;
  const remaining = Math.max(0, (m.candidates || 0) - (m.processed || 0));
  const eta = fmtEta(m.etaMs);
  const tail = (m.checked >= total && remaining > 0)
    ? ` · confirming last ${remaining}${eta ? ` · ${eta}` : ''}`
    : (eta ? ` · ${eta}` : '');
  $('scan-text').textContent = `Scanning ${m.checked}/${total} · ${found} deal${found === 1 ? '' : 's'}${tail}`;
}

// --- Settings modal ---
function toggleSrc() {
  const t = $('set-sourceType').value;
  document.querySelector('.src-server').classList.toggle('hidden', t !== 'server');
  document.querySelector('.src-github').classList.toggle('hidden', t !== 'github');
}

async function openSettings() {
  const s = hasApi ? await window.api.getSettings() : { sourceType: 'scan', githubRepo: '', githubToken: '', apiBase: '', token: '', autoScanOnLaunchHours: 1 };
  $('set-sourceType').value = s.sourceType || 'scan';
  $('set-apiBase').value = s.apiBase || '';
  $('set-token').value = s.token || '';
  $('set-githubRepo').value = s.githubRepo || '';
  $('set-githubToken').value = s.githubToken || '';
  $('set-autoScan').value = String(s.autoScanOnLaunchHours ?? 1);
  toggleSrc();
  $('set-test').textContent = '';
  $('set-test').className = 'test-result';
  $('settings-modal').classList.remove('hidden');
  refreshDiscogsLoginStatus();
}
function closeSettings() { $('settings-modal').classList.add('hidden'); }

async function openEbaySettings() {
  closeSettings();
  const result = $('ebay-test-result'); result.textContent = ''; result.className = 'test-result';
  let settings = {}; let credentials = {};
  if (hasApi) {
    [settings, credentials] = await Promise.all([
      window.api.getSettings().catch(() => ({})),
      window.api.ebayCredentialsStatus().catch(() => ({})),
    ]);
  }
  $('ebay-environment').value = settings.ebayEnvironment === 'sandbox' ? 'sandbox' : 'production';
  $('ebay-marketplace').value = settings.ebayMarketplace || 'EBAY_NL';
  $('ebay-country').value = settings.ebayDeliveryCountry || 'NL';
  $('ebay-postal-code').value = settings.ebayPostalCode || '';
  $('ebay-client-id').value = credentials.clientId || '';
  $('ebay-client-secret').value = '';
  $('ebay-client-secret').placeholder = credentials.hasSecret ? 'saved securely — leave blank to keep' : 'paste once; encrypted on save';
  if (credentials.encryptionAvailable === false) {
    result.textContent = 'Secure credential storage is unavailable; the Cert ID cannot be saved on this computer.';
    result.className = 'test-result bad';
  }
  $('ebay-modal').classList.remove('hidden');
  $('ebay-client-id').focus();
}
function closeEbaySettings() { $('ebay-modal').classList.add('hidden'); }
function collectEbayOptions() {
  return {
    environment: $('ebay-environment').value,
    marketplace: $('ebay-marketplace').value,
    deliveryCountry: $('ebay-country').value,
    postalCode: $('ebay-postal-code').value.trim(),
  };
}
async function saveEbaySetup(runTest = false) {
  const result = $('ebay-test-result');
  if (!hasApi) { result.textContent = 'Demo mode (no Electron bridge).'; return false; }
  const clientId = $('ebay-client-id').value.trim();
  const clientSecret = $('ebay-client-secret').value.trim();
  if (!clientId) { result.textContent = 'Enter the eBay App ID first.'; result.className = 'test-result bad'; return false; }
  result.textContent = runTest ? 'Saving securely and testing eBay…' : 'Saving securely…'; result.className = 'test-result';
  $('ebay-test-btn').disabled = true; $('ebay-save').disabled = true;
  try {
    await window.api.ebaySaveCredentials({ clientId, clientSecret });
    const options = collectEbayOptions();
    await window.api.ebayConfigure(options);
    $('ebay-client-secret').value = '';
    $('ebay-client-secret').placeholder = 'saved securely — leave blank to keep';
    if (runTest) {
      const response = await window.api.ebayTest({
        ebayEnvironment: options.environment,
        ebayMarketplace: options.marketplace,
        ebayDeliveryCountry: options.deliveryCountry,
        ebayPostalCode: options.postalCode,
      });
      if (!response || !response.ok) throw new Error(response && response.error || 'eBay connection test failed.');
      result.textContent = options.environment === 'sandbox'
        ? '✓ Sandbox credentials accepted. Sandbox search uses eBay mock inventory.'
        : `✓ Connected to ${options.marketplace}. The production Browse API returned successfully.`;
      result.className = 'test-result ok';
      await refreshEbaySnapshot();
    } else {
      closeEbaySettings(); await refreshEbaySnapshot();
    }
    return true;
  } catch (error) {
    result.textContent = 'Failed: ' + (error && error.message ? error.message : String(error)); result.className = 'test-result bad'; return false;
  } finally { $('ebay-test-btn').disabled = false; $('ebay-save').disabled = false; }
}

async function openTraderaSettings() {
  closeSettings();
  const result = $('tradera-test-result'); result.textContent = ''; result.className = 'test-result';
  let credentials = {};
  if (hasApi) credentials = await window.api.traderaCredentialsStatus().catch(() => ({}));
  $('tradera-app-id').value = credentials.appId || '';
  $('tradera-app-key').value = '';
  $('tradera-app-key').placeholder = credentials.hasKey ? 'saved securely — leave blank to keep' : 'paste once; encrypted on save';
  if (credentials.encryptionAvailable === false) {
    result.textContent = 'Secure credential storage is unavailable; the App Key cannot be saved on this computer.';
    result.className = 'test-result bad';
  }
  $('tradera-modal').classList.remove('hidden');
  $('tradera-app-id').focus();
}
function closeTraderaSettings() { $('tradera-modal').classList.add('hidden'); }
async function saveTraderaSetup(runTest = false) {
  const result = $('tradera-test-result');
  if (!hasApi) { result.textContent = 'Demo mode (no Electron bridge).'; return false; }
  const appId = $('tradera-app-id').value.trim();
  const appKey = $('tradera-app-key').value.trim();
  if (!/^\d+$/.test(appId)) { result.textContent = 'Enter the numeric Tradera App ID first.'; result.className = 'test-result bad'; return false; }
  result.textContent = runTest ? 'Saving securely and testing Tradera…' : 'Saving securely…'; result.className = 'test-result';
  $('tradera-test-btn').disabled = true; $('tradera-save').disabled = true;
  try {
    await window.api.traderaSaveCredentials({ appId, appKey });
    $('tradera-app-key').value = '';
    $('tradera-app-key').placeholder = 'saved securely — leave blank to keep';
    if (runTest) {
      const response = await window.api.traderaTest();
      if (!response || !response.ok) throw new Error(response && response.error || 'Tradera connection test failed.');
      result.textContent = `✓ Connected to Tradera REST v4. Search returned ${Number(response.sampleItems || 0)} sample item${Number(response.sampleItems || 0) === 1 ? '' : 's'}.`;
      result.className = 'test-result ok';
      await refreshTraderaSnapshot();
    } else {
      closeTraderaSettings(); await refreshTraderaSnapshot();
    }
    return true;
  } catch (error) {
    result.textContent = 'Failed: ' + (error && error.message ? error.message : String(error)); result.className = 'test-result bad'; return false;
  } finally { $('tradera-test-btn').disabled = false; $('tradera-save').disabled = false; }
}

// 💎 Recent-sales-for-gems login status: reflects whether the Sales History page is unlocked.
async function refreshDiscogsLoginStatus() {
  const el = $('set-discogs-login-status');
  if (!el) return;
  if (!hasApi) { el.textContent = ''; return; }
  const loggedIn = await window.api.getDiscogsLoginStatus().catch(() => false);
  el.textContent = loggedIn
    ? '✓ Logged in — rare gems show recent sales history.'
    : 'Not logged in yet — rare gems show only the estimated median.';
}
async function loginToDiscogs() {
  const btn = $('set-discogs-login-btn');
  btn.disabled = true;
  const el = $('set-discogs-login-status');
  if (el) el.textContent = 'Waiting for you to log in in the window that just opened…';
  try {
    const res = await window.api.loginDiscogs();
    if (res && res.started === false) { if (el) el.textContent = 'A login window is already open.'; return; }
  } finally { btn.disabled = false; }
  refreshDiscogsLoginStatus();
}

function collectSettings() {
  return {
    sourceType: $('set-sourceType').value,
    apiBase: $('set-apiBase').value.trim(),
    token: $('set-token').value.trim(),
    githubRepo: $('set-githubRepo').value.trim(),
    githubToken: $('set-githubToken').value.trim(),
    autoScanOnLaunchHours: parseInt($('set-autoScan').value, 10) || 0,
  };
}

// Merge over the persisted settings so saving the modal never drops keys it doesn't render
// (e.g. autoPushMedians, githubBranch).
async function persistSettings() {
  if (!hasApi) return;
  const cur = await window.api.getSettings().catch(() => ({}));
  await window.api.saveSettings({ ...cur, ...collectSettings() });
}

async function saveSettings() {
  await persistSettings();
  closeSettings();
  firstLoad = true; seenIds = new Set();
  firstGemLoad = true; seenGemIds = new Set(); // gems come from the (possibly changed) source too
  lastGithubRun = null; // source may have changed (scan <-> github <-> server) — don't carry a stale run
  boot(); // re-evaluate the (possibly changed) source: scan view, cloud poll, or server
  refreshGems();
}

async function testConnection() {
  const el = $('set-test');
  el.textContent = 'Testing…'; el.className = 'test-result';
  if (!hasApi) { el.textContent = 'Demo mode (no Electron bridge).'; return; }
  await persistSettings();
  try {
    const deals = await window.api.getDeals(200);
    let extra = '';
    try { const st = await window.api.getStatus(); if (st && st.wantlistSize != null) extra = ` · wantlist ${st.wantlistSize}`; } catch { /* github mode has no status */ }
    el.textContent = `OK — ${Array.isArray(deals) ? deals.length : 0} deal(s) available${extra}.`;
    el.className = 'test-result ok';
  } catch (e) {
    el.textContent = 'Failed: ' + e.message;
    el.className = 'test-result bad';
  }
}

// --- First-run / Discogs account wizard ---
async function openWizard(firstRun) {
  let c = null;
  if (hasApi) { try { c = await window.api.getConfig(); } catch { c = null; } }
  $('wiz-username').value = (c && c.username) || '';
  $('wiz-token').value = '';
  $('wiz-token').placeholder = (c && c.hasToken) ? 'leave blank to keep your saved token' : 'paste your token here';
  $('wiz-currency').value = (c && c.currency) || 'EUR';
  $('wiz-title').textContent = firstRun ? 'Welcome 👋' : 'Discogs account';
  $('wiz-intro').classList.toggle('hidden', !firstRun);
  $('wiz-cancel').textContent = firstRun ? 'Later' : 'Cancel';
  $('wiz-test').textContent = ''; $('wiz-test').className = 'test-result';
  $('wizard-modal').classList.remove('hidden');
  $('wiz-username').focus();
}
function closeWizard() { $('wizard-modal').classList.add('hidden'); }

async function wizardTest() {
  const el = $('wiz-test');
  if (!hasApi) { el.textContent = 'Demo mode (no Electron bridge).'; el.className = 'test-result'; return; }
  const username = $('wiz-username').value.trim();
  const token = $('wiz-token').value.trim();
  if (!token) { el.textContent = 'Enter your token first.'; el.className = 'test-result bad'; return; }
  el.textContent = 'Testing…'; el.className = 'test-result';
  try {
    const r = await window.api.testConfig({ username, token });
    if (r && r.ok) {
      el.textContent = `OK — signed in as ${r.username}${r.wantlist != null ? ` · ${r.wantlist} releases on the wantlist` : ''}.`;
      el.className = 'test-result ok';
    } else {
      el.textContent = (r && r.error) || 'Failed.';
      el.className = 'test-result bad';
    }
  } catch (e) { el.textContent = 'Failed: ' + e.message; el.className = 'test-result bad'; }
}

async function wizardSave() {
  if (!hasApi) { closeWizard(); return; }
  const el = $('wiz-test');
  const username = $('wiz-username').value.trim();
  const token = $('wiz-token').value.trim();
  const currency = $('wiz-currency').value;
  if (!username) { el.textContent = 'Please enter your Discogs username.'; el.className = 'test-result bad'; return; }
  let cfg = null; try { cfg = await window.api.getConfig(); } catch { cfg = null; }
  if (!token && !(cfg && cfg.hasToken)) { el.textContent = 'Please enter your Discogs token.'; el.className = 'test-result bad'; return; }
  const patch = { username, currency };
  if (token) patch.token = token; // blank = keep the saved token
  await window.api.saveConfig(patch);
  closeWizard();
  // Creds now exist — surface deals by kicking off a scan (the core action for a fresh install).
  viewMode = 'scan';
  startScan();
}

// --- ☁ Cloud setup wizard (24/7 email alerts on the user's own GitHub fork) ---
let cloudRunning = false;

function cloudResetSteps() {
  document.querySelectorAll('#cloud-steps li').forEach((li) => { li.className = ''; li.removeAttribute('data-detail'); });
}

async function openCloud() {
  closeSettings();
  cloudResetSteps();
  $('cloud-steps').classList.add('hidden');
  $('cloud-open-btn').classList.add('hidden');
  $('cloud-result').textContent = ''; $('cloud-result').className = 'test-result';
  $('cloud-run').disabled = false;
  // Prefill the alert address from an earlier attempt is not possible (tokens are never stored) —
  // but a missing Discogs account is a hard prerequisite, so surface that immediately.
  if (hasApi) {
    try {
      const c = await window.api.getConfig();
      if (!c || !c.hasToken || !c.username) {
        $('cloud-result').textContent = 'Set up your Discogs account first (Settings → Discogs account) — the cloud watcher scans that wantlist.';
        $('cloud-result').className = 'test-result bad';
        $('cloud-run').disabled = true;
      }
    } catch { /* leave enabled; the main process re-checks anyway */ }
  }
  $('cloud-modal').classList.remove('hidden');
  $('cloud-github').focus();
}
function closeCloud() { if (!cloudRunning) $('cloud-modal').classList.add('hidden'); }

function onCloudProgress(m) {
  if (!m || !m.step) return;
  const li = document.querySelector(`#cloud-steps li[data-step="${m.step}"]`);
  if (!li) return;
  li.className = m.state === 'ok' ? 'ok' : m.state === 'busy' ? 'busy' : '';
  if (m.detail) li.setAttribute('data-detail', m.detail);
}

async function runCloudSetup() {
  if (cloudRunning) return;
  const el = $('cloud-result');
  if (!hasApi) { el.textContent = 'Demo mode (no Electron bridge).'; return; }
  cloudRunning = true;
  $('cloud-run').disabled = true;
  cloudResetSteps();
  $('cloud-steps').classList.remove('hidden');
  el.textContent = 'Setting up — this takes a minute or two…'; el.className = 'test-result';
  try {
    const r = await window.api.cloudSetup({
      githubToken: $('cloud-github').value,
      mailTo: $('cloud-mailto').value,
      resendKey: $('cloud-resend').value,
    });
    if (r && r.ok) {
      el.textContent = `✓ Done! Your cloud watcher (${r.fork}) is live and running its first scan now. `
        + 'Deal emails start arriving after it has watched your wantlist for a few scans (it learns normal prices first). '
        + 'GitHub runs it roughly every 1–1.5 hours. Check your spam folder for the first email.';
      el.className = 'test-result ok';
      const btn = $('cloud-open-btn');
      btn.classList.remove('hidden');
      btn.dataset.url = r.url;
      $('cloud-github').value = ''; $('cloud-resend').value = ''; // tokens are never kept around
      refreshHealth(); // light up the ☁ pill / badge against the fresh fork
    } else {
      el.textContent = (r && r.error) || 'Setup failed.';
      el.className = 'test-result bad';
      $('cloud-run').disabled = false;
    }
  } catch (e) {
    el.textContent = 'Setup failed: ' + e.message;
    el.className = 'test-result bad';
    $('cloud-run').disabled = false;
  } finally {
    cloudRunning = false;
  }
}

// --- ✈ Telegram push setup ---
// Telegram alerts are sent by the CLOUD watcher (the fork), so connecting = saving two secrets to it.
// Flow: paste bot token → Test (resolve chat id + send a test message) → Connect (store on the fork,
// needs the GitHub token + the cloud email watcher to exist). Test works standalone so the user can
// verify their bot even before the cloud is set up.
let tgRunning = false;
let tgChatId = '';

function tgResetSteps() {
  document.querySelectorAll('#tg-steps li').forEach((li) => { li.className = ''; li.removeAttribute('data-detail'); });
}

async function openTelegram() {
  closeSettings();
  tgChatId = '';
  $('tg-token').value = ''; $('tg-github').value = '';
  $('tg-test-result').textContent = ''; $('tg-test-result').className = 'test-result';
  $('tg-result').textContent = ''; $('tg-result').className = 'test-result';
  $('tg-connect-wrap').classList.add('hidden');
  $('tg-connect').classList.add('hidden');
  $('tg-steps').classList.add('hidden');
  tgResetSteps();
  // Whether the user has a cloud watcher to save the secrets onto (set by the email-alerts setup).
  let hasFork = false;
  if (hasApi) { try { const s = await window.api.getSettings(); hasFork = !!(s && s.githubRepo); } catch { /* ignore */ } }
  if (!hasFork) {
    $('tg-test-result').textContent = 'Tip: you can test your bot now, but saving it needs the cloud watcher. Set up “24/7 email alerts” first (Settings), then come back here.';
    $('tg-test-result').className = 'test-result';
  }
  $('telegram-modal').classList.remove('hidden');
  $('tg-token').focus();
}
function closeTelegram() { if (!tgRunning) $('telegram-modal').classList.add('hidden'); }

async function runTelegramTest() {
  const el = $('tg-test-result');
  if (!hasApi) { el.textContent = 'Demo mode (no Electron bridge).'; el.className = 'test-result bad'; return; }
  const botToken = $('tg-token').value.trim();
  if (!botToken) { el.textContent = 'Paste your bot token first (from @BotFather).'; el.className = 'test-result bad'; return; }
  el.textContent = 'Testing — check Telegram for a message…'; el.className = 'test-result';
  $('tg-test-btn').disabled = true;
  try {
    const r = await window.api.telegramTest({ botToken });
    if (r && r.ok) {
      tgChatId = r.chatId;
      el.textContent = `✓ Test message sent${r.name ? ' to ' + r.name : ''}. Check your Telegram.`;
      el.className = 'test-result ok';
      // Reveal the connect step only if there's a cloud watcher to save it to.
      let hasFork = false;
      try { const s = await window.api.getSettings(); hasFork = !!(s && s.githubRepo); } catch { /* ignore */ }
      if (hasFork) {
        $('tg-connect-wrap').classList.remove('hidden');
        $('tg-connect').classList.remove('hidden');
      } else {
        $('tg-result').textContent = 'Bot works! To make alerts arrive when the app is closed, set up “24/7 email alerts” first (Settings → Set up cloud alerts…), then reopen this to Connect.';
        $('tg-result').className = 'test-result';
      }
    } else {
      el.textContent = (r && r.error) || 'Test failed.';
      el.className = 'test-result bad';
    }
  } catch (e) {
    el.textContent = 'Test failed: ' + e.message; el.className = 'test-result bad';
  } finally {
    $('tg-test-btn').disabled = false;
  }
}

function onTelegramProgress(m) {
  if (!m || !m.step) return;
  const li = document.querySelector(`#tg-steps li[data-step="${m.step}"]`);
  if (!li) return;
  li.className = m.state === 'ok' ? 'ok' : m.state === 'busy' ? 'busy' : '';
  if (m.detail) li.setAttribute('data-detail', m.detail);
}

async function runTelegramSetup() {
  if (tgRunning) return;
  const el = $('tg-result');
  if (!hasApi) { el.textContent = 'Demo mode (no Electron bridge).'; el.className = 'test-result bad'; return; }
  const githubToken = $('tg-github').value.trim();
  if (!githubToken) { el.textContent = 'Paste your GitHub token to save this to your cloud watcher.'; el.className = 'test-result bad'; return; }
  tgRunning = true;
  $('tg-connect').disabled = true;
  tgResetSteps();
  $('tg-steps').classList.remove('hidden');
  el.textContent = 'Saving to your cloud watcher…'; el.className = 'test-result';
  try {
    const r = await window.api.telegramSetup({ githubToken, botToken: $('tg-token').value.trim(), chatId: tgChatId });
    if (r && r.ok) {
      el.textContent = '✓ Connected! Telegram alerts are on. Your cloud watcher will push deals here from its next run.';
      el.className = 'test-result ok';
      $('tg-github').value = ''; $('tg-token').value = ''; // tokens are never kept around
      $('tg-connect').classList.add('hidden');
      setTelegramBadge(true);
    } else {
      el.textContent = (r && r.error) || 'Setup failed.'; el.className = 'test-result bad';
      $('tg-connect').disabled = false;
    }
  } catch (e) {
    el.textContent = 'Setup failed: ' + e.message; el.className = 'test-result bad';
    $('tg-connect').disabled = false;
  } finally {
    tgRunning = false;
  }
}

function setTelegramBadge(connected) {
  const b = $('btn-telegram');
  if (!b) return;
  b.classList.toggle('ok', !!connected);
  b.title = connected
    ? 'Telegram alerts are connected — click to change'
    : 'Telegram alerts — get deals instantly on your phone (backup for the email)';
}

// Decide what to show on launch: the first-run wizard if there are no Discogs creds, otherwise the
// configured deal source ('scan' by default).
async function boot() {
  if (!hasApi) { refresh(); return; }
  let cfg = null; try { cfg = await window.api.getConfig(); } catch { cfg = null; }
  if (!cfg || !cfg.hasToken || !cfg.username) {
    viewMode = 'scan';
    $('deals').innerHTML = '';
    $('empty').classList.remove('hidden');
    $('empty').textContent = 'Welcome! Enter your Discogs username + token to start (⚙ Settings → Discogs account), then hit ⚡ Full scan.';
    openWizard(true);
    refreshHealth();
    return;
  }
  let s = null; try { s = await window.api.getSettings(); } catch { s = {}; }
  setTelegramBadge(!!(s && s.telegramConnected));
  // The deals tab ALWAYS shows the local scan: condition-verified VG+ copies with real shipping —
  // the only view worth buying from. The cloud alert feed exists to drive the EMAILS (be-there-fast
  // channel); it is deliberately not a dashboard view. Gems + the service badge/pills still ride
  // the configured cloud source, so 💎 finds and watcher health stay visible.
  viewMode = 'scan';
  let last = null; try { last = await window.api.scrapeLast(); } catch { last = null; }
  if (last && Array.isArray(last.deals)) {
    scannedOnce = true;
    allDeals = last.deals; allNearMisses = last.nearMisses || []; seenIds = new Set(allDeals.map((d) => d.id));
    setStatus({ wantlistSize: last.wantlistTotal != null ? last.wantlistTotal : '—' });
  } else {
    allDeals = []; allNearMisses = [];
  }
  let lastScoutResult = null; try { lastScoutResult = await window.api.scoutLast(); } catch { lastScoutResult = null; }
  if (lastScoutResult) scoutData = normalizeScoutData(lastScoutResult);
  let lastCityResult = null; try { lastCityResult = await window.api.cityDigLast(); } catch { lastCityResult = null; }
  if (lastCityResult) cityDigData = normalizeCityDigData(lastCityResult);
  platformViews.discogs = { deals: allDeals, nearMisses: allNearMisses, gems: gemsData, viewMode, scannedOnce };
  await setPlatform(activePlatform);
  refreshHealth();
}

// --- wire up ---
window.addEventListener('DOMContentLoaded', () => {
  applyFilterState(readFilterState());
  applyScoutPrefs(loadScoutPrefs());
  let cityPrefs = {}; try { cityPrefs = JSON.parse(localStorage.getItem(CITY_PREFS_KEY) || '{}'); } catch { cityPrefs = {}; }
  $('city-limit').value = '100';
  if (Array.isArray(cityPrefs.taxonomies) && cityPrefs.taxonomies.length) {
    const selectedTaxonomies = new Set(cityPrefs.taxonomies);
    document.querySelectorAll('#city-taxonomies input').forEach((input) => { input.checked = selectedTaxonomies.has(input.value); });
  }
  renderCityDirectory(new Set(Array.isArray(cityPrefs.sellerUsernames) && cityPrefs.sellerUsernames.length ? cityPrefs.sellerUsernames : (currentCity()?.stores || []).filter((store) => store.sellerUsername).map((store) => store.sellerUsername)));
  updateFilterUi();
  updateViewCopy();
  $('platform-select').addEventListener('change', () => setPlatform($('platform-select').value));
  $('tab-deals').addEventListener('click', () => setTab('deals'));
  $('tab-gems').addEventListener('click', () => setTab('gems'));
  $('tab-scout').addEventListener('click', () => setTab('scout'));
  $('tab-city').addEventListener('click', () => setTab('city'));
  $('scout-form').addEventListener('submit', startScout);
  $('scout-cancel').addEventListener('click', () => { if (hasApi) window.api.scoutCancel(); $('scout-status').textContent = 'Stopping Scout…'; });
  $('city-form').addEventListener('submit', startCityDig);
  $('city-cancel').addEventListener('click', () => { if (hasApi) window.api.cityDigCancel(); $('city-status').textContent = 'Stopping City Dig…'; });
  $('city-refresh-counts').addEventListener('click', refreshCityCounts);
  $('city-sort').addEventListener('change', renderCityDig);
  $('city-antwerp-pin').addEventListener('click', () => { setTab('city'); requestAnimationFrame(focusCurrentCity); });
  $('city-osm-credit').addEventListener('click', (event) => { event.preventDefault(); openUrl('https://www.openstreetmap.org/copyright'); });
  $('btn-filter-toggle').addEventListener('click', () => setFilterPanel($('btn-filter-toggle').getAttribute('aria-expanded') !== 'true'));
  $('btn-filter-reset').addEventListener('click', resetFilters);
  $('btn-scan-all').addEventListener('click', startAllScans);
  $('btn-fullscan').addEventListener('click', () => startScan({ fullMedians: true }));
  $('vinted-scan-now').addEventListener('click', () => startScan());
  $('vinted-backfill').addEventListener('click', async () => {
    if (!hasApi || !window.api.vintedStartBackfill || !window.api.vintedCancelBackfill) return;
    const button = $('vinted-backfill');
    button.disabled = true;
    try {
      const active = !!(vintedStatus.backfill && vintedStatus.backfill.active);
      applyVintedSnapshot(await (active ? window.api.vintedCancelBackfill() : window.api.vintedStartBackfill()));
    } catch (error) {
      vintedStatus = { ...vintedStatus, health: 'error', error: error && error.message ? error.message : String(error) };
      renderVintedStatus();
    } finally { button.disabled = false; }
  });
  $('vinted-enabled').addEventListener('change', async () => {
    if (!hasApi || !window.api.vintedSetEnabled) return;
    $('vinted-enabled').disabled = true;
    try { applyVintedSnapshot(await window.api.vintedSetEnabled($('vinted-enabled').checked)); }
    catch (error) { vintedStatus = { ...vintedStatus, health: 'error', error: error.message }; renderVintedStatus(); }
    finally { $('vinted-enabled').disabled = false; }
  });
  $('vinted-poll-interval').addEventListener('change', async () => {
    if (!hasApi || !window.api.vintedConfigure) return;
    try { applyVintedSnapshot(await window.api.vintedConfigure({ pollSeconds: Number($('vinted-poll-interval').value) })); }
    catch (error) { vintedStatus = { ...vintedStatus, health: 'error', error: error.message }; renderVintedStatus(); }
  });
  $('ebay-scan-now').addEventListener('click', () => startScan());
  $('ebay-configure').addEventListener('click', openEbaySettings);
  $('ebay-enabled').addEventListener('change', async () => {
    if (!hasApi || !window.api.ebaySetEnabled) return;
    $('ebay-enabled').disabled = true;
    try { applyEbaySnapshot(await window.api.ebaySetEnabled($('ebay-enabled').checked)); }
    catch (error) { ebayStatus = { ...ebayStatus, health: 'error', error: error.message }; renderEbayStatus(); }
    finally { $('ebay-enabled').disabled = !ebayStatus.configured; }
  });
  $('ebay-poll-interval').addEventListener('change', async () => {
    if (!hasApi || !window.api.ebayConfigure) return;
    try { applyEbaySnapshot(await window.api.ebayConfigure({ pollMinutes: Number($('ebay-poll-interval').value) })); }
    catch (error) { ebayStatus = { ...ebayStatus, health: 'error', error: error.message }; renderEbayStatus(); }
  });
  $('tradera-scan-now').addEventListener('click', () => startScan());
  $('tradera-configure').addEventListener('click', openTraderaSettings);
  $('tradera-enabled').addEventListener('change', async () => {
    if (!hasApi || !window.api.traderaSetEnabled) return;
    $('tradera-enabled').disabled = true;
    try { applyTraderaSnapshot(await window.api.traderaSetEnabled($('tradera-enabled').checked)); }
    catch (error) { traderaStatus = { ...traderaStatus, health: 'error', error: error.message }; renderTraderaStatus(); }
    finally { $('tradera-enabled').disabled = !traderaStatus.configured; }
  });
  $('tradera-poll-interval').addEventListener('change', async () => {
    if (!hasApi || !window.api.traderaConfigure) return;
    try { applyTraderaSnapshot(await window.api.traderaConfigure({ pollMinutes: Number($('tradera-poll-interval').value) })); }
    catch (error) { traderaStatus = { ...traderaStatus, health: 'error', error: error.message }; renderTraderaStatus(); }
  });
  $('btn-scan-cancel').addEventListener('click', () => { if (hasApi) window.api.scrapeCancel(); $('scan-text').textContent = 'Stopping…'; });
  $('btn-settings').addEventListener('click', openSettings);
  $('svc-badge').addEventListener('click', () => { const u = $('svc-badge').dataset.url; if (u) openUrl(u); });
  $('pill-cron').addEventListener('click', () => { const u = $('pill-cron').dataset.url; if (u) openUrl(u); });
  $('push-badge').addEventListener('click', retryPushClick);
  $('set-cancel').addEventListener('click', closeSettings);
  $('set-discogs-login-btn').addEventListener('click', loginToDiscogs);
  $('set-save').addEventListener('click', saveSettings);
  $('set-test-btn').addEventListener('click', testConnection);
  $('set-sourceType').addEventListener('change', toggleSrc);
  $('set-account-btn').addEventListener('click', () => { closeSettings(); openWizard(false); });
  $('set-ebay-btn').addEventListener('click', openEbaySettings);
  $('ebay-cancel').addEventListener('click', closeEbaySettings);
  $('ebay-save').addEventListener('click', () => saveEbaySetup(false));
  $('ebay-test-btn').addEventListener('click', () => saveEbaySetup(true));
  $('ebay-keys-help').addEventListener('click', (event) => { event.preventDefault(); openUrl('https://developer.ebay.com/my/keys'); });
  $('ebay-access-help').addEventListener('click', (event) => { event.preventDefault(); openUrl('https://developer.ebay.com/api-docs/buy/static/buy-requirements.html'); });
  $('set-tradera-btn').addEventListener('click', openTraderaSettings);
  $('tradera-cancel').addEventListener('click', closeTraderaSettings);
  $('tradera-save').addEventListener('click', () => saveTraderaSetup(false));
  $('tradera-test-btn').addEventListener('click', () => saveTraderaSetup(true));
  $('tradera-register-help').addEventListener('click', (event) => { event.preventDefault(); openUrl('https://api.tradera.com/'); });
  $('tradera-api-help').addEventListener('click', (event) => { event.preventDefault(); openUrl('https://api.tradera.com/documentation/rest-getting-started'); });

  // ☁ Cloud setup wizard
  $('set-cloud-btn').addEventListener('click', openCloud);
  $('cloud-cancel').addEventListener('click', closeCloud);
  $('cloud-run').addEventListener('click', runCloudSetup);
  $('cloud-open-btn').addEventListener('click', () => { const u = $('cloud-open-btn').dataset.url; if (u) openUrl(u); });
  $('cloud-github-help').addEventListener('click', (e) => { e.preventDefault(); openUrl('https://github.com/settings/tokens/new?scopes=repo,workflow&description=Discogs%20Deal%20Watcher%20cloud'); });
  $('cloud-resend-help').addEventListener('click', (e) => { e.preventDefault(); openUrl('https://resend.com/api-keys'); });
  if (hasApi) window.api.onCloudProgress(onCloudProgress);

  // ✈ Telegram push setup
  $('btn-telegram').addEventListener('click', openTelegram);
  $('tg-cancel').addEventListener('click', closeTelegram);
  $('tg-test-btn').addEventListener('click', runTelegramTest);
  $('tg-connect').addEventListener('click', runTelegramSetup);
  $('tg-botfather-help').addEventListener('click', (e) => { e.preventDefault(); openUrl('https://t.me/BotFather'); });
  if (hasApi) window.api.onTelegramProgress(onTelegramProgress);

  // Wizard
  $('wiz-test-btn').addEventListener('click', wizardTest);
  $('wiz-save').addEventListener('click', wizardSave);
  $('wiz-cancel').addEventListener('click', closeWizard);
  $('wiz-token-help').addEventListener('click', (e) => { e.preventDefault(); openUrl('https://www.discogs.com/settings/developers'); });

  $('search').addEventListener('input', render);
  $('sortBy').addEventListener('change', onFilterChanged);
  $('freshOnly').addEventListener('change', onFilterChanged);
  $('vgPlusOnly').addEventListener('change', onFilterChanged);
  $('showHidden').addEventListener('change', onFilterChanged);
  $('showNearMiss').addEventListener('change', onFilterChanged);
  $('minValue').addEventListener('input', onFilterChanged);
  $('minDiscount').addEventListener('input', onFilterChanged);
  $('maxTotal').addEventListener('input', onFilterChanged);
  $('shipEst').addEventListener('input', onFilterChanged);

  if (hasApi) window.api.onScrapeProgress(onScanProgress);
  if (hasApi && window.api.onScanAllUpdate) window.api.onScanAllUpdate(onAllScanUpdate);
  if (hasApi && window.api.onVintedUpdate) window.api.onVintedUpdate((message) => applyVintedSnapshot(message, { notify: true }));
  if (hasApi && window.api.onEbayUpdate) window.api.onEbayUpdate((message) => applyEbaySnapshot(message, { notify: true }));
  if (hasApi && window.api.onTraderaUpdate) window.api.onTraderaUpdate((message) => applyTraderaSnapshot(message, { notify: true }));
  if (hasApi) window.api.onScoutProgress(onScoutProgress);
  if (hasApi && window.api.onCityDigProgress) window.api.onCityDigProgress(onCityDigProgress);
  if (hasApi && window.api.onVerifyProgress) window.api.onVerifyProgress((m) => {
    verifyInfo = { running: m.phase === 'verifying', done: m.done || 0, total: m.total || 0 };
    if (activeTab === 'deals' && viewMode !== 'scan') render(); // updates the "checking listings n/m" note
  });
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();

  // Static browser preview hook used by visual QA; the desktop app never has this hash.
  if (!hasApi && location.hash === '#scout') { scoutData = normalizeScoutData(DEMO_SCOUT); setTab('scout'); }
  if (!hasApi && location.hash === '#city') { cityDigData = normalizeCityDigData(DEMO_CITY_DIG); setTab('city'); }

  boot();                         // first-run wizard, last scan, or cloud poll — and lights up the badge
  refreshGems();                  // fill the 💎 Rare tab (works in every source mode; demo in preview)
  if (hasApi) {
    setInterval(refresh, 30_000); // poll the cloud every 30s (paused during a local scan)
    setInterval(refreshGems, 60_000); // 💎 gems change rarely; a slower poll is plenty (raw CDN / local file)
    // Check the real service heartbeat every 2 min. Slow on purpose: the cron only fires every
    // ~15 min, and this is the only api.github.com traffic (deals come from the raw CDN), so 30
    // req/hr stays well under the 60/hr unauthenticated limit.
    setInterval(refreshHealth, 120_000);
    refreshPushStatus();          // sold-medians push badge (persists a failed push until it succeeds)
    setInterval(refreshPushStatus, 5 * 60_000);
    maybeAutoScan();              // auto-scan on launch if the last scan is stale (keeps emails sharp)
    setInterval(maybeAutoScan, 15 * 60_000); // re-check every 15 min so the configured cadence (e.g. hourly) is actually honored while the app stays open
  }
});

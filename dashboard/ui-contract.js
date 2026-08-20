'use strict';

/* Static contract between index.html and renderer.js.
 * The dashboard deliberately hides advanced controls in a drawer, but none of their functionality
 * may disappear. This test catches a removed/renamed/duplicated element before the app is packaged.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const renderer = fs.readFileSync(path.join(__dirname, 'renderer.js'), 'utf8');
const preload = fs.readFileSync(path.join(__dirname, 'preload.js'), 'utf8');
const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const ids = Array.from(html.matchAll(/\bid="([^"]+)"/g), (m) => m[1]);
const idCounts = ids.reduce((map, id) => map.set(id, (map.get(id) || 0) + 1), new Map());
const rendererRefs = new Set(Array.from(renderer.matchAll(/\$\('([^']+)'\)/g), (m) => m[1]));

for (const id of rendererRefs) assert.strictEqual(idCounts.get(id), 1, `renderer element #${id} must exist exactly once`);
for (const [id, count] of idCounts) assert.strictEqual(count, 1, `HTML id #${id} is duplicated`);

const preserved = [
  'tab-deals', 'tab-gems', 'tab-scout', 'tab-city', 'btn-scan-all', 'btn-fullscan', 'btn-scan-cancel', 'btn-settings', 'btn-telegram',
  'scan-all-status', 'scan-all-discogs', 'scan-all-vinted', 'scan-all-ebay', 'scan-all-tradera',
  'svc-badge', 'pill-sweep', 'pill-cron', 'push-badge', 'pill-wantlist', 'pill-deals',
  'search', 'sort-control', 'minValue', 'minDiscount', 'maxTotal', 'shipEst', 'sortBy', 'vgPlusOnly',
  'freshOnly', 'showHidden', 'showNearMiss', 'settings-modal', 'cloud-modal', 'telegram-modal',
  'wizard-modal', 'scout-panel', 'scout-form', 'scout-field', 'scout-query', 'scout-min-value',
  'scout-limit', 'scout-run', 'scout-cancel', 'deals', 'empty',
  'city-panel', 'city-world-map', 'city-local-map', 'city-directory-copy', 'city-stores', 'city-taxonomies', 'city-limit', 'city-sort',
  'city-run', 'city-cancel', 'city-refresh-counts',
  'platform-select', 'platform-context-label', 'vinted-panel', 'vinted-enabled', 'vinted-scan-now',
  'vinted-backfill', 'vinted-backfill-progress', 'vinted-poll-interval', 'vinted-health', 'vinted-health-label', 'vinted-last-scan', 'vinted-next-scan', 'vinted-status-message',
  'ebay-panel', 'ebay-enabled', 'ebay-scan-now', 'ebay-configure', 'ebay-poll-interval', 'ebay-health', 'ebay-health-label',
  'ebay-last-scan', 'ebay-next-scan', 'ebay-api-calls', 'ebay-status-message', 'ebay-modal', 'ebay-client-id', 'ebay-client-secret',
  'ebay-environment', 'ebay-marketplace', 'ebay-country', 'ebay-postal-code', 'ebay-test-btn', 'ebay-save', 'ebay-cancel',
  'tradera-panel', 'tradera-enabled', 'tradera-scan-now', 'tradera-configure', 'tradera-poll-interval', 'tradera-health',
  'tradera-health-label', 'tradera-last-scan', 'tradera-next-scan', 'tradera-api-calls', 'tradera-status-message',
  'tradera-modal', 'tradera-app-id', 'tradera-app-key', 'tradera-test-btn', 'tradera-save', 'tradera-cancel', 'set-tradera-btn',
];
for (const id of preserved) assert.strictEqual(idCounts.get(id), 1, `preserved feature #${id} missing`);

assert.ok(/id="filter-panel"[^>]*class="[^"]*hidden/.test(html), 'advanced filters start collapsed');
assert.strictEqual((html.match(/class="filter-preset"/g) || []).length, 3, 'dashboard exposes three understandable filter presets');
assert.ok(/strict eligibility boundary used by email or desktop alerts/.test(html), 'filter drawer makes the strict alert boundary explicit');
assert.ok(/id="sort-control"/.test(html) && /Lowest checkout price/.test(html), 'sorting stays visible and uses plain-language options');
assert.ok(/FILTER_STATE_KEY = 'ddw-filter-state-v3'/.test(renderer) && /minValue: '10', minDiscount: '25'/.test(renderer), 'new balanced dashboard defaults are versioned');
assert.ok(/marketplaceDashboardRows\(next\.deals, next\.matches\)/.test(renderer) && /dashboard match · no alert/.test(renderer), 'official marketplace dashboard matches are visibly separate from alert deals');
assert.ok(/id="tab-deals"/.test(html) && /id="tab-gems"/.test(html) && /id="tab-scout"/.test(html) && /id="tab-city"/.test(html), 'Deals, Rare gems, Scout and City Dig remain primary tabs');
assert.ok(/id="platform-select"/.test(html) && /value="discogs"/.test(html) && /value="vinted"/.test(html) && /value="ebay"/.test(html) && /value="tradera"/.test(html), 'marketplace switch offers Discogs, Vinted, eBay and Tradera');
const styles = fs.readFileSync(path.join(__dirname, 'styles.css'), 'utf8');
assert.ok(/body\.platform-vinted #tab-scout, body\.platform-vinted #tab-city/.test(styles), 'Discogs-only Scout and City Dig are hidden on Vinted');
assert.ok(/body\.platform-ebay #tab-scout, body\.platform-ebay #tab-city/.test(styles), 'Discogs-only Scout and City Dig are hidden on eBay');
assert.ok(/body\.platform-tradera #tab-scout, body\.platform-tradera #tab-city/.test(styles), 'Discogs-only Scout and City Dig are hidden on Tradera');
for (const channel of ['vinted:snapshot', 'vinted:setEnabled', 'vinted:configure', 'vinted:scanNow', 'vinted:startBackfill', 'vinted:cancelBackfill']) {
  assert.ok(preload.includes(channel) && main.includes(channel), `Vinted IPC channel ${channel} is wired end-to-end`);
}
for (const channel of ['ebay:credentialsStatus', 'ebay:saveCredentials', 'ebay:test', 'ebay:snapshot', 'ebay:setEnabled', 'ebay:configure', 'ebay:scanNow']) {
  assert.ok(preload.includes(channel) && main.includes(channel), `eBay IPC channel ${channel} is wired end-to-end`);
}
for (const channel of ['tradera:credentialsStatus', 'tradera:saveCredentials', 'tradera:test', 'tradera:snapshot', 'tradera:setEnabled', 'tradera:configure', 'tradera:scanNow']) {
  assert.ok(preload.includes(channel) && main.includes(channel), `Tradera IPC channel ${channel} is wired end-to-end`);
}
for (const channel of ['scan:all', 'scan-all:update']) {
  assert.ok(preload.includes(channel) && main.includes(channel), `Unified scan IPC channel ${channel} is wired end-to-end`);
}
assert.ok(/function startAllScans\(/.test(renderer) && /window\.api\.scanAll\(\)/.test(renderer), 'renderer exposes one coordinated scan action');
assert.ok(/activePlatform === 'vinted'/.test(renderer) && /activePlatform === 'ebay'/.test(renderer) && /activePlatform === 'tradera'/.test(renderer) && /setPlatform\(activePlatform\)/.test(renderer), 'renderer keeps first-class Vinted, eBay and Tradera platform state');
assert.ok(/safeStorage\.encryptString/.test(main) && !/clientSecret: credentials\.clientSecret/.test(preload), 'eBay Cert ID stays in encrypted main-process storage');
assert.ok(/TRADERA_CREDENTIALS_FILE/.test(main) && /safeStorage\.encryptString/.test(main) && !/appKey: credentials\.appKey/.test(preload), 'Tradera App Key stays in encrypted main-process storage');
assert.ok(/Content-Security-Policy/.test(html), 'renderer CSP remains present');
assert.ok(/node_modules\/leaflet\/dist\/leaflet\.js/.test(html), 'interactive map engine is bundled locally');

console.log(`ui-contract selftest: ${rendererRefs.size} renderer bindings and ${preserved.length} preserved features passed`);

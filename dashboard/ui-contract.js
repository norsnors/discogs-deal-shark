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
const ids = Array.from(html.matchAll(/\bid="([^"]+)"/g), (m) => m[1]);
const idCounts = ids.reduce((map, id) => map.set(id, (map.get(id) || 0) + 1), new Map());
const rendererRefs = new Set(Array.from(renderer.matchAll(/\$\('([^']+)'\)/g), (m) => m[1]));

for (const id of rendererRefs) assert.strictEqual(idCounts.get(id), 1, `renderer element #${id} must exist exactly once`);
for (const [id, count] of idCounts) assert.strictEqual(count, 1, `HTML id #${id} is duplicated`);

const preserved = [
  'tab-deals', 'tab-gems', 'tab-scout', 'tab-city', 'btn-fullscan', 'btn-scan-cancel', 'btn-settings', 'btn-telegram',
  'svc-badge', 'pill-sweep', 'pill-cron', 'push-badge', 'pill-wantlist', 'pill-deals',
  'search', 'minValue', 'minDiscount', 'maxTotal', 'shipEst', 'sortBy', 'vgPlusOnly',
  'freshOnly', 'showHidden', 'showNearMiss', 'settings-modal', 'cloud-modal', 'telegram-modal',
  'wizard-modal', 'scout-panel', 'scout-form', 'scout-field', 'scout-query', 'scout-min-value',
  'scout-limit', 'scout-run', 'scout-cancel', 'deals', 'empty',
  'city-panel', 'city-world-map', 'city-local-map', 'city-stores', 'city-taxonomies', 'city-limit', 'city-sort',
  'city-run', 'city-cancel', 'city-refresh-counts',
];
for (const id of preserved) assert.strictEqual(idCounts.get(id), 1, `preserved feature #${id} missing`);

assert.ok(/id="filter-panel"[^>]*class="[^"]*hidden/.test(html), 'advanced filters start collapsed');
assert.ok(/id="tab-deals"/.test(html) && /id="tab-gems"/.test(html) && /id="tab-scout"/.test(html) && /id="tab-city"/.test(html), 'Deals, Rare gems, Scout and City Dig remain primary tabs');
assert.ok(/Content-Security-Policy/.test(html), 'renderer CSP remains present');
assert.ok(/node_modules\/leaflet\/dist\/leaflet\.js/.test(html), 'interactive map engine is bundled locally');

console.log(`ui-contract selftest: ${rendererRefs.size} renderer bindings and ${preserved.length} preserved features passed`);

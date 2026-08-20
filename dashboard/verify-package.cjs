'use strict';

const fs = require('fs');
const path = require('path');
const asar = require('@electron/asar');

const [asarPath, watcherDir] = process.argv.slice(2);

if (!asarPath) {
  throw new Error('Usage: node verify-package.cjs <app.asar> [watcher-resource-directory]');
}
if (!fs.statSync(asarPath, { throwIfNoEntry: false })?.isFile()) {
  throw new Error(`Packaged app archive not found: ${asarPath}`);
}

const packagedFiles = new Set(asar.listPackage(asarPath).map((file) => file.replaceAll('\\', '/')));
const requiredAppFiles = [
  '/main.js',
  '/all-scan.js',
  '/scan-policy.js',
  '/scout-policy.js',
  '/city-dig-policy.js',
  '/city-dig-data.js',
  '/vinted/policy.js',
  '/vinted/client.js',
  '/vinted/state.js',
  '/vinted/service.js',
  '/ebay/client.js',
  '/ebay/state.js',
  '/ebay/service.js',
  '/tradera/client.js',
  '/tradera/fx.js',
  '/tradera/state.js',
  '/tradera/service.js',
  '/node_modules/leaflet/dist/leaflet.css',
  '/node_modules/leaflet/dist/leaflet.js',
  '/git-policy.js',
  '/runtime-policy.js',
  '/listing-history.js',
  '/median-publisher.js',
  '/preload.js',
  '/renderer.js',
  '/index.html',
  '/styles.css',
  '/assets/icon.png',
  '/assets/thumbnail.png'
];

for (const file of requiredAppFiles) {
  if (!packagedFiles.has(file)) throw new Error(`Missing from app.asar: ${file}`);
}

if (watcherDir) {
  const requiredWatcherFiles = [
    'engine.js',
    'discogs.js',
    'store.js',
    'mailer.js',
    'telegram.js',
    'delivery.js',
    'server.js',
    'watcher.js',
    path.join('node_modules', 'nodemailer', 'package.json')
  ];
  for (const file of requiredWatcherFiles) {
    const absolute = path.join(watcherDir, file);
    if (!fs.statSync(absolute, { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`Missing packaged watcher resource: ${file}`);
    }
  }
}

console.log(`Packaged resources: OK (${packagedFiles.size} app files checked)`);

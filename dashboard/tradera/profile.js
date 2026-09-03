'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TRADERA_SETTING_KEYS = [
  'traderaEnabled',
  'traderaPollMinutes',
  'traderaBatchSize',
];

function readJson(filePath) {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function uniqueDirectories(directories) {
  return [...new Set((directories || []).filter(Boolean).map((directory) => path.resolve(String(directory))))];
}

function applyTraderaSettingsFallback(current = {}, legacyDirectories = []) {
  const result = current && typeof current === 'object' && !Array.isArray(current) ? { ...current } : {};
  const missingKeys = TRADERA_SETTING_KEYS.filter((key) => !Object.prototype.hasOwnProperty.call(result, key));
  if (!missingKeys.length) return result;

  for (const directory of uniqueDirectories(legacyDirectories)) {
    const legacy = readJson(path.join(directory, 'settings.json'));
    let found = false;
    for (const key of missingKeys) {
      if (Object.prototype.hasOwnProperty.call(legacy, key)) {
        result[key] = legacy[key];
        found = true;
      }
    }
    if (found) break;
  }
  return result;
}

module.exports = {
  TRADERA_SETTING_KEYS,
  applyTraderaSettingsFallback,
};

if (require.main === module && process.argv.includes('--selftest')) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deal-shark-tradera-profile-'));
  const active = path.join(dir, 'active');
  const legacy = path.join(dir, 'legacy');
  fs.mkdirSync(active, { recursive: true });
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(active, 'settings.json'), JSON.stringify({ marktplaatsEnabled: true }));
  fs.writeFileSync(path.join(legacy, 'settings.json'), JSON.stringify({
    traderaEnabled: true,
    traderaPollMinutes: 30,
    traderaBatchSize: 5,
    marktplaatsEnabled: false,
  }));

  const settings = applyTraderaSettingsFallback(readJson(path.join(active, 'settings.json')), [legacy]);
  assert.strictEqual(settings.marktplaatsEnabled, true, 'unrelated active settings remain authoritative');
  assert.strictEqual(settings.traderaEnabled, true, 'missing Tradera settings use the legacy profile');
  const explicit = applyTraderaSettingsFallback({ traderaEnabled: false }, [legacy]);
  assert.strictEqual(explicit.traderaEnabled, false, 'an explicit active setting is never overwritten');
  console.log('tradera profile selftest: OK');
}

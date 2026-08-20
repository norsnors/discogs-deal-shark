'use strict';

const assert = require('assert');

const ECB_DAILY_URL = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml';

function parseEcbRates(xml) {
  const text = String(xml || '');
  const rates = { EUR: 1 };
  for (const match of text.matchAll(/currency=["']([A-Z]{3})["']\s+rate=["']([0-9.]+)["']/g)) {
    const rate = Number(match[2]);
    if (Number.isFinite(rate) && rate > 0) rates[match[1]] = rate;
  }
  const date = (text.match(/time=["'](\d{4}-\d{2}-\d{2})["']/) || [])[1] || null;
  if (!rates.SEK) throw new Error('ECB response did not contain a SEK rate.');
  return { date, rates };
}

function crossRate(rates, from, to) {
  const source = String(from || '').toUpperCase();
  const target = String(to || '').toUpperCase();
  const sourceRate = Number(rates && rates[source]);
  const targetRate = Number(rates && rates[target]);
  if (!(sourceRate > 0) || !(targetRate > 0)) throw new Error(`ECB has no ${source}/${target} conversion rate.`);
  return targetRate / sourceRate;
}

function createEcbFxClient(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('ECB FX client needs fetch.');
  const cacheMs = Math.max(60_000, Number(options.cacheMs) || 12 * 60 * 60 * 1000);
  let cached = null;

  async function getRate(from = 'SEK', to = 'EUR') {
    const source = String(from || 'SEK').toUpperCase();
    const target = String(to || 'EUR').toUpperCase();
    if (source === target) return { rate: 1, date: new Date().toISOString().slice(0, 10), source: 'identity' };
    if (!cached || Date.now() - cached.fetchedAt > cacheMs) {
      const response = await fetchImpl(ECB_DAILY_URL, { headers: { accept: 'application/xml,text/xml' } });
      if (!response.ok) throw new Error(`ECB exchange-rate feed returned HTTP ${response.status}.`);
      cached = { ...parseEcbRates(await response.text()), fetchedAt: Date.now() };
    }
    return { rate: crossRate(cached.rates, source, target), date: cached.date, source: 'ecb-daily' };
  }

  return { getRate };
}

module.exports = { ECB_DAILY_URL, parseEcbRates, crossRate, createEcbFxClient };

if (require.main === module && process.argv.includes('--selftest')) {
  const xml = `<Cube><Cube time='2026-08-20'><Cube currency='USD' rate='1.1700'/><Cube currency='SEK' rate='11.2000'/></Cube></Cube>`;
  const parsed = parseEcbRates(xml);
  assert.strictEqual(parsed.date, '2026-08-20');
  assert.strictEqual(crossRate(parsed.rates, 'SEK', 'EUR'), 1 / 11.2);
  assert.strictEqual(crossRate(parsed.rates, 'SEK', 'USD'), 1.17 / 11.2);
  (async () => {
    let calls = 0;
    const client = createEcbFxClient({ fetchImpl: async () => { calls += 1; return { ok: true, text: async () => xml }; } });
    assert.ok((await client.getRate('SEK', 'EUR')).rate > 0);
    await client.getRate('SEK', 'USD');
    assert.strictEqual(calls, 1, 'daily rates are cached in memory');
    console.log('tradera fx selftest: OK');
  })().catch((error) => { console.error(error); process.exitCode = 1; });
}

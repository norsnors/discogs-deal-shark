'use strict';

const ALLOWED_CURRENCIES = new Set(['EUR', 'USD', 'GBP']);
const CONDITION_RANK = {
  'Mint (M)': 0,
  'Near Mint (NM or M-)': 1,
  'Very Good Plus (VG+)': 2,
  'Very Good (VG)': 3,
  'Good Plus (G+)': 4,
  'Good (G)': 5,
  'Fair (F)': 6,
  'Poor (P)': 7,
};

function cleanList(values, max = 20) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const clean = String(value || '').trim().replace(/\s+/g, ' ');
    const key = clean.toLowerCase();
    if (!clean || clean.length > 80 || seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
    if (out.length >= max) break;
  }
  return out;
}

function normalizeCityDigOptions(raw = {}, cities = []) {
  const cityId = String(raw.cityId || '').trim();
  const city = cities.find((candidate) => candidate.id === cityId);
  if (!city) throw new Error('Choose an available City Dig city first.');
  // A city load always means every verified seller in that city. Store checkboxes are status
  // indicators, not a way to accidentally omit a shop from the combined inventory.
  const sellerUsernames = city.stores.map((store) => store.sellerUsername).filter(Boolean);
  if (!sellerUsernames.length) throw new Error('Choose at least one store with a verified Discogs inventory.');
  const taxonomies = cleanList(raw.taxonomies, 20);
  const limitPerSeller = 100;
  const requestedCurrency = String(raw.currency || 'EUR').toUpperCase();
  const currency = ALLOWED_CURRENCIES.has(requestedCurrency) ? requestedCurrency : 'EUR';
  return { cityId, sellerUsernames, taxonomies, limitPerSeller, currency };
}

function looksLikeVinyl(format) {
  const value = String(format || '');
  if (/\b(CD|CDr|DVD|Cassette|File|SACD|Blu-ray)\b/i.test(value)) return false;
  return /(Vinyl|\bLP\b|12\"|10\"|7\"|\bFlexi\b|\bShellac\b)/i.test(value);
}

function normalizeInventoryListing(raw = {}, sellerUsername = '') {
  const release = raw.release || {};
  const price = raw.price || {};
  return {
    listingId: Number(raw.id),
    releaseId: Number(release.id),
    sellerUsername: String((raw.seller && raw.seller.username) || sellerUsername || ''),
    artist: release.artist || '',
    title: release.title || release.description || '',
    year: Number(release.year) || null,
    format: release.format || '',
    catno: release.catalog_number || null,
    thumb: release.thumbnail || null,
    price: Number.isFinite(Number(price.value)) ? Number(price.value) : null,
    currency: price.currency || 'EUR',
    condition: raw.condition || null,
    sleeveCondition: raw.sleeve_condition || null,
    posted: raw.posted || null,
    shipsFrom: raw.ships_from || null,
    comments: raw.comments || '',
    allowOffers: !!raw.allow_offers,
  };
}

function matchTaxonomies(meta = {}, requested = []) {
  const genres = Array.isArray(meta.genres) ? meta.genres : [];
  const styles = Array.isArray(meta.styles) ? meta.styles : [];
  const actual = new Map([...genres, ...styles].map((value) => [String(value).toLowerCase(), String(value)]));
  return requested.filter((value) => actual.has(String(value).toLowerCase())).map((value) => actual.get(String(value).toLowerCase()));
}

function cityDigScore(item, requested = []) {
  const matched = new Set((item.matchedTaxonomies || []).map((value) => String(value).toLowerCase()));
  let taxonomyScore = 0;
  requested.forEach((value, index) => { if (matched.has(String(value).toLowerCase())) taxonomyScore += Math.max(1, requested.length - index); });
  const condition = CONDITION_RANK[item.condition] ?? 9;
  const price = Number(item.price);
  return (taxonomyScore * 10000) - (condition * 100) - (Number.isFinite(price) ? Math.min(99, price) : 99);
}

function sortCityDigResults(items, mode = 'match', requested = []) {
  const out = (Array.isArray(items) ? items : []).slice();
  if (mode === 'price') out.sort((a, b) => (Number(a.price) || 1e9) - (Number(b.price) || 1e9));
  else if (mode === 'newest') out.sort((a, b) => String(b.posted || '').localeCompare(String(a.posted || '')));
  else if (mode === 'condition') out.sort((a, b) => (CONDITION_RANK[a.condition] ?? 9) - (CONDITION_RANK[b.condition] ?? 9));
  else out.sort((a, b) => cityDigScore(b, requested) - cityDigScore(a, requested));
  return out;
}

module.exports = {
  normalizeCityDigOptions,
  looksLikeVinyl,
  normalizeInventoryListing,
  matchTaxonomies,
  cityDigScore,
  sortCityDigResults,
};

if (require.main === module && process.argv.includes('--selftest')) {
  const assert = require('assert');
  const { CITY_DIG_CITIES } = require('./city-dig-data');
  const cities = [{ id: 'antwerp', stores: [{ sellerUsername: 'wgwstore' }, { sellerUsername: null }] }];
  assert.deepStrictEqual(normalizeCityDigOptions({ cityId: 'antwerp', sellerUsernames: [], taxonomies: [' Italo-Disco ', 'italo-disco'], limitPerSeller: 25 }, cities), {
    cityId: 'antwerp', sellerUsernames: ['wgwstore'], taxonomies: ['Italo-Disco'], limitPerSeller: 100, currency: 'EUR',
  });
  assert.deepStrictEqual(normalizeCityDigOptions({ cityId: 'antwerp', taxonomies: [] }, cities).taxonomies, []);
  assert.ok(looksLikeVinyl('12\", Single'));
  assert.ok(!looksLikeVinyl('CD, Album'));
  const listing = normalizeInventoryListing({ id: 4, price: { value: 12, currency: 'EUR' }, release: { id: 8, artist: 'Koto', title: 'Visitors', format: '12\"' } }, 'wgwstore');
  assert.strictEqual(listing.releaseId, 8);
  assert.deepStrictEqual(matchTaxonomies({ genres: ['Electronic'], styles: ['Italo-Disco'] }, ['Disco', 'Italo-Disco']), ['Italo-Disco']);
  assert.strictEqual(sortCityDigResults([{ price: 20 }, { price: 3 }], 'price')[0].price, 3);
  const antwerp = CITY_DIG_CITIES.find((city) => city.id === 'antwerp');
  assert.ok(antwerp && antwerp.stores.length >= 21, 'Antwerp physical-store guide stays complete');
  assert.strictEqual(new Set(antwerp.stores.map((store) => store.id)).size, antwerp.stores.length, 'Antwerp store ids are unique');
  assert.deepStrictEqual(antwerp.stores.filter((store) => store.sellerUsername).map((store) => store.sellerUsername), ['wgwstore', 'Tune-Up-Records', 'Backtrack-Antwerp', 'warrecordsantwerp', 'KalkmanVinylRecords', 'Morbus_Gravis', 'Sound_Architecture']);
  for (const store of antwerp.stores) {
    assert.ok(store.name && store.address && Number.isFinite(store.lat) && Number.isFinite(store.lon), `${store.id} has map data`);
    assert.ok(store.channel, `${store.id} has an explicit online-channel status`);
  }
  console.log('city-dig-policy selftest: all assertions passed');
}

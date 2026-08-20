'use strict';

// Pure Vinted matching and deal policy. Keep this module free of Electron, fs and network
// dependencies so the same rules can be tested in isolation and used by the main process.

const DEFAULT_CATEGORY_ID = 3041;
const DEFAULT_MIN_DISCOUNT = 0.5;

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseMoney(value) {
  if (value == null) return null;
  if (typeof value === 'object') return parseMoney(value.amount ?? value.value ?? value.price);
  let text = String(value).trim().replace(/[^0-9,.-]/g, '');
  if (!text) return null;
  const comma = text.lastIndexOf(',');
  const dot = text.lastIndexOf('.');
  if (comma >= 0 && dot >= 0) {
    const decimal = comma > dot ? ',' : '.';
    text = text.replace(decimal === ',' ? /\./g : /,/g, '').replace(decimal, '.');
  } else if (comma >= 0) {
    const decimals = text.length - comma - 1;
    text = decimals > 0 && decimals <= 2 ? text.replace(/\./g, '').replace(',', '.') : text.replace(/,/g, '');
  } else if (dot >= 0 && /^-?\d{1,3}(?:\.\d{3})+$/.test(text)) {
    text = text.replace(/\./g, '');
  }
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const NOISE_TOKENS = new Set([
  'a', 'an', 'and', 'the', 'of', 'on', 'for',
  'vinyl', 'record', 'records', 'lp', 'ep', 'single', 'album', '12', 'inch',
  'reissue', 'remastered', 'promo', 'promotional', 'white', 'label',
]);

const REISSUE_TERMS = [
  'reissue', 're issue', 'repress', 're press', 'remaster', 'remastered', 'remasterizado',
  'reedition', 're edition', 'heruitgave', 'nachpressung', 'ristampa', 'reimpression',
  'replica', 'bootleg', 'unofficial', 'counterfeit', 'not original',
];
const ORIGINAL_TERMS = ['original pressing', 'original press', 'first pressing', 'first press', '1st press', 'eerste persing', 'prima stampa'];
const COLOR_TERMS = ['transparent', 'translucent', 'clear vinyl', 'blue vinyl', 'red vinyl', 'green vinyl', 'yellow vinyl', 'orange vinyl', 'purple vinyl', 'pink vinyl', 'white vinyl', 'marbled', 'splatter', 'coloured vinyl', 'colored vinyl'];
const COMPILATION_TERMS = [
  'compilation', 'compilatie', 'verzamelalbum', 'verzamel lp', 'various artists',
  'various artist', 'various', 'v a', 'vv aa', 'sampler', 'collection of hits', 'hit collection',
];
const LEADING_LISTING_TOKENS = new Set([
  'vinyl', 'vinile', 'record', 'records', 'plaat', 'lp', 'ep', 'album', 'single',
  'maxi', 'disco', 'disc', '7', '10', '12', 'inch', 'rpm', 'giri', 'original',
  'first', 'pressing', 'press', 'rare', 'vintage', 'sealed', 'sigillato', 'new',
  'nuovo', 'italo', 'synth', 'pop',
]);

function meaningfulTokens(value) {
  return normalizeText(value).split(' ').filter((token) => token && !NOISE_TOKENS.has(token));
}

function splitArtistTitle(value) {
  const text = String(value || '').trim();
  const match = text.match(/^(.+?)\s+[–—-]\s+(.+)$/);
  if (!match) return { artist: '', title: text };
  return { artist: match[1].trim(), title: match[2].trim() };
}

function normalizeWant(want = {}) {
  const parsed = splitArtistTitle(want.title || want.releaseTitle || want.name || '');
  const artist = String(want.artist || parsed.artist || '').trim();
  const title = String(want.release_title || want.releaseTitle || (parsed.artist ? parsed.title : want.title || want.name || '')).trim();
  const releaseId = want.releaseId ?? want.wantId ?? want.id ?? null;
  return {
    releaseId: releaseId == null ? null : Number(releaseId) || String(releaseId),
    wantId: want.wantId == null ? null : Number(want.wantId) || String(want.wantId),
    artist,
    title,
    artistNorm: normalizeText(artist),
    titleNorm: normalizeText(title),
    artistTokens: meaningfulTokens(artist),
    titleTokens: meaningfulTokens(title),
    key: `${normalizeText(artist)}::${normalizeText(title)}`,
    year: finiteNumber(want.year),
    thumb: want.thumb || null,
  };
}

function amountFrom(value) {
  return parseMoney(value && typeof value === 'object' ? (value.amount ?? value.value) : value);
}

function normalizeCatalogItem(raw = {}) {
  const id = raw.id ?? raw.item_id ?? raw.itemId ?? raw.itemIdStr ?? null;
  const rawTitle = raw.title || raw.name || raw.item_title || '';
  const parsed = splitArtistTitle(rawTitle);
  const price = amountFrom(raw.price ?? raw.item_price);
  const serviceFee = amountFrom(raw.service_fee ?? raw.serviceFee ?? raw.buyer_protection_fee);
  const totalItemPrice = amountFrom(raw.total_item_price ?? raw.totalItemPrice ?? raw.total_price);
  const currency = (raw.currency_code || raw.currency || raw.price?.currency_code || raw.price?.currency || raw.total_item_price?.currency_code || raw.service_fee?.currency_code || 'EUR').toString().toUpperCase();
  const photo = raw.photo || (Array.isArray(raw.photos) && raw.photos[0]) || null;
  const photoUrl = typeof photo === 'string' ? photo : photo && (photo.url || photo.full_size_url || photo.fullSizeUrl || photo.thumbnail_url);
  const seller = raw.user || raw.seller || {};
  const createdAt = raw.created_at_ts || raw.created_at || raw.createdAt || null;
  const itemId = id == null ? null : String(id);
  const safeFallback = itemId && /^\d+$/.test(itemId) ? `https://www.vinted.nl/items/${itemId}` : null;
  const candidateUrl = raw.url || raw.item_url || safeFallback;
  const url = candidateUrl ? (() => {
    try {
      const parsedUrl = new URL(String(candidateUrl), 'https://www.vinted.nl');
      const pathId = parsedUrl.pathname.match(/^\/items\/(\d+)(?:-|\/|$)/);
      return parsedUrl.origin === 'https://www.vinted.nl' && pathId && (!itemId || pathId[1] === itemId)
        ? parsedUrl.href : safeFallback;
    } catch { return safeFallback; }
  })() : null;
  return {
    itemId,
    id: itemId,
    title: rawTitle,
    artist: raw.artist || raw.brand_title || parsed.artist || '',
    parsedTitle: raw.release_title || parsed.title || rawTitle,
    price,
    serviceFee,
    totalItemPrice,
    currency,
    seller: typeof seller === 'string' ? seller : (seller.login || seller.username || seller.id || null),
    photoUrl: photoUrl || null,
    url,
    createdAt,
    updatedAt: raw.updated_at_ts || raw.updated_at || raw.updatedAt || null,
    status: raw.status || raw.status_id || null,
    catalogId: raw.catalog_id ?? raw.catalogId ?? DEFAULT_CATEGORY_ID,
    rawTitle,
  };
}

function tokenCoverage(needles, haystack) {
  const wanted = Array.isArray(needles) ? needles : [];
  const available = new Set(Array.isArray(haystack) ? haystack : []);
  if (!wanted.length) return 0;
  return wanted.filter((token) => available.has(token)).length / wanted.length;
}

function targetIndexKey(target) {
  if (!target) return null;
  return target.key || `${normalizeText(target.artist)}::${normalizeText(target.title)}`;
}

function medianFor(medians, releaseId) {
  if (!medians || releaseId == null) return null;
  const value = medians[releaseId] ?? medians[String(releaseId)];
  if (value && typeof value === 'object') return finiteNumber(value.median ?? value.value ?? value.reference);
  return finiteNumber(value);
}

function buildWantIndex(wantlist, medians = {}) {
  const normalized = (Array.isArray(wantlist) ? wantlist : [])
    .map((want) => normalizeWant(want))
    .filter((target) => target.artist || target.title)
    .map((target) => ({ ...target, median: medianFor(medians, target.releaseId) }));
  // Artist/title remains the cheap first-stage lookup, but pressing-specific releases and medians
  // stay separate. The pressing guard resolves one of these only after reading version evidence.
  const groups = new Map();
  for (const target of normalized) {
    const key = targetIndexKey(target);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(target);
  }
  const targets = Array.from(groups.values()).map((pressings) => {
    const representative = pressings[0];
    const values = pressings.map((target) => target.median).filter((value) => value > 0).sort((a, b) => a - b);
    const median = values.length ? values[0] : null; // conservative display fallback; never used without pressing evidence
    return {
      ...representative,
      median,
      releaseIds: pressings.map((target) => target.releaseId).filter((id) => id != null),
      pressingCount: pressings.length,
      pressings,
    };
  });
  const byToken = new Map();
  for (const target of targets) {
    const terms = new Set([...target.artistTokens, ...target.titleTokens]);
    for (const token of terms) {
      if (!byToken.has(token)) byToken.set(token, []);
      byToken.get(token).push(target);
    }
  }
  return { targets, byToken, categoryId: DEFAULT_CATEGORY_ID, builtAt: Date.now() };
}

function includesTerm(text, terms) {
  const padded = ` ${normalizeText(text)} `;
  return terms.some((term) => padded.includes(` ${normalizeText(term)} `));
}

function includesCatalogNumber(normalizedText, value) {
  const wanted = normalizeText(value).replace(/\s+/g, '');
  if (wanted.length < 4) return false;
  const tokens = normalizeText(normalizedText).split(' ').filter(Boolean);
  // Compare complete consecutive tokens, both spaced and compacted. This accepts LMB 025,
  // LMB-025 and LMB025, but never treats ABC 12 as a prefix match for ABC 123.
  for (let start = 0; start < tokens.length; start++) {
    let candidate = '';
    for (let end = start; end < Math.min(tokens.length, start + 4); end++) {
      candidate += tokens[end];
      if (candidate === wanted) return true;
      if (candidate.length >= wanted.length) break;
    }
  }
  return false;
}

function extractVinylSizes(value) {
  const text = String(value || '').toLowerCase();
  const sizes = new Set();
  for (const match of text.matchAll(/(?:^|[^0-9])(7|10|12)\s*(?:["”″]|'{2}|inch(?:es)?\b)/g)) sizes.add(Number(match[1]));
  return Array.from(sizes).sort((a, b) => a - b);
}

function hasPrimaryReleaseAnchor(rawTitle, target) {
  const tokens = normalizeText(rawTitle).split(' ').filter(Boolean);
  while (tokens.length && (LEADING_LISTING_TOKENS.has(tokens[0]) || /^(?:19|20)\d{2}$/.test(tokens[0]))) tokens.shift();
  const candidates = [target && target.artistTokens, target && target.titleTokens]
    .filter((candidate) => Array.isArray(candidate) && candidate.length);
  return candidates.some((candidate) => candidate.every((token, index) => tokens[index] === token));
}

function extractPressingSignals(item, detail = {}) {
  const listing = normalizeCatalogItem(item);
  const text = [listing.rawTitle, listing.title, detail.name, detail.description, detail.brand, detail.color, detail.category].filter(Boolean).join(' ');
  const normalized = normalizeText(text);
  const years = [...new Set(Array.from(String(text).matchAll(/\b(19\d{2}|20\d{2})\b/g), (match) => Number(match[1])))];
  const discogsReleaseIds = [...new Set(Array.from(
    String(text).matchAll(/discogs\.com\/release\/(\d+)/gi),
    (match) => String(match[1]),
  ))];
  const colors = COLOR_TERMS.filter((term) => includesTerm(text, [term])).map(normalizeText);
  return {
    normalized,
    compact: normalized.replace(/\s+/g, ''),
    years,
    discogsReleaseIds,
    colors,
    sizes: extractVinylSizes(text),
    reissue: includesTerm(text, REISSUE_TERMS),
    original: includesTerm(text, ORIGINAL_TERMS),
    compilation: includesTerm(text, COMPILATION_TERMS),
  };
}

function releasePressingProfile(pressing, metadata = {}) {
  const descriptions = (Array.isArray(metadata.formats) ? metadata.formats : [])
    .flatMap((format) => Array.isArray(format.descriptions) ? format.descriptions : [])
    .map(String);
  const labels = (Array.isArray(metadata.labels) ? metadata.labels : []).map((label) => ({
    name: String(label && label.name || ''),
    catno: String(label && label.catno || ''),
  }));
  const descriptionText = descriptions.join(' ');
  const formatText = (Array.isArray(metadata.formats) ? metadata.formats : [])
    .flatMap((format) => [format && format.name, ...(Array.isArray(format && format.descriptions) ? format.descriptions : [])])
    .filter(Boolean)
    .join(' ');
  return {
    releaseId: pressing.releaseId,
    year: finiteNumber(metadata.year ?? pressing.year),
    median: finiteNumber(pressing.median),
    descriptions,
    labels,
    isReissue: includesTerm(descriptionText, REISSUE_TERMS),
    isCompilation: includesTerm(`${formatText} ${metadata.title || ''} ${metadata.artist || ''}`, COMPILATION_TERMS),
    sizes: extractVinylSizes(formatText),
    colors: COLOR_TERMS.filter((term) => includesTerm(descriptionText, [term])).map(normalizeText),
  };
}

function resolvePressingMatch(item, match, detail = {}, metadataById = {}, options = {}) {
  const group = match && match.target ? match.target : match;
  if (!group) return { accepted: false, reason: 'no-title-match', evidence: [] };
  const signals = extractPressingSignals(item, detail);
  const pressings = Array.isArray(group.pressings) && group.pressings.length ? group.pressings : [group];
  const decisions = pressings.map((pressing) => {
    const metadata = metadataById[pressing.releaseId] || metadataById[String(pressing.releaseId)] || null;
    if (!metadata) return { pressing, metadata: null, profile: releasePressingProfile(pressing), score: 0, evidence: [], conflicts: ['metadata-unavailable'] };
    const profile = releasePressingProfile(pressing, metadata);
    const evidence = [];
    const conflicts = [];
    let score = 0;
    let catalogMatch = false;
    if (signals.discogsReleaseIds.length) {
      if (signals.discogsReleaseIds.includes(String(profile.releaseId))) {
        score += 12;
        evidence.push(`discogs-release-${profile.releaseId}`);
      } else {
        conflicts.push('discogs-release-conflict');
      }
    }
    if (signals.reissue) {
      if (profile.isReissue) { score += 4; evidence.push('reissue'); }
      else conflicts.push('reissue-conflict');
    }
    if (signals.original) {
      if (!profile.isReissue) { score += 4; evidence.push('original-pressing'); }
      else conflicts.push('original-conflict');
    }
    if (signals.years.length && profile.year && signals.years.includes(profile.year)) { score += 2; evidence.push(`year-${profile.year}`); }
    if (signals.colors.length) {
      const colorMatch = signals.colors.some((color) => profile.colors.includes(color));
      if (colorMatch) { score += 4; evidence.push('vinyl-color'); }
      else conflicts.push('color-conflict');
    }
    if (signals.sizes.length && profile.sizes.length) {
      const sizeMatch = signals.sizes.some((size) => profile.sizes.includes(size));
      // Size is excellent contradiction/disambiguation evidence, but not enough by itself to
      // identify one pressing among multiple 12-inch or 7-inch editions.
      if (sizeMatch) { score += 1; evidence.push(`size-${signals.sizes.find((size) => profile.sizes.includes(size))}-inch`); }
      else conflicts.push('format-size-conflict');
    }
    if (signals.compilation) {
      if (profile.isCompilation) evidence.push('compilation');
      else conflicts.push('compilation-conflict');
    }
    for (const label of profile.labels) {
      if (includesCatalogNumber(signals.normalized, label.catno)) { catalogMatch = true; score += 8; evidence.push(`catno-${label.catno}`); }
      const labelName = normalizeText(label.name);
      if (labelName.length >= 5 && signals.normalized.includes(labelName)) { score += 3; evidence.push(`label-${label.name}`); }
    }
    // Track names and artists are often listed after the actual compilation/album title. Do not
    // treat those as the item being sold. An exact catalogue number remains a safe override for
    // unusually written but concretely identifiable listings.
    if (match && match.target && match.primaryAnchor === false && !catalogMatch) conflicts.push('release-title-not-primary');
    return { pressing, metadata, profile, score, evidence, conflicts };
  });
  if (decisions.every((decision) => !decision.metadata)) {
    return { accepted: false, reason: 'metadata-unavailable', evidence: [], signals: { years: signals.years, discogsReleaseIds: signals.discogsReleaseIds, colors: signals.colors, sizes: signals.sizes, reissue: signals.reissue, original: signals.original, compilation: signals.compilation } };
  }
  // A label name alone is too broad (many labels issued several versions). Four points means an
  // explicit version clue, a matching variant, catalogue number, or a year+label combination.
  const minEvidenceScore = Number.isFinite(Number(options.minEvidenceScore)) ? Number(options.minEvidenceScore) : 4;
  const compatible = decisions.filter((decision) => !decision.conflicts.length && decision.score >= minEvidenceScore);
  compatible.sort((a, b) => b.score - a.score);
  const topScore = compatible.length ? compatible[0].score : null;
  const strongest = compatible.filter((decision) => decision.score === topScore);
  if (strongest.length > 1) {
    return {
      accepted: false,
      reason: 'pressing-ambiguous',
      evidence: [],
      signals: { years: signals.years, discogsReleaseIds: signals.discogsReleaseIds, colors: signals.colors, sizes: signals.sizes, reissue: signals.reissue, original: signals.original, compilation: signals.compilation },
    };
  }
  const best = strongest[0] || null;
  if (!best) {
    const conflict = decisions.flatMap((decision) => decision.conflicts).find((reason) => reason !== 'metadata-unavailable');
    return {
      accepted: false,
      reason: conflict || 'version-unverified',
      evidence: [],
      signals: { years: signals.years, discogsReleaseIds: signals.discogsReleaseIds, colors: signals.colors, sizes: signals.sizes, reissue: signals.reissue, original: signals.original, compilation: signals.compilation },
    };
  }
  if (!(best.profile.median > 0)) return { accepted: false, reason: 'pressing-median-unavailable', evidence: best.evidence };
  const selected = {
    ...group,
    ...best.pressing,
    releaseIds: group.releaseIds || [best.pressing.releaseId],
    pressings,
    median: best.profile.median,
    pressingEvidence: best.evidence,
  };
  return {
    accepted: true,
    reason: null,
    target: selected,
    reference: best.profile.median,
    evidence: best.evidence,
    score: best.score,
    signals: { years: signals.years, discogsReleaseIds: signals.discogsReleaseIds, colors: signals.colors, sizes: signals.sizes, reissue: signals.reissue, original: signals.original, compilation: signals.compilation },
  };
}

function matchOne(item, target) {
  const listing = normalizeCatalogItem(item);
  const listingText = normalizeText(`${listing.artist} ${listing.title} ${listing.rawTitle}`);
  const listingTokens = meaningfulTokens(listingText);
  const artistTokens = target.artistTokens;
  const titleTokens = target.titleTokens;
  const titleScore = titleTokens.length ? tokenCoverage(titleTokens, listingTokens) : 0;
  const artistScore = artistTokens.length ? tokenCoverage(artistTokens, listingTokens) : 0;
  const exactTitle = !!target.titleNorm && (listingText.includes(target.titleNorm) || normalizeText(listing.parsedTitle).includes(target.titleNorm));
  const exactArtist = !artistTokens.length || listingText.includes(target.artistNorm);
  const titlePass = !titleTokens.length || (titleTokens.length === 1 ? titleScore >= 1 : titleScore >= 0.6) || exactTitle;
  const artistPass = !artistTokens.length || artistScore >= (artistTokens.length === 1 ? 1 : 0.5) || exactArtist;
  if (!titlePass || !artistPass) return null;
  const score = Math.round((titleScore * 0.65 + (artistTokens.length ? artistScore : 0.5) * 0.35 + (exactTitle ? 0.1 : 0)) * 1000) / 1000;
  return {
    target,
    targetKey: targetIndexKey(target),
    score,
    titleScore,
    artistScore,
    exactTitle,
    exactArtist,
    primaryAnchor: hasPrimaryReleaseAnchor(listing.rawTitle, target),
  };
}

function matchCatalogItem(item, index) {
  const listing = normalizeCatalogItem(item);
  if (!listing.itemId) return null;
  const targets = index && Array.isArray(index.targets) ? index.targets : (Array.isArray(index) ? index : []);
  if (!targets.length) return null;
  const listingTokens = new Set(meaningfulTokens(`${listing.artist} ${listing.title} ${listing.rawTitle}`));
  const candidates = new Set();
  if (index && index.byToken instanceof Map) {
    for (const token of listingTokens) for (const target of index.byToken.get(token) || []) candidates.add(target);
  }
  const pool = candidates.size ? Array.from(candidates) : targets;
  return pool.map((target) => matchOne(listing, target)).filter(Boolean).sort((a, b) => b.score - a.score)[0] || null;
}

function normalizeMinDiscount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number < 1 ? number : DEFAULT_MIN_DISCOUNT;
}

function evaluateListing(item, match, options = {}) {
  const listing = normalizeCatalogItem(item);
  const target = match && match.target ? match.target : match;
  const reference = finiteNumber(options.reference ?? (target && target.median));
  const minDiscount = normalizeMinDiscount(options.minDiscount);
  const shippingEstimate = Math.max(0, finiteNumber(options.shippingEstimate) ?? 0);
  const itemPrice = listing.price;
  const serviceFee = listing.serviceFee || 0;
  const baseTotal = listing.totalItemPrice != null ? listing.totalItemPrice : (itemPrice == null ? null : itemPrice + serviceFee);
  const total = baseTotal == null ? null : baseTotal + shippingEstimate;
  const threshold = reference > 0 ? reference * (1 - minDiscount) : null;
  const discount = reference > 0 && total != null ? (reference - total) / reference : null;
  const isDeal = reference > 0 && total != null && total <= threshold;
  return {
    isDeal,
    target,
    match: match || null,
    itemId: listing.itemId,
    listing,
    price: itemPrice,
    serviceFee,
    shippingEstimate,
    total,
    reference: reference > 0 ? reference : null,
    referenceSource: reference > 0 ? 'sold-median' : null,
    threshold,
    discount,
    savings: reference > 0 && total != null ? Math.max(0, reference - total) : null,
    currency: listing.currency,
    url: listing.url,
  };
}

function rareGemTransition(previous, current) {
  const previousStatus = typeof previous === 'string' ? previous : previous && previous.status;
  const currentStatus = typeof current === 'string' ? current : current && current.status;
  const appeared = previousStatus === 'zero' && currentStatus === 'available';
  return {
    isRareGem: appeared,
    type: appeared ? 'restock' : null,
    from: previousStatus || 'unknown',
    to: currentStatus || 'unknown',
  };
}

function availabilityStatus(itemOrItems) {
  if (typeof itemOrItems === 'boolean') return itemOrItems ? 'available' : 'zero';
  if (Array.isArray(itemOrItems)) return itemOrItems.length ? 'available' : 'zero';
  return itemOrItems ? 'available' : 'zero';
}

module.exports = {
  DEFAULT_CATEGORY_ID,
  DEFAULT_MIN_DISCOUNT,
  parseMoney,
  normalizeText,
  meaningfulTokens,
  splitArtistTitle,
  normalizeWant,
  normalizeCatalogItem,
  buildWantIndex,
  matchCatalogItem,
  evaluateListing,
  rareGemTransition,
  availabilityStatus,
  targetIndexKey,
  includesCatalogNumber,
  extractPressingSignals,
  releasePressingProfile,
  resolvePressingMatch,
};

if (require.main === module && process.argv.includes('--selftest')) {
  const assert = require('assert');
  assert.strictEqual(parseMoney('€1.234,56'), 1234.56);
  assert.strictEqual(normalizeText('Beyoncé & The Band'), 'beyonce and the band');
  assert.strictEqual(normalizeCatalogItem({ id: 7, title: 'Safe', url: 'https://example.com/phish' }).url, 'https://www.vinted.nl/items/7', 'external listing URLs are never trusted');
  const index = buildWantIndex([{ releaseId: 10, artist: 'Macho', title: 'I’m a Man' }], { 10: { median: 100 } });
  const item = normalizeCatalogItem({ id: 88, title: 'Macho - I’m a Man (12 inch)', price: { amount: '20.00', currency_code: 'EUR' }, service_fee: { amount: '2.00' } });
  const match = matchCatalogItem(item, index);
  assert.ok(match && match.target.releaseId === 10, 'loose artist/title match finds a pressing variant');
  assert.strictEqual(matchCatalogItem({ id: 89, title: 'Macho - I’m a Woman' }, index), null, 'partial title lookalikes do not match');
  const pressings = buildWantIndex([
    { releaseId: 10, artist: 'Macho', title: 'I’m a Man' },
    { releaseId: 11, artist: 'Macho', title: 'I’m a Man' },
    { releaseId: 12, artist: 'Macho', title: 'I’m a Man' },
  ], { 10: { median: 100 }, 11: { median: 40 } });
  assert.strictEqual(pressings.targets.length, 1, 'same title across pressings is one Vinted target');
  assert.strictEqual(pressings.targets[0].median, 40, 'unresolved pressing groups expose only the lowest safe fallback');
  assert.strictEqual(pressings.targets[0].pressings.length, 3, 'each Discogs pressing and its median remain separate');
  const originalMeta = { 10: { year: 1987, formats: [{ name: 'Vinyl', descriptions: ['12"', '45 RPM'] }], labels: [{ name: 'Lombardoni Publishings', catno: 'LMB 025' }] } };
  const airMailIndex = buildWantIndex([{ releaseId: 10, artist: 'Air Mail', title: 'Flash In Your Mind', year: 1987 }], { 10: { median: 440 } });
  const airMailMatch = matchCatalogItem({ id: 90, title: '12" Maxi - Air Mail - Flash In Your Mind Reissue blue Transparent' }, airMailIndex);
  const rejectedReissue = resolvePressingMatch({ id: 90, title: '12" Maxi - Air Mail - Flash In Your Mind Reissue blue Transparent' }, airMailMatch, {}, originalMeta);
  assert.strictEqual(rejectedReissue.accepted, false, 'an explicit colored reissue cannot inherit the original pressing median');
  assert.ok(['reissue-conflict', 'color-conflict'].includes(rejectedReissue.reason));
  const exactOriginal = resolvePressingMatch({ id: 91, title: 'Air Mail - Flash In Your Mind - LMB 025' }, airMailMatch, {}, originalMeta);
  assert.strictEqual(exactOriginal.accepted, true, 'matching catalogue number positively identifies the wanted pressing');
  assert.strictEqual(exactOriginal.reference, 440);
  const wrongSize = resolvePressingMatch({ id: 911, title: '7 inch Air Mail - Flash In Your Mind - original pressing LMB 025' }, airMailMatch, {}, originalMeta);
  assert.deepStrictEqual({ accepted: wrongSize.accepted, reason: wrongSize.reason }, { accepted: false, reason: 'format-size-conflict' }, 'a 7-inch listing cannot inherit the median of a wanted 12-inch release');
  const rightSize = resolvePressingMatch({ id: 912, title: '12 inch Air Mail - Flash In Your Mind - LMB 025' }, airMailMatch, {}, originalMeta);
  assert.strictEqual(rightSize.accepted, true, 'matching 12-inch size and catalogue number identify the wanted release');
  const explicitDiscogsMatch = resolvePressingMatch(
    { id: 9121, title: 'Air Mail - Flash In Your Mind' },
    airMailMatch,
    { description: 'Release details: https://www.discogs.com/release/10-Air-Mail-Flash-In-Your-Mind' },
    originalMeta,
  );
  assert.strictEqual(explicitDiscogsMatch.accepted, true, 'an explicit Discogs release URL identifies that exact wanted pressing');
  const torchSongIndex = buildWantIndex([{ releaseId: 127654, artist: 'Torch Song', title: 'Prepare To Energize', year: 1983 }], { 127654: { median: 8.52 } });
  const torchSongMatch = matchCatalogItem({ id: 643460239, title: 'Torch Song - Prepare To Energize - 12 inch - 1983' }, torchSongIndex);
  const explicitDiscogsConflict = resolvePressingMatch(
    { id: 643460239, title: 'Torch Song - Prepare To Energize - 12 inch - 1983' },
    torchSongMatch,
    { description: 'Holland edition ILSA 12.4113 https://www.discogs.com/release/1596294-Torch-Song-Prepare-To-Energize' },
    { 127654: { year: 1983, formats: [{ name: 'Vinyl', descriptions: ['12"'] }], labels: [{ name: 'IRS Records', catno: 'SP 70412' }] } },
  );
  assert.deepStrictEqual(
    { accepted: explicitDiscogsConflict.accepted, reason: explicitDiscogsConflict.reason },
    { accepted: false, reason: 'discogs-release-conflict' },
    'a listing linked to another Discogs release cannot inherit the wanted release median',
  );
  const compilationFalsePositive = resolvePressingMatch(
    { id: 913, title: 'Various Artists Italo Disco compilation feat. Air Mail - Flash In Your Mind - LMB 025' },
    airMailMatch,
    {},
    originalMeta,
  );
  assert.deepStrictEqual({ accepted: compilationFalsePositive.accepted, reason: compilationFalsePositive.reason }, { accepted: false, reason: 'compilation-conflict' }, 'a compilation containing the wanted track is not the wanted release');
  const compilationIndex = buildWantIndex([{ releaseId: 40, artist: 'Various', title: 'Dance Collection' }], { 40: { median: 30 } });
  const compilationMatch = matchCatalogItem({ id: 914, title: 'Various Artists - Dance Collection compilation - COM 001' }, compilationIndex);
  const wantedCompilation = resolvePressingMatch(
    { id: 914, title: 'Various Artists - Dance Collection compilation - COM 001' },
    compilationMatch,
    {},
    { 40: { title: 'Dance Collection', artist: 'Various', formats: [{ name: 'Vinyl', descriptions: ['LP', 'Compilation'] }], labels: [{ name: 'Comp Records', catno: 'COM 001' }] } },
  );
  assert.strictEqual(wantedCompilation.accepted, true, 'an explicitly wanted compilation remains eligible with concrete release evidence');
  const nemesyIndex = buildWantIndex([{ releaseId: 567449, artist: 'Nemesy', title: 'Nemesy', year: 1985 }], { 567449: { median: 180 } });
  const compilationTitle = 'LP Master One 2 (Boot Legs 1984) Italo disco synth pop Nemesy Between The Sheets Sigillato!';
  const nemesyFalseMatch = matchCatalogItem({ id: 9531896160, title: compilationTitle }, nemesyIndex);
  assert.strictEqual(nemesyFalseMatch.primaryAnchor, false, 'a track mentioned late in another album title is not its primary release');
  const nemesyFalseDecision = resolvePressingMatch(
    { id: 9531896160, title: compilationTitle },
    nemesyFalseMatch,
    { description: 'LP VINILE 33 GIRI VV. AA. - Master One 2. Contiene rari brani di The Creatures, Nemesy, Between The Sheets, The Comsat Angels, Maquillage, Scotch.' },
    { 567449: { title: 'Nemesy', artist: 'Nemesy', year: 1985, formats: [{ name: 'Vinyl', descriptions: ['LP', 'Album'] }], labels: [{ name: 'Bootlegs', catno: 'BTL 84707' }] } },
  );
  assert.deepStrictEqual({ accepted: nemesyFalseDecision.accepted, reason: nemesyFalseDecision.reason }, { accepted: false, reason: 'compilation-conflict' }, 'the concrete Master One 2 compilation cannot inherit the Nemesy album median');
  const nemesyDirectMatch = matchCatalogItem({ id: 915, title: 'LP Nemesy - Nemesy - BTL 84707' }, nemesyIndex);
  const nemesyDirectDecision = resolvePressingMatch(
    { id: 915, title: 'LP Nemesy - Nemesy - BTL 84707' },
    nemesyDirectMatch,
    {},
    { 567449: { title: 'Nemesy', artist: 'Nemesy', year: 1985, formats: [{ name: 'Vinyl', descriptions: ['LP', 'Album'] }], labels: [{ name: 'Bootlegs', catno: 'BTL 84707' }] } },
  );
  assert.strictEqual(nemesyDirectDecision.accepted, true, 'the actual Nemesy album remains eligible');
  const bothVersions = buildWantIndex([
    { releaseId: 10, artist: 'Air Mail', title: 'Flash In Your Mind', year: 1987 },
    { releaseId: 20, artist: 'Air Mail', title: 'Flash In Your Mind', year: 2025 },
  ], { 10: { median: 440 }, 20: { median: 25 } });
  const bothMatch = matchCatalogItem({ id: 95, title: 'Air Mail - Flash In Your Mind - 2025 Reissue' }, bothVersions);
  const selectedReissue = resolvePressingMatch(
    { id: 95, title: 'Air Mail - Flash In Your Mind - 2025 Reissue' },
    bothMatch,
    {},
    {
      ...originalMeta,
      20: { year: 2025, formats: [{ name: 'Vinyl', descriptions: ['12\"', 'Reissue'] }], labels: [{ name: 'Example Reissues', catno: 'RE 025' }] },
    },
  );
  assert.strictEqual(selectedReissue.accepted, true, 'a reissue is valid when that concrete reissue is itself wanted');
  assert.strictEqual(selectedReissue.target.releaseId, 20, 'the reissue never inherits the original release id');
  assert.strictEqual(selectedReissue.reference, 25, 'the reissue is valued against its own sold median');
  const unknownVersion = resolvePressingMatch({ id: 92, title: 'Air Mail - Flash In Your Mind' }, airMailMatch, {}, originalMeta);
  assert.deepStrictEqual({ accepted: unknownVersion.accepted, reason: unknownVersion.reason }, { accepted: false, reason: 'version-unverified' });
  const labelOnly = resolvePressingMatch({ id: 93, title: 'Air Mail - Flash In Your Mind - Lombardoni Publishings' }, airMailMatch, {}, originalMeta);
  assert.deepStrictEqual({ accepted: labelOnly.accepted, reason: labelOnly.reason }, { accepted: false, reason: 'version-unverified' }, 'a broad label name cannot identify a pressing by itself');
  const metadataUnavailable = resolvePressingMatch({ id: 94, title: 'Air Mail - Flash In Your Mind - LMB 025' }, airMailMatch, {}, {});
  assert.strictEqual(metadataUnavailable.reason, 'metadata-unavailable', 'missing Discogs metadata is distinct from an ambiguous listing');
  assert.strictEqual(includesCatalogNumber('air mail abc 123', 'ABC 12'), false, 'catalogue numbers do not prefix-match longer numbers');
  assert.strictEqual(includesCatalogNumber('air mail lmb025', 'LMB 025'), true, 'compact catalogue-number spelling still matches');
  const ambiguousIndex = buildWantIndex([
    { releaseId: 30, artist: 'Example', title: 'Shared Blue' },
    { releaseId: 31, artist: 'Example', title: 'Shared Blue' },
  ], { 30: { median: 100 }, 31: { median: 10 } });
  const ambiguousMatch = matchCatalogItem({ id: 96, title: 'Example - Shared Blue - Blue vinyl' }, ambiguousIndex);
  const ambiguousDecision = resolvePressingMatch(
    { id: 96, title: 'Example - Shared Blue - Blue vinyl' },
    ambiguousMatch,
    {},
    {
      30: { formats: [{ name: 'Vinyl', descriptions: ['Blue vinyl'] }], labels: [] },
      31: { formats: [{ name: 'Vinyl', descriptions: ['Blue vinyl'] }], labels: [] },
    },
  );
  assert.deepStrictEqual({ accepted: ambiguousDecision.accepted, reason: ambiguousDecision.reason }, { accepted: false, reason: 'pressing-ambiguous' }, 'equal evidence across pressings is rejected instead of picking a median');
  const deal = evaluateListing(item, match, { minDiscount: 0.5, shippingEstimate: 5 });
  assert.ok(deal.isDeal && deal.total === 27, 'price plus fee and shipping is compared with the median');
  assert.deepStrictEqual(rareGemTransition({ status: 'zero' }, { status: 'available' }).isRareGem, true);
  assert.strictEqual(rareGemTransition({ status: 'available' }, { status: 'available' }).isRareGem, false);
  console.log('vinted/policy selftest: all assertions passed');
}

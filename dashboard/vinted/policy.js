'use strict';

// Pure Vinted matching and deal policy. Keep this module free of Electron, fs and network
// dependencies so the same rules can be tested in isolation and used by the main process.

const DEFAULT_CATEGORY_ID = 3041;
const DEFAULT_MIN_DISCOUNT = 0.5;
const DEFAULT_GOOD_PRICE_DISCOUNT = 0.15;
const DEFAULT_DISCOGS_SELLER_FEE_RATE = 0.09;

const CONDITION_GRADE_KEYS = Object.freeze({
  'Mint (M)': 'Mint (M)',
  'Near Mint (NM or M-)': 'Near Mint (NM or M-)',
  'Very Good Plus (VG+)': 'Very Good Plus (VG+)',
  'Very Good (VG)': 'Very Good (VG)',
  'Good Plus (G+)': 'Good Plus (G+)',
  'Good (G)': 'Good (G)',
  'Fair (F)': 'Fair (F)',
  'Poor (P)': 'Poor (P)',
});

const CONDITION_RANK = Object.freeze({
  'Mint (M)': 0,
  'Near Mint (NM or M-)': 1,
  'Very Good Plus (VG+)': 2,
  'Very Good (VG)': 3,
  'Good Plus (G+)': 4,
  'Good (G)': 5,
  'Fair (F)': 6,
  'Poor (P)': 7,
});

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

function canonicalExplicitGrade(value) {
  const key = String(value || '').trim().toUpperCase().replace(/\s+/g, '');
  if (key === 'M') return 'Mint (M)';
  if (key === 'NM' || key === 'M-') return 'Near Mint (NM or M-)';
  if (key === 'VG+') return 'Very Good Plus (VG+)';
  if (key === 'VG') return 'Very Good (VG)';
  if (key === 'G+') return 'Good Plus (G+)';
  if (key === 'G') return 'Good (G)';
  if (key === 'F') return 'Fair (F)';
  if (key === 'P') return 'Poor (P)';
  return null;
}

// Vinted exposes one generic whole-item condition, while Discogs grades media and sleeve
// separately. Treat the Vinted label as a useful pricing proxy, never as confirmed play-grading.
// An explicit "vinyl: VG+"-style statement in the description is stronger and wins.
function vintedConditionProfile(itemOrStatus, details = {}) {
  const item = itemOrStatus && typeof itemOrStatus === 'object' ? itemOrStatus : { status: itemOrStatus };
  const status = item.status == null ? '' : String(item.status);
  const detailText = [details.description, details.name].filter(Boolean).join(' ');
  const explicit = detailText.match(/\b(?:vinyl|record|disc|disco|plaat|media)\s*(?:condition|conditie|staat|stato)?\s*[:=\-]?\s*(NM|M-|VG\+|VG|G\+|G|F|P)\b/i);
  const explicitGrade = explicit ? canonicalExplicitGrade(explicit[1]) : null;
  if (explicitGrade) {
    return {
      grade: explicitGrade,
      rank: CONDITION_RANK[explicitGrade],
      eligible: CONDITION_RANK[explicitGrade] <= CONDITION_RANK['Very Good Plus (VG+)'],
      source: 'seller-description',
      label: explicit[1].toUpperCase(),
      confirmed: false,
    };
  }

  const normalized = normalizeText(status);
  let grade = null;
  // "New" is kept at NM: Vinted's general-purpose label cannot prove a truly perfect Mint record.
  if (['nieuw met prijskaartje', 'nieuw zonder prijskaartje', 'new with tags', 'new without tags', 'new', 'like new'].includes(normalized)) grade = 'Near Mint (NM or M-)';
  else if (['heel goed', 'very good'].includes(normalized)) grade = 'Very Good Plus (VG+)';
  else if (['goed', 'good'].includes(normalized)) grade = 'Very Good (VG)';
  else if (['veelgebruikt', 'satisfactory'].includes(normalized)) grade = 'Good Plus (G+)';
  if (!grade) return null;
  return {
    grade,
    rank: CONDITION_RANK[grade],
    eligible: CONDITION_RANK[grade] <= CONDITION_RANK['Very Good Plus (VG+)'],
    source: 'vinted-status',
    label: status,
    confirmed: false,
  };
}

function conditionSuggestionReference(suggestion, condition) {
  if (!suggestion || !condition || !condition.grade) return null;
  const key = CONDITION_GRADE_KEYS[condition.grade];
  const ladder = suggestion.ladder && typeof suggestion.ladder === 'object' ? suggestion.ladder : suggestion;
  let value = finiteNumber(ladder && ladder[key]);
  if (value == null && ladder && ladder[key] && typeof ladder[key] === 'object') value = finiteNumber(ladder[key].value);
  if (value == null && condition.grade === 'Very Good Plus (VG+)') value = finiteNumber(suggestion.vgplus);
  if (value == null && condition.grade === 'Very Good (VG)') value = finiteNumber(suggestion.vg);
  return value > 0 ? value : null;
}

// Conservative flip estimate: treat the condition-matched Discogs value as the gross item sale
// price and deduct Discogs's seller fee. Buyer-paid outbound shipping, packaging, taxes and any
// grading dispute remain outside the estimate and are called out in the UI.
function estimateDiscogsResale(salePrice, acquisitionTotal, options = {}) {
  const gross = finiteNumber(salePrice);
  const cost = finiteNumber(acquisitionTotal);
  const configuredRate = finiteNumber(options.feeRate);
  const feeRate = configuredRate != null && configuredRate >= 0 && configuredRate < 1
    ? configuredRate
    : DEFAULT_DISCOGS_SELLER_FEE_RATE;
  if (!(gross > 0) || !(cost >= 0)) return null;
  const fee = gross * feeRate;
  const net = gross - fee;
  const margin = net - cost;
  return {
    gross,
    feeRate,
    fee,
    net,
    margin,
    roi: cost > 0 ? margin / cost : null,
    profitable: margin > 0,
  };
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
  const sizeValue = raw.size_title || raw.sizeTitle || raw.item_size || raw.size;
  const formatValue = raw.format_title || raw.formatTitle || raw.format;
  const categoryValue = raw.category_title || raw.categoryTitle || raw.category;
  const scalarLabel = (value) => typeof value === 'string' || typeof value === 'number'
    ? String(value)
    : (value && typeof value === 'object' ? String(value.title || value.name || value.value || '') : '');
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
    description: scalarLabel(raw.description || raw.item_description),
    sizeTitle: scalarLabel(sizeValue),
    formatTitle: scalarLabel(formatValue),
    categoryTitle: scalarLabel(categoryValue),
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
  const text = String(value || '').toLowerCase()
    .replace(/&(?:quot|ldquo|rdquo|prime);|&#(?:34|8220|8221|8243);|&#x(?:22|201c|201d|2033);/g, '"')
    .replace(/&apos;|&#39;|&#x27;/g, "'");
  const sizes = new Set();
  // Sellers use many spellings and languages. Keep this limited to explicit dimensions: RPM,
  // "single", "maxi" and "LP" are not reliable physical-size evidence on their own.
  const inchUnit = '(?:["“”″]|[\'’]{2}|-?\\s*(?:in(?:ch(?:es)?)?\\.?|pouces?|pollici|pulgadas?|zoll|cali|polegadas?))';
  for (const match of text.matchAll(new RegExp(`(?:^|[^0-9])(7|10|12)\\s*${inchUnit}(?=$|[^a-z0-9])`, 'g'))) sizes.add(Number(match[1]));
  // Metric sleeve/record dimensions commonly used by continental-European sellers.
  for (const match of text.matchAll(/(?:^|[^0-9])(17(?:[.,]5)?|18|25|30)\s*-?\s*cm\b/g)) {
    const cm = Number(match[1].replace(',', '.'));
    if (cm >= 17 && cm <= 18) sizes.add(7);
    else if (cm === 25) sizes.add(10);
    else if (cm === 30) sizes.add(12);
  }
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
  const text = [
    listing.rawTitle, listing.title, listing.description, listing.sizeTitle, listing.formatTitle, listing.categoryTitle,
    detail.name, detail.description, detail.brand, detail.color, detail.category,
  ].filter(Boolean).join(' ');
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
    .flatMap((format) => [
      ...(Array.isArray(format.descriptions) ? format.descriptions : []),
      format && format.text,
    ])
    .filter(Boolean)
    .map(String);
  const labels = (Array.isArray(metadata.labels) ? metadata.labels : []).map((label) => ({
    name: String(label && label.name || ''),
    catno: String(label && label.catno || ''),
  }));
  const descriptionText = descriptions.join(' ');
  const formatText = (Array.isArray(metadata.formats) ? metadata.formats : [])
    .flatMap((format) => [format && format.name, ...(Array.isArray(format && format.descriptions) ? format.descriptions : []), format && format.text])
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
    let discogsReleaseMatch = false;
    if (signals.discogsReleaseIds.length) {
      if (signals.discogsReleaseIds.includes(String(profile.releaseId))) {
        discogsReleaseMatch = true;
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
      const sizeConflict = signals.sizes.some((size) => !profile.sizes.includes(size));
      // Size is excellent contradiction/disambiguation evidence, but not enough by itself to
      // identify one pressing among multiple 12-inch or 7-inch editions. If the seller mentions
      // both 7 and 12 while the Discogs release has only one, fail closed instead of accepting the
      // one overlapping size.
      if (sizeConflict || !sizeMatch) conflicts.push('format-size-conflict');
      else { score += 1; evidence.push(`size-${signals.sizes.find((size) => profile.sizes.includes(size))}-inch`); }
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
    // Label + year identifies a recording, not necessarily its physical edition. If Discogs knows
    // this pressing is 7/10/12-inch but Vinted states no size, require an exact release URL or
    // catalogue number. This blocks same-year, same-label 7-inch/12-inch pairs such as Clad's
    // Song Of Arabia (wanted DM 9330 12-inch vs Vinted P 7370 7-inch).
    if (profile.sizes.length && !signals.sizes.length && !catalogMatch && !discogsReleaseMatch) {
      conflicts.push('format-size-unverified');
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
    referenceSource: reference > 0 ? (options.referenceSource || 'sold-median') : null,
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
  DEFAULT_GOOD_PRICE_DISCOUNT,
  DEFAULT_DISCOGS_SELLER_FEE_RATE,
  parseMoney,
  normalizeText,
  meaningfulTokens,
  splitArtistTitle,
  normalizeWant,
  normalizeCatalogItem,
  vintedConditionProfile,
  conditionSuggestionReference,
  estimateDiscogsResale,
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
  for (const [label, itemValue, details] of [
    ['hyphenated', { id: 9111, title: 'Air Mail - Flash In Your Mind - LMB 025', size_title: '7-inch' }, {}],
    ['curly quotes', { id: 9112, title: 'Air Mail - Flash In Your Mind - LMB 025' }, { description: 'Formato vinile 7’’' }],
    ['metric', { id: 9113, title: 'Air Mail - Flash In Your Mind - LMB 025' }, { description: 'Singolo diametro 17 cm' }],
    ['Italian', { id: 9114, title: 'Air Mail - Flash In Your Mind - LMB 025' }, { description: 'Disco 7 pollici' }],
    ['French', { id: 9115, title: 'Air Mail - Flash In Your Mind - LMB 025' }, { description: 'Vinyle 7 pouces' }],
    ['HTML quote', { id: 9116, title: 'Air Mail - Flash In Your Mind - LMB 025' }, { description: 'Vinyl 7&quot;' }],
  ]) {
    const variantDecision = resolvePressingMatch(itemValue, airMailMatch, details, originalMeta);
    assert.deepStrictEqual(
      { accepted: variantDecision.accepted, reason: variantDecision.reason },
      { accepted: false, reason: 'format-size-conflict' },
      `${label} 7-inch notation cannot inherit a wanted 12-inch release`,
    );
  }
  const rightSize = resolvePressingMatch({ id: 912, title: '12 inch Air Mail - Flash In Your Mind - LMB 025' }, airMailMatch, {}, originalMeta);
  assert.strictEqual(rightSize.accepted, true, 'matching 12-inch size and catalogue number identify the wanted release');
  const sizeFromDiscogsFreeText = resolvePressingMatch(
    { id: 9120, title: '7-inch Air Mail - Flash In Your Mind - LMB 025' },
    airMailMatch,
    {},
    { 10: { year: 1987, formats: [{ name: 'Vinyl', descriptions: ['Single'], text: '12-inch' }], labels: [{ name: 'Lombardoni Publishings', catno: 'LMB 025' }] } },
  );
  assert.deepStrictEqual(
    { accepted: sizeFromDiscogsFreeText.accepted, reason: sizeFromDiscogsFreeText.reason },
    { accepted: false, reason: 'format-size-conflict' },
    'Discogs format free text also contributes the authoritative release size',
  );
  const mixedSizes = resolvePressingMatch(
    { id: 9121, title: 'Air Mail - Flash In Your Mind - LMB 025' },
    airMailMatch,
    { description: 'Vinyl 12 inch / 7 inch' },
    originalMeta,
  );
  assert.deepStrictEqual(
    { accepted: mixedSizes.accepted, reason: mixedSizes.reason },
    { accepted: false, reason: 'format-size-conflict' },
    'a listing mentioning both 7-inch and 12-inch cannot pass through one overlapping size',
  );
  const cladIndex = buildWantIndex(
    [{ releaseId: 1733869, artist: 'Clad', title: 'Song Of Arabia', year: 1986 }],
    { 1733869: { median: 80 } },
  );
  const cladListing = {
    id: 6403537519,
    title: 'CLAD Song of Arabia vinyl 45 Italo Disco RARE',
    price: { amount: '25', currency_code: 'EUR' },
    status: 'Heel goed',
  };
  const cladMatch = matchCatalogItem(cladListing, cladIndex);
  const cladWrongFormat = resolvePressingMatch(
    cladListing,
    cladMatch,
    { description: 'CLAD Song of Arabia Panarecord 1986 vinile 45 giri Italo Disco MOLTO RARO' },
    {
      1733869: {
        id: 1733869,
        title: 'Song Of Arabia',
        year: 1986,
        country: 'Italy',
        formats: [{ name: 'Vinyl', descriptions: ['12"', '45 RPM', 'Stereo'] }],
        labels: [{ name: 'Panarecord', catno: 'DM 9330' }],
      },
    },
  );
  assert.deepStrictEqual(
    { accepted: cladWrongFormat.accepted, reason: cladWrongFormat.reason },
    { accepted: false, reason: 'format-size-unverified' },
    'Vinted 6403537519 cannot inherit the wanted Clad 12-inch value from title, label, year and 45 RPM alone',
  );
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
  const bothMatch = matchCatalogItem({ id: 95, title: '12 inch Air Mail - Flash In Your Mind - 2025 Reissue' }, bothVersions);
  const selectedReissue = resolvePressingMatch(
    { id: 95, title: '12 inch Air Mail - Flash In Your Mind - 2025 Reissue' },
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
  assert.deepStrictEqual({ accepted: unknownVersion.accepted, reason: unknownVersion.reason }, { accepted: false, reason: 'format-size-unverified' }, 'a size-less listing cannot inherit a size-specific pressing');
  const labelOnly = resolvePressingMatch({ id: 93, title: 'Air Mail - Flash In Your Mind - Lombardoni Publishings' }, airMailMatch, {}, originalMeta);
  assert.deepStrictEqual({ accepted: labelOnly.accepted, reason: labelOnly.reason }, { accepted: false, reason: 'format-size-unverified' }, 'a broad label name cannot identify the size-specific pressing by itself');
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
  const elvinCondition = vintedConditionProfile(
    { status: 'Heel goed' },
    { description: 'Disco e cover in ottimo stato. https://www.discogs.com/release/122472' },
  );
  assert.deepStrictEqual(
    { grade: elvinCondition.grade, eligible: elvinCondition.eligible, source: elvinCondition.source },
    { grade: 'Very Good Plus (VG+)', eligible: true, source: 'vinted-status' },
    'Vinted Heel goed is a VG+ pricing proxy, but not confirmed play-grading',
  );
  const elvinReference = conditionSuggestionReference({ ladder: { 'Very Good Plus (VG+)': 52.325 } }, elvinCondition);
  const elvinDeal = evaluateListing(
    { id: 6199330482, title: 'Disco 12" Elvin - Luggi, Luggi, Ludwig', price: 35, total_item_price: 37.45, status: 'Heel goed' },
    { target: { releaseId: 122472, median: 46.24 } },
    { minDiscount: DEFAULT_GOOD_PRICE_DISCOUNT, shippingEstimate: 5, reference: elvinReference, referenceSource: 'condition-suggestion' },
  );
  assert.ok(elvinDeal.isDeal && elvinDeal.total === 42.45, 'the concrete Elvin listing qualifies as a good Vinted price including estimated shipping');
  assert.strictEqual(elvinDeal.referenceSource, 'condition-suggestion');
  const elvinResale = estimateDiscogsResale(elvinReference, elvinDeal.total);
  assert.deepStrictEqual(
    {
      fee: Number(elvinResale.fee.toFixed(2)),
      net: Number(elvinResale.net.toFixed(2)),
      margin: Number(elvinResale.margin.toFixed(2)),
      roi: Number(elvinResale.roi.toFixed(3)),
    },
    { fee: 4.71, net: 47.62, margin: 5.17, roi: 0.122 },
    'resale estimate deducts the Discogs seller fee from the condition-matched value',
  );
  const explicitVg = vintedConditionProfile('Heel goed', { description: 'Vinyl: VG / Hoes: VG+' });
  assert.deepStrictEqual({ grade: explicitVg.grade, eligible: explicitVg.eligible, source: explicitVg.source }, { grade: 'Very Good (VG)', eligible: false, source: 'seller-description' }, 'an explicit media grade overrides the broad Vinted status');
  assert.deepStrictEqual(rareGemTransition({ status: 'zero' }, { status: 'available' }).isRareGem, true);
  assert.strictEqual(rareGemTransition({ status: 'available' }, { status: 'available' }).isRareGem, false);
  console.log('vinted/policy selftest: all assertions passed');
}

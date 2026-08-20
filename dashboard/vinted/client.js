'use strict';

const { DEFAULT_CATEGORY_ID } = require('./policy');

const DEFAULT_ORIGIN = 'https://www.vinted.nl';
const DEFAULT_CATALOG_PATH = '/catalog/3041-vinilines-ploksteles';
const DEFAULT_API_PATH = '/api/v2/catalog/items';
const DEFAULT_MIN_GAP_MS = 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15 * 1000;
const DEFAULT_COOLDOWN_MS = 30 * 1000;
const DEFAULT_CHALLENGE_COOLDOWN_MS = 10 * 60 * 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function headerValue(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  const wanted = String(name).toLowerCase();
  for (const [key, value] of Object.entries(headers)) if (String(key).toLowerCase() === wanted) return value;
  return null;
}

function splitSetCookieHeader(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap(splitSetCookieHeader);
  // A comma in an Expires attribute must not split the next cookie. Vinted's current
  // responses normally expose getSetCookie(), but this fallback also covers test doubles
  // and older Node/Electron Headers implementations.
  return String(value).split(/,(?=\s*[^;,=\s]+\s*=)/).map((part) => part.trim()).filter(Boolean);
}

function mergeSetCookies(jar, headersOrCookies) {
  const target = jar instanceof Map ? jar : new Map();
  const values = Array.isArray(headersOrCookies) ? headersOrCookies : (() => {
    const headers = headersOrCookies;
    if (headers && typeof headers.getSetCookie === 'function') return headers.getSetCookie();
    return splitSetCookieHeader(headerValue(headers, 'set-cookie'));
  })();
  for (const cookie of values) {
    const text = String(cookie || '').trim();
    const first = text.split(';', 1)[0];
    const separator = first.indexOf('=');
    if (separator < 1) continue;
    const name = first.slice(0, separator).trim();
    const value = first.slice(separator + 1).trim();
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) continue;
    if (!value || /\b(max-age=0|expires=thu, 01 jan 1970)/i.test(text)) target.delete(name);
    else target.set(name, value);
  }
  return target;
}

function cookieHeader(jar) {
  if (!(jar instanceof Map)) return '';
  return Array.from(jar.entries()).map(([name, value]) => `${name}=${value}`).join('; ');
}

function parseRetryAfter(value, now = Date.now()) {
  if (value == null || value === '') return null;
  const text = String(value).trim();
  const seconds = Number(text);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(text);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

function isChallengeText(text) {
  const lower = String(text || '').slice(0, 100000).toLowerCase();
  return /cf-chl-|captcha|verify you are human|access denied|bot detected|are you a robot|security check|checking your browser|just a moment/.test(lower);
}

function parseCatalogPayload(payload) {
  const body = payload && typeof payload === 'object' ? payload : {};
  const items = Array.isArray(body.items) ? body.items
    : Array.isArray(body.catalog_items) ? body.catalog_items
      : Array.isArray(body.data) ? body.data : [];
  const pagination = body.pagination && typeof body.pagination === 'object' ? body.pagination : {};
  const total = Number(body.total ?? body.total_count ?? body.totalItems ?? pagination.total_count ?? pagination.total_items ?? pagination.total_entries);
  const page = Number(body.page ?? pagination.page ?? pagination.current_page) || null;
  const perPage = Number(body.per_page ?? body.perPage ?? pagination.per_page ?? pagination.perPage) || null;
  return {
    items,
    total: Number.isFinite(total) ? total : null,
    page,
    perPage,
    pagination,
    raw: body,
  };
}

function parseItemPageHtml(html) {
  const source = String(html || '');
  const values = [];
  for (const match of source.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { values.push(JSON.parse(match[1])); } catch { /* ignore unrelated malformed JSON-LD */ }
  }
  const flattened = [];
  const visit = (value) => {
    if (!value) return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (typeof value !== 'object') return;
    flattened.push(value);
    if (Array.isArray(value['@graph'])) value['@graph'].forEach(visit);
  };
  values.forEach(visit);
  const product = flattened.find((value) => {
    const type = value['@type'];
    return type === 'Product' || (Array.isArray(type) && type.includes('Product'));
  }) || null;
  if (!product) return { found: false, name: '', description: '', brand: '', color: '', category: '', images: [] };
  const brand = typeof product.brand === 'string' ? product.brand : product.brand && (product.brand.name || product.brand['@id']) || '';
  const images = (Array.isArray(product.image) ? product.image : [product.image]).filter((value) => typeof value === 'string').slice(0, 10);
  return {
    found: true,
    name: String(product.name || '').slice(0, 500),
    description: String(product.description || '').slice(0, 20_000),
    brand: String(brand || '').slice(0, 300),
    color: String(product.color || '').slice(0, 200),
    category: String(product.category || '').slice(0, 300),
    images,
  };
}

function defaultUserAgent() {
  const chrome = process.versions && process.versions.chrome ? process.versions.chrome : '120.0.0.0';
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Safari/537.36`;
}

class VintedClientError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'VintedClientError';
    Object.assign(this, details);
  }
}

class VintedRateLimitError extends VintedClientError {
  constructor(message, details = {}) {
    super(message, details);
    this.name = 'VintedRateLimitError';
    this.code = 'RATE_LIMITED';
  }
}

class VintedChallengeError extends VintedClientError {
  constructor(message, details = {}) {
    super(message, details);
    this.name = 'VintedChallengeError';
    this.code = 'CHALLENGE';
  }
}

class VintedClient {
  constructor(options = {}) {
    const fetchImpl = options.fetchImpl || globalThis.fetch;
    if (typeof fetchImpl !== 'function') throw new Error('VintedClient needs a fetch implementation.');
    this.fetchImpl = fetchImpl;
    this.origin = String(options.origin || DEFAULT_ORIGIN).replace(/\/$/, '');
    this.catalogPath = options.catalogPath || DEFAULT_CATALOG_PATH;
    this.apiPath = options.apiPath || DEFAULT_API_PATH;
    this.categoryId = Number(options.categoryId) || DEFAULT_CATEGORY_ID;
    this.userAgent = String(options.userAgent || defaultUserAgent());
    this.minGapMs = Math.max(0, Number(options.minGapMs ?? options.minIntervalMs ?? DEFAULT_MIN_GAP_MS) || 0);
    this.requestTimeoutMs = Math.max(1000, Number(options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS) || DEFAULT_REQUEST_TIMEOUT_MS);
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this.sleep = typeof options.sleep === 'function' ? options.sleep : sleep;
    this.onStatus = typeof options.onStatus === 'function' ? options.onStatus : null;
    this.jar = new Map();
    this.lastRequestAt = 0;
    this.requestCount = 0;
    this.bootstrapped = false;
    this.closed = false;
    this.cooldownUntil = 0;
    this.challengeUntil = 0;
    this.lastStatusCode = null;
    this.lastError = null;
    this._queue = Promise.resolve();
    this._controllers = new Set();
  }

  _emit(extra = {}) {
    if (!this.onStatus) return;
    try { this.onStatus(this.status(extra)); } catch { /* status reporting must never break polling */ }
  }

  status(extra = {}) {
    const now = this.now();
    const blockedUntil = Math.max(this.cooldownUntil, this.challengeUntil);
    return {
      state: this.closed ? 'closed' : (blockedUntil > now ? (this.challengeUntil > now ? 'challenged' : 'cooldown') : (this.bootstrapped ? 'ready' : 'idle')),
      blockedUntil: blockedUntil || null,
      lastRequestAt: this.lastRequestAt || null,
      requestCount: this.requestCount,
      lastStatusCode: this.lastStatusCode,
      lastError: this.lastError,
      bootstrapped: this.bootstrapped,
      cookieCount: this.jar.size,
      ...extra,
    };
  }

  _url(pathname, params) {
    const url = new URL(pathname, this.origin);
    if (params) for (const [key, value] of Object.entries(params)) {
      if (value == null || value === '') continue;
      url.searchParams.set(key, String(value));
    }
    return url;
  }

  async _waitGate() {
    if (this.closed) throw new VintedClientError('Vinted client is closed.', { code: 'CLOSED' });
    const now = this.now();
    const blockedUntil = Math.max(this.cooldownUntil, this.challengeUntil);
    if (blockedUntil > now) {
      throw new VintedClientError('Vinted requests are paused temporarily.', {
        code: this.challengeUntil > now ? 'CHALLENGE' : 'COOLDOWN',
        retryAfterMs: blockedUntil - now,
      });
    }
    const wait = this.lastRequestAt ? this.minGapMs - (now - this.lastRequestAt) : 0;
    if (wait > 0) await this.sleep(wait);
    if (this.closed) throw new VintedClientError('Vinted client is closed.', { code: 'CLOSED' });
  }

  _headers(referer) {
    const headers = {
      accept: 'application/json, text/plain, */*',
      'accept-language': 'nl-NL,nl;q=0.9,en;q=0.8',
      'user-agent': this.userAgent,
      'x-requested-with': 'XMLHttpRequest',
    };
    if (referer) headers.referer = referer;
    const cookies = cookieHeader(this.jar);
    if (cookies) headers.cookie = cookies;
    return headers;
  }

  async _fetch(url, options = {}) {
    await this._waitGate();
    this.lastRequestAt = this.now();
    this.requestCount += 1;
    const controller = new AbortController();
    this._controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    let response;
    try {
      response = await this.fetchImpl(String(url), {
        method: 'GET',
        // Fail closed on redirects. All adapter endpoints and item URLs are already canonical;
        // following an unexpected redirect could leave the intended Vinted origin.
        redirect: 'error',
        ...options,
        signal: controller.signal,
        headers: { ...this._headers(options.referer), ...(options.headers || {}) },
      });
    } catch (error) {
      if (this.closed) throw new VintedClientError('Vinted client is closed.', { code: 'CLOSED', cause: error });
      this.lastError = error && error.name === 'AbortError' ? 'timeout' : 'network';
      this._emit();
      if (error && error.name === 'AbortError') throw new VintedClientError('Vinted request timed out.', { code: 'TIMEOUT', cause: error });
      throw new VintedClientError('Vinted request failed.', { code: 'NETWORK', cause: error });
    } finally {
      clearTimeout(timeout);
      this._controllers.delete(controller);
    }
    if (this.closed) throw new VintedClientError('Vinted client is closed.', { code: 'CLOSED' });
    this.lastStatusCode = Number(response.status) || null;
    const headers = response.headers;
    mergeSetCookies(this.jar, headers);
    this._emit();
    return response;
  }

  async _bootstrap() {
    if (this.bootstrapped) return;
    const url = this._url(this.catalogPath);
    let response;
    try {
      response = await this._fetch(url, { headers: { accept: 'text/html,application/xhtml+xml' }, referer: `${this.origin}/` });
    } catch (error) {
      this.lastError = error && error.code ? error.code : 'bootstrap-failed';
      throw error;
    }
    if (response.status === 403 || response.status === 429) return this._handleFailure(response, 'bootstrap');
    if (!response.ok) throw new VintedClientError(`Vinted bootstrap returned HTTP ${response.status}.`, { status: response.status });
    let body = '';
    try { body = await response.text(); } catch { /* status and cookies are still useful */ }
    if (isChallengeText(body)) return this._pauseChallenge('bootstrap', response.status);
    this.bootstrapped = true;
    this.lastError = null;
    this._emit();
  }

  async _handleFailure(response, operation) {
    const retryAfterMs = parseRetryAfter(headerValue(response.headers, 'retry-after'), this.now());
    let body = '';
    try { body = await response.text(); } catch { /* status is enough */ }
    if (response.status === 429) {
      const pause = Math.max(retryAfterMs || 0, DEFAULT_COOLDOWN_MS);
      this.cooldownUntil = this.now() + pause;
      this.lastError = 'rate-limited';
      this._emit({ retryAfterMs: pause });
      throw new VintedRateLimitError(`Vinted rate limit during ${operation}.`, { status: 429, retryAfterMs: pause });
    }
    if (response.status === 403 || isChallengeText(body)) return this._pauseChallenge(operation, response.status);
    throw new VintedClientError(`Vinted returned HTTP ${response.status} during ${operation}.`, { status: response.status });
  }

  _pauseChallenge(operation, status) {
    const pause = DEFAULT_CHALLENGE_COOLDOWN_MS;
    this.challengeUntil = this.now() + pause;
    this.lastError = 'challenge';
    this._emit({ retryAfterMs: pause });
    throw new VintedChallengeError(`Vinted access challenge during ${operation}; requests paused.`, { status, retryAfterMs: pause });
  }

  async _fetchJson(url, operation) {
    const response = await this._fetch(url, { referer: `${this.origin}${this.catalogPath}` });
    if (response.status === 429 || response.status === 403) return this._handleFailure(response, operation);
    let body = '';
    try { body = await response.text(); }
    catch (error) { throw new VintedClientError(`Vinted response could not be read during ${operation}.`, { status: response.status, cause: error }); }
    let payload;
    try { payload = JSON.parse(body); }
    catch (error) {
      if (isChallengeText(body)) return this._pauseChallenge(operation, response.status);
      throw new VintedClientError(`Vinted returned invalid JSON during ${operation}.`, { status: response.status, cause: error });
    }
    if (!response.ok) throw new VintedClientError(`Vinted returned HTTP ${response.status} during ${operation}.`, { status: response.status });
    this.lastError = null;
    this._emit();
    return payload;
  }

  // Fetch one page of the anonymous catalog. The caller should schedule broad polls and
  // deep-hunt queries; this client only enforces sequential pacing and the safety circuit.
  async _catalog(options = {}, retriedAuth = false) {
    await this._bootstrap();
    const page = Math.max(1, Math.min(1000, Number(options.page) || 1));
    const perPage = Math.max(1, Math.min(96, Number(options.perPage) || 96));
    const priceTo = Number(options.priceTo);
    const params = {
      search_text: options.searchText ? String(options.searchText).trim().slice(0, 120) : null,
      catalog_ids: options.catalogId == null ? this.categoryId : Number(options.catalogId),
      page,
      per_page: perPage,
      order: options.order || 'newest_first',
      price_to: Number.isFinite(priceTo) && priceTo > 0 ? priceTo : null,
    };
    let payload;
    try { payload = await this._fetchJson(this._url(this.apiPath, params), 'catalog'); }
    catch (error) {
      // Anonymous access cookies can expire during a long-running desktop session. Refresh them
      // once on 401; never retry challenges/rate limits and never loop indefinitely.
      if (!retriedAuth && error && error.status === 401) {
        this.jar.clear();
        this.bootstrapped = false;
        return this._catalog(options, true);
      }
      throw error;
    }
    const parsed = parseCatalogPayload(payload);
    return { ...parsed, requested: { ...params }, fetchedAt: this.now() };
  }

  catalog(options = {}) {
    const run = () => this._catalog(options);
    const pending = this._queue.then(run, run);
    this._queue = pending.then(() => undefined, () => undefined);
    return pending;
  }

  async _itemPage(itemUrl) {
    await this._bootstrap();
    const url = new URL(String(itemUrl || ''), this.origin);
    if (url.origin !== this.origin || !/^\/items\/\d+/.test(url.pathname)) {
      throw new VintedClientError('Refusing an invalid Vinted item URL.', { code: 'INVALID_ITEM_URL' });
    }
    const response = await this._fetch(url, {
      referer: `${this.origin}${this.catalogPath}`,
      headers: { accept: 'text/html,application/xhtml+xml' },
    });
    if (response.status === 429 || response.status === 403) return this._handleFailure(response, 'item page');
    if (!response.ok) throw new VintedClientError(`Vinted returned HTTP ${response.status} during item page.`, { status: response.status });
    let body = '';
    try { body = await response.text(); }
    catch (error) { throw new VintedClientError('Vinted item page could not be read.', { status: response.status, cause: error }); }
    if (isChallengeText(body)) return this._pauseChallenge('item page', response.status);
    this.lastError = null;
    this._emit();
    return { ...parseItemPageHtml(body), fetchedAt: this.now(), url: url.href };
  }

  itemPage(itemUrl) {
    const run = () => this._itemPage(itemUrl);
    const pending = this._queue.then(run, run);
    this._queue = pending.then(() => undefined, () => undefined);
    return pending;
  }

  close() {
    this.closed = true;
    for (const controller of this._controllers) controller.abort();
    this._controllers.clear();
    this.jar.clear();
    this._emit();
  }
}

function createVintedClient(options) {
  return new VintedClient(options);
}

module.exports = {
  DEFAULT_ORIGIN,
  DEFAULT_CATALOG_PATH,
  DEFAULT_API_PATH,
  DEFAULT_MIN_GAP_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  VintedClient,
  VintedClientError,
  VintedRateLimitError,
  VintedChallengeError,
  createVintedClient,
  parseRetryAfter,
  isChallengeText,
  mergeSetCookies,
  cookieHeader,
  parseCatalogPayload,
  parseItemPageHtml,
};

if (require.main === module && process.argv.includes('--selftest')) {
  const assert = require('assert');
  assert.strictEqual(parseRetryAfter('2'), 2000);
  assert.strictEqual(isChallengeText('<html>Verify you are human</html>'), true);
  const itemPage = parseItemPageHtml('<script type="application/ld+json">{"@type":"Product","name":"Air Mail","description":"1987 original LMB 025","brand":{"name":"Lombardoni"},"color":"Black"}</script>');
  assert.deepStrictEqual({ found: itemPage.found, name: itemPage.name, brand: itemPage.brand, color: itemPage.color }, { found: true, name: 'Air Mail', brand: 'Lombardoni', color: 'Black' });
  const jar = mergeSetCookies(new Map(), ['anon=secret; Path=/', 'second=ok; Path=/']);
  assert.strictEqual(cookieHeader(jar), 'anon=secret; second=ok');
  let calls = 0;
  const fakeFetch = async (url) => {
    calls += 1;
    if (String(url).includes('/catalog/3041-')) {
      return { status: 200, ok: true, headers: { getSetCookie: () => ['anon=not-logged-in; Path=/'] }, text: async () => '<html></html>' };
    }
    return {
      status: 200,
      ok: true,
      headers: { getSetCookie: () => [] },
      text: async () => JSON.stringify({ items: [{ id: 1 }], pagination: { total_entries: 1, current_page: 1, per_page: 1 } }),
    };
  };
  (async () => {
    const client = createVintedClient({ fetchImpl: fakeFetch, minGapMs: 0 });
    const [result] = await Promise.all([client.catalog({ page: 1, perPage: 1 }), client.catalog({ page: 2, perPage: 1 })]);
    assert.strictEqual(calls, 3, 'concurrent catalog calls share one bootstrap and execute sequentially');
    assert.strictEqual(result.items.length, 1);
    assert.strictEqual(result.total, 1);
    assert.strictEqual(client.status().cookieCount, 1);
    client.close();
    assert.strictEqual(client.status().state, 'closed');
    let challengeCalls = 0;
    const challengeClient = createVintedClient({ minGapMs: 0, fetchImpl: async (url) => {
      challengeCalls += 1;
      if (String(url).includes('/catalog/3041-')) return { status: 200, ok: true, headers: { getSetCookie: () => ['anon=safe; Path=/'] }, text: async () => '<html>catalog</html>' };
      return { status: 200, ok: true, headers: { getSetCookie: () => [] }, text: async () => '<html>Verify you are human</html>' };
    } });
    await assert.rejects(challengeClient.catalog(), (error) => error && error.code === 'CHALLENGE');
    assert.strictEqual(challengeCalls, 2);
    assert.strictEqual(challengeClient.status().state, 'challenged', 'HTTP 200 challenge HTML opens the safety circuit');
    let rateCalls = 0;
    const rateClient = createVintedClient({ minGapMs: 0, fetchImpl: async (url) => {
      rateCalls += 1;
      if (String(url).includes('/catalog/3041-')) return { status: 200, ok: true, headers: { getSetCookie: () => ['anon=safe; Path=/'] }, text: async () => '<html>catalog</html>' };
      return { status: 429, ok: false, headers: { get: (name) => name === 'retry-after' ? '2' : null, getSetCookie: () => [] }, text: async () => '' };
    } });
    await assert.rejects(rateClient.catalog(), (error) => error && error.code === 'RATE_LIMITED' && error.retryAfterMs >= 30_000);
    assert.strictEqual(rateCalls, 2);
    await assert.rejects(rateClient.catalog(), (error) => error && error.code === 'COOLDOWN');
    assert.strictEqual(rateCalls, 2, 'cooldown blocks locally without touching Vinted again');
    let authCalls = 0;
    const authClient = createVintedClient({ minGapMs: 0, fetchImpl: async (url) => {
      authCalls += 1;
      if (String(url).includes('/catalog/3041-')) return { status: 200, ok: true, headers: { getSetCookie: () => [`anon=round-${authCalls}; Path=/`] }, text: async () => '<html>catalog</html>' };
      if (authCalls === 2) return { status: 401, ok: false, headers: { getSetCookie: () => [] }, text: async () => JSON.stringify({ code: 401 }) };
      return { status: 200, ok: true, headers: { getSetCookie: () => [] }, text: async () => JSON.stringify({ items: [] }) };
    } });
    await authClient.catalog();
    assert.strictEqual(authCalls, 4, 'an expired anonymous session is bootstrapped exactly once and retried');
    let requestStarted;
    const started = new Promise((resolve) => { requestStarted = resolve; });
    const closingClient = createVintedClient({ minGapMs: 0, fetchImpl: async (_url, request) => new Promise((_resolve, reject) => {
      requestStarted();
      request.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
    }) });
    const pending = closingClient.catalog();
    await started;
    closingClient.close();
    await assert.rejects(pending, (error) => error && error.code === 'CLOSED');
    console.log('vinted/client selftest: all assertions passed');
  })().catch((error) => { console.error(error); process.exitCode = 1; });
}

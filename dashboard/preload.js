'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (s) => ipcRenderer.invoke('settings:set', s),
  // Discogs account config (first-run wizard / Settings). getConfig never returns the token itself.
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (c) => ipcRenderer.invoke('config:set', c),
  testConfig: (c) => ipcRenderer.invoke('config:test', c),
  getDeals: (limit) => ipcRenderer.invoke('deals:get', limit),
  // 💎 rare gems + zero-stock watch list -> { ts, gems: [...], zeroWatch: [...] }
  getGems: () => ipcRenderer.invoke('gems:get'),
  getStatus: () => ipcRenderer.invoke('status:get'),
  getHealth: () => ipcRenderer.invoke('health:get'),
  openExternal: (url) => ipcRenderer.invoke('open:external', url),
  // One coordinated action starts every available marketplace scanner concurrently.
  scanAll: () => ipcRenderer.invoke('scan:all'),
  onScanAllUpdate: (cb) => {
    const h = (_e, m) => cb(m);
    ipcRenderer.on('scan-all:update', h);
    return () => ipcRenderer.removeListener('scan-all:update', h);
  },
  // Local scan: full sweep, or a prioritized quick scan ({ quick: true }).
  scrapeRun: (opts) => ipcRenderer.invoke('scrape:run', opts),
  scrapeCancel: () => ipcRenderer.invoke('scrape:cancel'),
  scrapeLast: () => ipcRenderer.invoke('scrape:last'),
  // Vinted: an anonymous, local-only newest-listings sniper. The renderer receives normalized
  // listings and health only; session cookies stay inside the main process and are never exposed.
  vintedSnapshot: () => ipcRenderer.invoke('vinted:snapshot'),
  vintedSetEnabled: (enabled) => ipcRenderer.invoke('vinted:setEnabled', !!enabled),
  vintedConfigure: (options) => ipcRenderer.invoke('vinted:configure', options || {}),
  vintedScanNow: () => ipcRenderer.invoke('vinted:scanNow'),
  vintedStartBackfill: () => ipcRenderer.invoke('vinted:startBackfill'),
  vintedCancelBackfill: () => ipcRenderer.invoke('vinted:cancelBackfill'),
  onVintedUpdate: (cb) => {
    const h = (_e, m) => cb(m);
    ipcRenderer.on('vinted:update', h);
    return () => ipcRenderer.removeListener('vinted:update', h);
  },
  // eBay: official Browse API. The renderer can submit a Cert ID once, but can never read it back.
  ebayCredentialsStatus: () => ipcRenderer.invoke('ebay:credentialsStatus'),
  ebaySaveCredentials: (credentials) => ipcRenderer.invoke('ebay:saveCredentials', credentials || {}),
  ebayTest: (options) => ipcRenderer.invoke('ebay:test', options || {}),
  ebaySnapshot: () => ipcRenderer.invoke('ebay:snapshot'),
  ebaySetEnabled: (enabled) => ipcRenderer.invoke('ebay:setEnabled', !!enabled),
  ebayConfigure: (options) => ipcRenderer.invoke('ebay:configure', options || {}),
  ebayScanNow: () => ipcRenderer.invoke('ebay:scanNow'),
  ebayCloudSetup: (options) => ipcRenderer.invoke('ebay:cloudSetup', options || {}),
  onEbayUpdate: (cb) => {
    const h = (_e, m) => cb(m);
    ipcRenderer.on('ebay:update', h);
    return () => ipcRenderer.removeListener('ebay:update', h);
  },
  // Tradera: official REST v4 app authentication. The App Key is write-only from the renderer.
  traderaCredentialsStatus: () => ipcRenderer.invoke('tradera:credentialsStatus'),
  traderaSaveCredentials: (credentials) => ipcRenderer.invoke('tradera:saveCredentials', credentials || {}),
  traderaTest: () => ipcRenderer.invoke('tradera:test'),
  traderaSnapshot: () => ipcRenderer.invoke('tradera:snapshot'),
  traderaSetEnabled: (enabled) => ipcRenderer.invoke('tradera:setEnabled', !!enabled),
  traderaConfigure: (options) => ipcRenderer.invoke('tradera:configure', options || {}),
  traderaScanNow: () => ipcRenderer.invoke('tradera:scanNow'),
  traderaCloudSetup: (options) => ipcRenderer.invoke('tradera:cloudSetup', options || {}),
  onTraderaUpdate: (cb) => {
    const h = (_e, m) => cb(m);
    ipcRenderer.on('tradera:update', h);
    return () => ipcRenderer.removeListener('tradera:update', h);
  },
  // Marktplaats: official OAuth2 API v2. The Client Secret is write-only from the renderer.
  marktplaatsCredentialsStatus: () => ipcRenderer.invoke('marktplaats:credentialsStatus'),
  marktplaatsSaveCredentials: (credentials) => ipcRenderer.invoke('marktplaats:saveCredentials', credentials || {}),
  marktplaatsTest: () => ipcRenderer.invoke('marktplaats:test'),
  marktplaatsSnapshot: () => ipcRenderer.invoke('marktplaats:snapshot'),
  marktplaatsSetEnabled: (enabled) => ipcRenderer.invoke('marktplaats:setEnabled', !!enabled),
  marktplaatsConfigure: (options) => ipcRenderer.invoke('marktplaats:configure', options || {}),
  marktplaatsScanNow: () => ipcRenderer.invoke('marktplaats:scanNow'),
  onMarktplaatsUpdate: (cb) => {
    const h = (_e, m) => cb(m);
    ipcRenderer.on('marktplaats:update', h);
    return () => ipcRenderer.removeListener('marktplaats:update', h);
  },
  // Scout: discover valuable vinyl outside the current wantlist by Discogs genre/style.
  scoutRun: (opts) => ipcRenderer.invoke('scout:run', opts),
  scoutCancel: () => ipcRenderer.invoke('scout:cancel'),
  scoutLast: () => ipcRenderer.invoke('scout:last'),
  scoutAddWant: (releaseId) => ipcRenderer.invoke('scout:addWant', releaseId),
  onScoutProgress: (cb) => {
    const h = (_e, m) => cb(m);
    ipcRenderer.on('scout:progress', h);
    return () => ipcRenderer.removeListener('scout:progress', h);
  },
  // City Dig: scan verified physical record-store inventories by city and taxonomy.
  cityDigData: () => ipcRenderer.invoke('cityDig:data'),
  cityDigCounts: (cityId) => ipcRenderer.invoke('cityDig:counts', cityId),
  cityDigRun: (opts) => ipcRenderer.invoke('cityDig:run', opts),
  cityDigCancel: () => ipcRenderer.invoke('cityDig:cancel'),
  cityDigLast: () => ipcRenderer.invoke('cityDig:last'),
  onCityDigProgress: (cb) => {
    const h = (_e, m) => cb(m);
    ipcRenderer.on('cityDig:progress', h);
    return () => ipcRenderer.removeListener('cityDig:progress', h);
  },
  // Sold-medians git push: last persisted outcome (null = badge hidden) + a manual retry.
  getPushStatus: () => ipcRenderer.invoke('medians:pushStatus'),
  retryPush: () => ipcRenderer.invoke('medians:retryPush'),
  // One-time Discogs login (unlocks the Sales History page for the 💎 rare-gem recent-sales list).
  getDiscogsLoginStatus: () => ipcRenderer.invoke('discogs:loginStatus'),
  loginDiscogs: () => ipcRenderer.invoke('discogs:login'),
  // ☁ Cloud setup: fork the watcher repo + configure the 24/7 email watcher on the user's own
  // GitHub account. Tokens are used transiently; progress streams via cloud:progress.
  cloudSetup: (opts) => ipcRenderer.invoke('cloud:setup', opts),
  onCloudProgress: (cb) => {
    const h = (_e, m) => cb(m);
    ipcRenderer.on('cloud:progress', h);
    return () => ipcRenderer.removeListener('cloud:progress', h);
  },
  // ✈ Telegram push: test (resolve chat id + send a test message) then save the secrets to the fork.
  telegramTest: (opts) => ipcRenderer.invoke('telegram:test', opts),
  telegramSetup: (opts) => ipcRenderer.invoke('telegram:setup', opts),
  onTelegramProgress: (cb) => {
    const h = (_e, m) => cb(m);
    ipcRenderer.on('telegram:progress', h);
    return () => ipcRenderer.removeListener('telegram:progress', h);
  },
  onScrapeProgress: (cb) => {
    const h = (_e, m) => cb(m);
    ipcRenderer.on('scrape:progress', h);
    return () => ipcRenderer.removeListener('scrape:progress', h);
  },
  // Automatic verification of the cloud feed: live listings check (still buyable? real condition +
  // shipping?) for the visible deals/gems. Cached in main; safe to call on every refresh.
  verifyDeals: (items) => ipcRenderer.invoke('verify:run', items),
  onVerifyProgress: (cb) => {
    const h = (_e, m) => cb(m);
    ipcRenderer.on('verify:progress', h);
    return () => ipcRenderer.removeListener('verify:progress', h);
  },
});

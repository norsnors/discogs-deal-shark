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
  // Local scan: full sweep, or a prioritized quick scan ({ quick: true }).
  scrapeRun: (opts) => ipcRenderer.invoke('scrape:run', opts),
  scrapeCancel: () => ipcRenderer.invoke('scrape:cancel'),
  scrapeLast: () => ipcRenderer.invoke('scrape:last'),
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

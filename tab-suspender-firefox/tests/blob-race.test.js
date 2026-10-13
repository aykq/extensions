/**
 * Zen Tab Suspender — `suspended` blob testleri.
 *
 * Brave portunda bulunan üç hata bu sürüme de taşındı; bu test onları koruyor:
 *   1. Toplu suspend'de kayıp güncelleme (blob serileştirilmemişti)
 *   2. Storage kaydı eksikken geri yüklemenin boş sayfa açması
 *   3. Çoklu seçimde toplu geri yükleme olmaması
 *
 * Çalıştırma:  node tests/blob-race.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'background.js'), 'utf8');
const MSGS = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', '_locales', 'en', 'messages.json'), 'utf8'));
const EXT_ORIGIN = 'moz-extension://11111111-2222-3333-4444-555555555555/';
const SUSPEND_PREFIX = EXT_ORIGIN + 'suspend/suspend.html';

let pass = 0;
let fail = 0;

function check(name, cond, extra) {
  if (cond) {
    pass++;
    console.log('  OK   ' + name);
  } else {
    fail++;
    console.log('  FAIL ' + name + (extra ? '  -> ' + extra : ''));
  }
}

const tick = () => new Promise((r) => setTimeout(r, 40));
const settle = () => new Promise((r) => setTimeout(r, 700));

function createBrowserWorld(tabs) {
  return { local: {}, tabs, updates: [], created: [], discarded: [], menus: {} };
}

/**
 * opts.favicon:        favicon boru hattı (fetch/bitmap/canvas/FileReader) başarılı olur
 * opts.storageLatency: storage.local'a ms cinsinden gecikme. Gecikmesiz bir stub
 *                      read-modify-write yarışlarını yapay olarak serileştirip GİZLER.
 */
function boot(world, opts) {
  const L = {
    onInstalled: [], onStartup: [], onMessage: [], onAlarm: [], onCommand: [],
    tabActivated: [], tabUpdated: [], tabMoved: [], tabCreated: [], tabRemoved: [],
    menuShown: [], menuClicked: [],
  };
  const ioLatency = (opts && opts.storageLatency)
    ? () => new Promise((r) => setTimeout(r, opts.storageLatency))
    : () => Promise.resolve();
  const ev = (arr) => ({
    addListener: (fn) => arr.push(fn),
    removeListener: (fn) => { const i = arr.indexOf(fn); if (i !== -1) arr.splice(i, 1); },
  });
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const alarms = {};

  const browserApi = {
    i18n: { getMessage: (k) => (MSGS[k] || {}).message || k },
    runtime: {
      getURL: (p) => EXT_ORIGIN + String(p).replace(/^\//, ''),
      onInstalled: ev(L.onInstalled),
      onStartup: ev(L.onStartup),
      onMessage: ev(L.onMessage),
    },
    storage: {
      local: {
        get: async (key) => {
          await ioLatency();
          return key in world.local ? { [key]: clone(world.local[key]) } : {};
        },
        set: async (obj) => { await ioLatency(); Object.assign(world.local, clone(obj)); },
      },
      onChanged: ev([]),
    },
    alarms: {
      create: (name, info) => { alarms[name] = info; },
      get: async (name) => alarms[name] || null,
      clear: async (name) => { delete alarms[name]; },
      onAlarm: ev(L.onAlarm),
    },
    commands: { onCommand: ev(L.onCommand) },
    action: { openPopup: async () => {} },
    menus: {
      removeAll: async () => { world.menus = {}; },
      create: (o) => { world.menus[o.id] = Object.assign({}, o); },
      update: async (id, patch) => { Object.assign(world.menus[id] || {}, patch); },
      refresh: () => {},
      onShown: ev(L.menuShown),
      onClicked: ev(L.menuClicked),
    },
    tabs: {
      query: async (q) => {
        const f = q || {};
        return world.tabs.filter((t) =>
          (f.windowId === undefined || t.windowId === f.windowId) &&
          (f.active === undefined || t.active === f.active) &&
          (f.highlighted === undefined || Boolean(t.highlighted) === f.highlighted)
        ).map(clone);
      },
      get: async (id) => {
        const t = world.tabs.find((x) => x.id === id);
        if (!t) throw new Error('No tab with id ' + id);
        return clone(t);
      },
      update: async (id, props) => {
        world.updates.push(Object.assign({ id: id }, props));
        const t = world.tabs.find((x) => x.id === id);
        if (t) Object.assign(t, props);
        return t ? clone(t) : null;
      },
      create: async (props) => { world.created.push(props); return Object.assign({ id: 999 }, props); },
      discard: async (id) => { world.discarded.push(id); },
      onActivated: ev(L.tabActivated), onUpdated: ev(L.tabUpdated),
      onMoved: ev(L.tabMoved), onCreated: ev(L.tabCreated), onRemoved: ev(L.tabRemoved),
    },
  };

  const sandbox = {
    browser: browserApi, console: console,
    setTimeout: setTimeout, clearTimeout: clearTimeout,
    Promise: Promise, Date: Date, Math: Math, JSON: JSON,
    Object: Object, Array: Array, Set: Set, Map: Map,
    String: String, Number: Number, Boolean: Boolean, Error: Error,
    URL: URL, URLSearchParams: URLSearchParams, crypto: crypto,
    Uint8Array: Uint8Array, RegExp: RegExp,
    fetch: async () => { throw new Error('offline in test'); },
    createImageBitmap: async () => { throw new Error('offline in test'); },
    OffscreenCanvas: function () { throw new Error('offline in test'); },
    FileReader: function () { throw new Error('offline in test'); },
  };

  if (opts && opts.favicon) {
    const delay = (ms) => new Promise((r) => setTimeout(r, ms));
    const noop = () => {};
    sandbox.Blob = Blob;
    sandbox.fetch = async () => {
      await delay(40);
      return { ok: true, headers: { get: () => null }, blob: async () => new Blob([new Uint8Array([1, 2, 3, 4])]) };
    };
    sandbox.AbortController = AbortController;
    sandbox.createImageBitmap = async () => ({ width: 32, height: 32, close: noop });
    sandbox.OffscreenCanvas = function () {
      return {
        getContext: () => ({
          filter: '', fillStyle: '',
          drawImage: noop, beginPath: noop, arc: noop, fill: noop, roundRect: noop,
        }),
        convertToBlob: async () => new Blob([new Uint8Array([137, 80, 78, 71])]),
      };
    };
    // Firefox sürümü data URL'i FileReader ile üretiyor (Chromium portunda
    // arrayBuffer+btoa ile değiştirilmişti; burada olduğu gibi bırakıldı).
    sandbox.FileReader = function () {
      this.readAsDataURL = () => {
        this.result = 'data:image/png;base64,iVBORw0KGgo=';
        setTimeout(() => this.onload && this.onload(), 1);
      };
    };
  }

  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'background.js' });
  return { L: L, alarms: alarms };
}

(async () => {
  // ── 1. Toplu suspend: kayıp güncelleme
  console.log('\n-- Toplu suspend (12 sekme) --');
  const N = 12;
  const many = [];
  for (let i = 1; i <= N; i++) {
    many.push({
      id: i, index: i - 1, windowId: 1, active: i === 1, highlighted: true,
      pinned: false, discarded: false,
      url: 'https://ayni.example/sayfa' + i, title: 'Sayfa ' + i,
      favIconUrl: 'https://ayni.example/favicon.ico',
    });
  }
  const w1 = createBrowserWorld(many);
  const sw1 = boot(w1, { favicon: true, storageLatency: 5 });
  for (const fn of sw1.L.onInstalled) await fn();
  for (const fn of sw1.L.onCommand) await fn('toggle-suspend');
  await settle();
  await settle();

  const stored = w1.local.suspended || {};
  const uuids = Object.keys(stored);
  check(N + ' sekmenin HEPSI `suspended` blobunda',
    uuids.length === N, uuids.length + '/' + N);
  const withGrey = uuids.filter((u) => stored[u].greyFavIconUrl);
  check('HEPSININ greyscale favicon-u yazildi (ikon tutarliligi)',
    withGrey.length === N, withGrey.length + '/' + N + ' ikon yazildi');

  // ── 2. Kayıt eksikken URL parametresinden geri yükleme
  console.log('\n-- Kayit eksik: URL parametresinden geri yukleme --');
  const lostUrl = SUSPEND_PREFIX + '?id=lost&url=' +
    encodeURIComponent('https://kayip.example/makale') + '&t=Kayip&ts=1';
  const w2 = createBrowserWorld([
    { id: 1, index: 0, windowId: 1, active: true, highlighted: true, pinned: false,
      url: lostUrl, title: 'Kayip' },
  ]);
  w2.local.suspended = {};
  const sw2 = boot(w2);
  for (const fn of sw2.L.onInstalled) await fn();
  for (const fn of sw2.L.onCommand) await fn('toggle-suspend');
  await tick();
  check('kayit eksikken bos sayfa DEGIL, dogru URL aciliyor',
    w2.updates.some((u) => u.url === 'https://kayip.example/makale'),
    JSON.stringify(w2.updates));
  check('about:newtab-e dusulmedi',
    !w2.updates.some((u) => u.url === 'about:newtab'), JSON.stringify(w2.updates));

  const loopUrl = SUSPEND_PREFIX + '?id=loop&url=' +
    encodeURIComponent(SUSPEND_PREFIX + '?id=x') + '&t=L&ts=1';
  const w3 = createBrowserWorld([
    { id: 1, index: 0, windowId: 1, active: true, highlighted: true, pinned: false,
      url: loopUrl, title: 'L' },
  ]);
  w3.local.suspended = {};
  const sw3 = boot(w3);
  for (const fn of sw3.L.onInstalled) await fn();
  for (const fn of sw3.L.onCommand) await fn('toggle-suspend');
  await tick();
  check('suspend sayfasina geri donme dongusu reddedildi',
    w3.updates.every((u) => String(u.url || '').indexOf(SUSPEND_PREFIX) !== 0),
    JSON.stringify(w3.updates));

  // ── 3. Çoklu seçimde toplu geri yükleme
  console.log('\n-- Toplu unsuspend (coklu secim) --');
  const susUrl = (i) => SUSPEND_PREFIX + '?id=u' + i + '&url=' +
    encodeURIComponent('https://geri.example/' + i) + '&t=G' + i + '&ts=1';
  const allSus = [];
  const store = {};
  for (let i = 1; i <= 4; i++) {
    allSus.push({ id: i, index: i - 1, windowId: 1, active: i === 1, highlighted: true,
      pinned: false, url: susUrl(i), title: 'G' + i });
    store['u' + i] = { originalUrl: 'https://geri.example/' + i, title: 'G' + i };
  }
  const w4 = createBrowserWorld(allSus);
  w4.local.suspended = store;
  const sw4 = boot(w4);
  for (const fn of sw4.L.onInstalled) await fn();
  for (const fn of sw4.L.onCommand) await fn('toggle-suspend');
  await tick();
  const geri = [1, 2, 3, 4].filter((i) =>
    w4.updates.some((u) => u.id === i && u.url === 'https://geri.example/' + i));
  check('hepsi askidayken 4 sekmenin 4-u de geri yuklendi',
    geri.length === 4, 'geri yuklenen: ' + geri.join(','));
  check('geri yuklenen kayitlar storage-dan silindi',
    Object.keys(w4.local.suspended || {}).length === 0,
    JSON.stringify(Object.keys(w4.local.suspended || {})));

  const w5 = createBrowserWorld([
    { id: 1, index: 0, windowId: 1, active: true, highlighted: true, pinned: false,
      url: susUrl(1), title: 'G1' },
    { id: 2, index: 1, windowId: 1, active: false, highlighted: true, pinned: false,
      url: 'https://acik.example/', title: 'Acik' },
  ]);
  w5.local.suspended = { u1: { originalUrl: 'https://geri.example/1', title: 'G1' } };
  const sw5 = boot(w5);
  for (const fn of sw5.L.onInstalled) await fn();
  for (const fn of sw5.L.onCommand) await fn('toggle-suspend');
  await tick();
  check('karisik secimde acik sekme askiya alindi',
    w5.updates.some((u) => u.id === 2 && String(u.url).indexOf(SUSPEND_PREFIX) === 0),
    JSON.stringify(w5.updates));
  check('karisik secimde askidaki sekme geri YUKLENMEDI',
    !w5.updates.some((u) => u.id === 1), JSON.stringify(w5.updates));

  // ── 4. Pinned sekmeler manuel suspend edilebilmeli (2026-07-15 davranisi)
  console.log('\n-- Pinned sekme korumasi --');
  const w6 = createBrowserWorld([
    { id: 1, index: 0, windowId: 1, active: true, highlighted: true, pinned: true,
      url: 'https://pinli.example/', title: 'Pinli' },
  ]);
  const sw6 = boot(w6);
  for (const fn of sw6.L.onInstalled) await fn();
  for (const fn of sw6.L.onCommand) await fn('toggle-suspend');
  await tick();
  check('pinli sekme manuel suspend edilebiliyor',
    w6.updates.some((u) => String(u.url).indexOf(SUSPEND_PREFIX) === 0),
    JSON.stringify(w6.updates));
  check('suspend pinned durumuna dokunmadi',
    !w6.updates.some((u) => 'pinned' in u), JSON.stringify(w6.updates));

  // ── 5. Brave elden geçirmesinden taşınan düzeltmeler (13-10-2026)
  console.log('\n-- Brave düzeltmeleri (Zen portu) --');
  const msg = (swx, message, sender) => swx.L.onMessage[0](message, sender || {});

  // 5a) çift decode: % içeren URL bozulmamalı (kayıt yok -> URL parametresinden dışa aktarma)
  const pctUrl = SUSPEND_PREFIX + '?id=pct&url=' + encodeURIComponent('https://a.example/?q=100%25') +
    '&t=' + encodeURIComponent('50% off') + '&ts=1';
  const wD = createBrowserWorld([
    { id: 1, index: 0, windowId: 1, active: true, pinned: false, url: pctUrl, title: 'x' },
  ]);
  const swD = boot(wD);
  const exp = await msg(swD, { action: 'get-all-tabs-for-export' });
  check('% iceren URL ve baslik cift decode ile bozulmadi',
    exp.tabs && exp.tabs[0] && exp.tabs[0].url === 'https://a.example/?q=100%25' && exp.tabs[0].title === '50% off',
    JSON.stringify(exp));

  // 5b) yedek alarmı sıfırlanmıyor
  const wA = createBrowserWorld([{ id: 1, index: 0, windowId: 1, active: true, pinned: false, url: 'https://p.example/', title: 'P' }]);
  const swA = boot(wA);
  const preset = { periodInMinutes: 5, delayInMinutes: 5, marker: true };
  swA.alarms['tab-backup'] = preset;
  for (const fn of swA.L.onInstalled) await fn();
  await tick();
  check('yedek alarmi sifirlanmadi', swA.alarms['tab-backup'] === preset, JSON.stringify(swA.alarms['tab-backup']));

  // 5c) delete-backup timestamp ile
  wA.local.backups = [{ timestamp: 't2', tabCount: 0, tabs: [] }, { timestamp: 't1', tabCount: 0, tabs: [] }];
  await msg(swA, { action: 'delete-backup', timestamp: 't1' });
  check('delete-backup timestamp ile dogru yedegi sildi',
    wA.local.backups.length === 1 && wA.local.backups[0].timestamp === 't2',
    JSON.stringify(wA.local.backups.map((b) => b.timestamp)));

  // 5d) http(s) allowlist + gönderici doğrulama
  for (const bad of ['DATA:text/html,<b>x</b>', ' javascript:alert(1)', 'file:///c:/x', 'moz-extension://x/y.html', 'about:config']) {
    await msg(swA, { action: 'restore-tab', url: bad, asSuspended: false });
  }
  check('http(s) disi adresler restore-tab ile ACILMADI', wA.created.length === 0, JSON.stringify(wA.created));
  await msg(swA, { action: 'restore-tab', url: 'https://ok.example/', asSuspended: false });
  check('http(s) adres restore-tab ile acildi', wA.created.length === 1, JSON.stringify(wA.created));
  const foreign = await msg(swA, { action: 'get-backups' }, { id: 'baska-eklenti' });
  check('yabanci gondericinin mesaji reddedildi', Boolean(foreign && foreign.error), JSON.stringify(foreign));

  // 5e) çoğaltılmış sekme: ortak kayıt silinmez
  const wQ = createBrowserWorld([
    { id: 1, index: 0, windowId: 1, active: true, pinned: false,
      url: SUSPEND_PREFIX + '?id=shared&url=https%3A%2F%2Fq.example%2F&t=Q&ts=1', title: 'Q' },
    { id: 2, index: 1, windowId: 1, active: false, pinned: false,
      url: SUSPEND_PREFIX + '?id=shared&url=https%3A%2F%2Fq.example%2F&t=Q&ts=1', title: 'Q2' },
  ]);
  wQ.local.suspended = { shared: { originalUrl: 'https://q.example/', title: 'Q', suspendedAt: new Date().toISOString() } };
  const swQ = boot(wQ);
  for (const fn of swQ.L.onInstalled) await fn();
  await msg(swQ, { action: 'unsuspend' }, { tab: wQ.tabs[0] });
  check('cogaltilmis sekme geri yuklenince ortak kayit silinmedi',
    Boolean(wQ.local.suspended && wQ.local.suspended.shared), JSON.stringify(wQ.local.suspended));

  // 5f) restore sürerken (pendingUrl / loading) discard EDİLMEZ, bitince edilir
  const wR = createBrowserWorld([
    { id: 1, index: 0, windowId: 1, active: true, pinned: false, discarded: false, status: 'complete',
      url: SUSPEND_PREFIX + '?id=r&url=https%3A%2F%2Fr.example%2F&t=R&ts=1', title: 'R' },
    { id: 2, index: 1, windowId: 1, active: false, pinned: false, url: 'https://s.example/', title: 'S' },
  ]);
  const swR = boot(wR);
  for (const fn of swR.L.onInstalled) await fn();
  await tick();
  wR.tabs[0].active = false; wR.tabs[0].status = 'loading';
  wR.tabs[1].active = true;
  for (const fn of swR.L.tabActivated) await fn({ tabId: 2 });
  await settle();
  check('yuklenmekte olan (restore suren) sekme discard EDILMEDI', wR.discarded.indexOf(1) === -1, JSON.stringify(wR.discarded));

  const wR2 = createBrowserWorld([
    { id: 1, index: 0, windowId: 1, active: true, pinned: false, discarded: false, status: 'complete',
      url: SUSPEND_PREFIX + '?id=r2&url=https%3A%2F%2Fr.example%2F&t=R&ts=1', title: 'R' },
    { id: 2, index: 1, windowId: 1, active: false, pinned: false, url: 'https://s.example/', title: 'S' },
  ]);
  const swR2 = boot(wR2);
  for (const fn of swR2.L.onInstalled) await fn();
  await tick();
  await msg(swR2, { action: 'unsuspend' }, { tab: wR2.tabs[0] }); // restore baslar; stub URL'i hemen degistirmez
  wR2.tabs[0].url = SUSPEND_PREFIX + '?id=r2&url=https%3A%2F%2Fr.example%2F&t=R&ts=1'; // commit olmadi: hala suspend sayfasi
  wR2.tabs[0].active = false; wR2.tabs[1].active = true;
  for (const fn of swR2.L.tabActivated) await fn({ tabId: 2 });
  await settle();
  check('restore korumasi: commit oncesi sekme degisince discard EDILMEDI', wR2.discarded.indexOf(1) === -1, JSON.stringify(wR2.discarded));

  const wR3 = createBrowserWorld([
    { id: 1, index: 0, windowId: 1, active: true, pinned: false, discarded: false, status: 'complete',
      url: SUSPEND_PREFIX + '?id=r3&url=https%3A%2F%2Fr.example%2F&t=R&ts=1', title: 'R' },
    { id: 2, index: 1, windowId: 1, active: false, pinned: false, url: 'https://s.example/', title: 'S' },
  ]);
  const swR3 = boot(wR3);
  for (const fn of swR3.L.onInstalled) await fn();
  await tick();
  wR3.tabs[0].active = false; wR3.tabs[1].active = true;
  for (const fn of swR3.L.tabActivated) await fn({ tabId: 2 });
  await settle();
  check('normal durumda askidaki arka plan sekmesi discard edildi', wR3.discarded.indexOf(1) !== -1, JSON.stringify(wR3.discarded));

  // 5g) otomatik askıya alma: sesli sekme atlanır, hata turu kesmez
  const wT = createBrowserWorld([
    { id: 1, index: 0, windowId: 1, active: true, pinned: false, url: 'https://a.example/', title: 'A' },
    { id: 2, index: 1, windowId: 1, active: false, pinned: false, audible: true, url: 'https://ses.example/', title: 'Ses' },
    { id: 3, index: 2, windowId: 1, active: false, pinned: false, url: 'https://sessiz.example/', title: 'Sessiz' },
  ]);
  wT.local.autoSuspend = { enabled: true, thresholdMinutes: 0 };
  const swT = boot(wT);
  for (const fn of swT.L.onInstalled) await fn();
  await tick();
  for (const fn of swT.L.onAlarm) await fn({ name: 'auto-suspend-check' });
  await tick();
  check('sesli sekme otomatik askiya ALINMADI', !wT.updates.some((u) => u.id === 2), JSON.stringify(wT.updates));
  check('sessiz sekme otomatik askiya alindi', wT.updates.some((u) => u.id === 3), JSON.stringify(wT.updates));

  // 5h) gizli sekme askiya alinmaz
  const wI = createBrowserWorld([
    { id: 1, index: 0, windowId: 1, active: true, pinned: false, incognito: true, url: 'https://gizli.example/', title: 'Gizli' },
  ]);
  const swI = boot(wI);
  for (const fn of swI.L.onInstalled) await fn();
  const rI = await msg(swI, { action: 'suspend-active' });
  check('gizli sekme askiya ALINMADI', Boolean(rI && rI.error) && wI.updates.length === 0, JSON.stringify([rI, wI.updates]));

  console.log('\n' + (fail === 0
    ? 'TUM TESTLER GECTI (' + pass + ')'
    : fail + ' TEST BASARISIZ (' + pass + ' gecti)'));
  process.exit(fail === 0 ? 0 : 1);
})();

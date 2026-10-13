/**
 * Service worker yeniden baslatma testi.
 *
 * Bu portun 1 numarali riski: Chromium background service worker'i ~30 sn
 * bostan sonra oldurur, uyaninca top-level kod BASTAN calisir (modul
 * degiskenleri sifirlanir) ama onInstalled/onStartup TEKRAR FIRE ETMEZ.
 *
 * Test bunu birebir taklit ediyor: ayni kalici storage ile ikinci bir vm
 * realm'inde background.js'i tekrar yukluyor ve SADECE alarm'i tetikliyor.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'background.js'), 'utf8');
const MSGS = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', '_locales', 'en', 'messages.json'), 'utf8'));
const EXT_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/';
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

const tick = () => new Promise((r) => setTimeout(r, 30));
// FAVICON_PERSIST_GRACE_MS (350ms) + pay: discard yolunun gercekten
// tamamlanmasini bekler. Kisa tick ile olcmek "discard edilmedi" turu
// kontrolleri sahte-gecirir.
const settle = () => new Promise((r) => setTimeout(r, 700));

/** Tarayici tarafi: SW restart'lari boyunca YASAYAN durum. */
function createBrowserWorld(tabs) {
  return {
    local: {},
    session: {}, // gercekte de tarayici kapanana kadar yasar
    tabs,
    updates: [],
    created: [],
    discarded: [],
    menus: {},
  };
}

/**
 * Her "SW basladi" olayinda taze listener tablosu + taze modul scope'u.
 * opts.favicon: true -> favicon boru hatti (fetch/bitmap/canvas) gercekci bir
 * gecikmeyle BASARILI olur; toplu suspend'deki storage yarisini gorunur kilar.
 */
/** Test yardimcilari: kayitlar `s:<uuid>` anahtarlarinda. */
function seedSuspended(world, map) {
  for (const [uuid, entry] of Object.entries(map)) world.local['s:' + uuid] = entry;
}
function readSuspended(world) {
  const out = {};
  for (const [k, v] of Object.entries(world.local)) if (k.indexOf('s:') === 0) out[k.slice(2)] = v;
  return out;
}

function bootServiceWorker(world, opts) {
  const L = {
    onInstalled: [], onStartup: [], onMessage: [], onAlarm: [], onCommand: [],
    tabActivated: [], tabUpdated: [], tabMoved: [], tabCreated: [], tabRemoved: [],
    tabReplaced: [],
    menuClicked: [],
  };
  const ioLatency = (opts && opts.storageLatency)
    ? () => new Promise((r) => setTimeout(r, opts.storageLatency))
    : () => Promise.resolve();
  const ev = (arr) => ({
    addListener: (fn) => arr.push(fn),
    removeListener: (fn) => {
      const i = arr.indexOf(fn);
      if (i !== -1) arr.splice(i, 1);
    },
  });
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const alarms = {};

  const chrome = {
    i18n: { getMessage: (k) => (MSGS[k] || {}).message || k },
    runtime: {
      getURL: (p) => EXT_ORIGIN + String(p).replace(/^\//, ''),
      onInstalled: ev(L.onInstalled),
      onStartup: ev(L.onStartup),
      onMessage: ev(L.onMessage),
    },
    storage: {
      // chrome.storage.local gercekte IPC uzerinden async. Gecikmesiz bir stub,
      // read-modify-write yarislarini yapay olarak serilestirip gizler.
      local: {
        get: async (key) => {
          await ioLatency();
          if (key === null || key === undefined) return clone(world.local);
          const keys = Array.isArray(key) ? key : [key];
          const out = {};
          for (const k of keys) if (k in world.local) out[k] = clone(world.local[k]);
          return out;
        },
        set: async (obj) => {
          await ioLatency();
          Object.assign(world.local, clone(obj));
        },
        remove: async (key) => {
          await ioLatency();
          for (const k of (Array.isArray(key) ? key : [key])) delete world.local[k];
        },
      },
      session: {
        get: async (key) => (key in world.session ? { [key]: clone(world.session[key]) } : {}),
        set: async (obj) => { Object.assign(world.session, clone(obj)); },
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
    action: { openPopup: async () => { throw new Error('no gesture'); } },
    contextMenus: {
      removeAll: async () => { world.menus = {}; },
      create: (o) => { world.menus[o.id] = Object.assign({}, o); },
      update: async (id, patch) => {
        if (!world.menus[id]) throw new Error('no such menu item');
        Object.assign(world.menus[id], patch);
      },
      onClicked: ev(L.menuClicked),
    },
    tabs: {
      query: async (q) => {
        const f = q || {};
        return world.tabs.filter((t) =>
          (f.windowId === undefined || t.windowId === f.windowId) &&
          (f.active === undefined || t.active === f.active) &&
          (f.highlighted === undefined || Boolean(t.highlighted) === f.highlighted)
        ).map((t) => ({ status: 'complete', ...clone(t) }));
      },
      get: async (id) => {
        const t = world.tabs.find((x) => x.id === id);
        if (!t) throw new Error('No tab with id ' + id);
        return { status: 'complete', ...clone(t) };
      },
      update: async (id, props) => {
        world.updates.push(Object.assign({ id: id }, props));
        const t = world.tabs.find((x) => x.id === id);
        if (!t) return null;

        // Gercek navigasyon async: tabs.update hemen doner, URL sonra degisir
        // ve onUpdated(status:"complete") daha da sonra gelir. Senkron stub
        // bu araligi yok edip zamanlama hatalarini gizler.
        if (opts && opts.asyncNav && props.url) {
          const snapshot = clone(t);
          setTimeout(() => {
            Object.assign(t, props);
            for (const fn of L.tabUpdated.slice()) {
              fn(id, { status: 'complete', url: props.url }, clone(t));
            }
          }, opts.asyncNav);
          return snapshot;
        }

        Object.assign(t, props);
        return clone(t);
      },
      create: async (props) => { world.created.push(props); return Object.assign({ id: 999 }, props); },
      discard: async (id) => { world.discarded.push(id); },
      onActivated: ev(L.tabActivated),
      onUpdated: ev(L.tabUpdated),
      onMoved: ev(L.tabMoved),
      onCreated: ev(L.tabCreated),
      onRemoved: ev(L.tabRemoved),
      onReplaced: ev(L.tabReplaced),
    },
  };

  // Ag/canvas yok: greyscale favicon yolu bilerek basarisiz olur, kod
  // duz pause ikonuna dusmelidir - suspend akisi bundan etkilenmemeli.
  const sandbox = {
    chrome: chrome,
    console: console,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    Promise: Promise, Date: Date, Math: Math, JSON: JSON,
    Object: Object, Array: Array, Set: Set, Map: Map,
    String: String, Number: Number, Boolean: Boolean, Error: Error,
    URL: URL, URLSearchParams: URLSearchParams, crypto: crypto,
    btoa: btoa, Uint8Array: Uint8Array, TextEncoder: TextEncoder,
    RegExp: RegExp,
    fetch: async () => { throw new Error('offline in test'); },
    createImageBitmap: async () => { throw new Error('offline in test'); },
    OffscreenCanvas: function () { throw new Error('offline in test'); },
  };

  if (opts && opts.favicon) {
    const delay = (ms) => new Promise((r) => setTimeout(r, ms));
    const noop = () => {};
    sandbox.Blob = Blob;
    sandbox.fetch = async () => {
      await delay(40); // gercek bir ag/onbellek okumasi gibi
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
  }
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'background.js' });

  return { L: L, chrome: chrome, alarms: alarms };
}

(async () => {
  console.log('\n-- Service worker restart --');

  const world = createBrowserWorld([
    { id: 1, index: 0, windowId: 1, active: true, pinned: false, url: 'https://a.example/', title: 'A' },
    { id: 2, index: 1, windowId: 1, active: false, pinned: false, url: 'https://b.example/', title: 'B' },
  ]);
  world.local.autoSuspend = { enabled: true, thresholdMinutes: 15 };

  let sw = bootServiceWorker(world);
  for (const fn of sw.L.onInstalled) await fn();
  await tick();

  check('ilk acilis lastActive kaydediyor',
    Object.keys((world.session.tabState || {}).lastActive || {}).length === 2,
    JSON.stringify(world.session.tabState));
  check('otomatik suspend alarmi kuruldu', Boolean(sw.alarms['auto-suspend-check']));
  check('context menusu kuruldu (5 giris)', Object.keys(world.menus).length === 5,
    Object.keys(world.menus).join(','));
  check('menuler "tab" context KULLANMIYOR',
    !Object.values(world.menus).some((m) => (m.contexts || []).indexOf('tab') !== -1));

  // Zamanin gecmesi: 2 nolu sekme 20 dakikadir bosta
  world.session.tabState.lastActive['2'] = Date.now() - 20 * 60 * 1000;
  const staleBefore = world.session.tabState.lastActive['2'];

  // ── SW olduruldu, yeniden basladi. onInstalled/onStartup FIRE ETMEZ.
  sw = bootServiceWorker(world);
  for (const fn of sw.L.onAlarm) await fn({ name: 'auto-suspend-check' });
  await tick();

  check('restart sonrasi lastActive EZILMEDI',
    world.session.tabState.lastActive['2'] === staleBefore,
    'simdi: ' + world.session.tabState.lastActive['2']);

  const suspendedTwo = world.updates.find((u) =>
    u.id === 2 && typeof u.url === 'string' && u.url.indexOf(SUSPEND_PREFIX) === 0);
  check('restart sonrasi otomatik suspend CALISTI (asil risk)',
    Boolean(suspendedTwo), JSON.stringify(world.updates));

  check('aktif sekme (1) suspend EDILMEDI',
    !world.updates.some((u) => u.id === 1), JSON.stringify(world.updates));

  // ── Mesaj sozlesmesi: Chromium sendResponse yolu
  console.log('\n-- Mesaj sozlesmesi --');
  const swMsg = bootServiceWorker(world);
  const listener = swMsg.L.onMessage[0];
  let responded;
  const rv = listener({ action: 'get-suspended-list' }, {}, (r) => { responded = r; });
  check('onMessage kanali acik tutmak icin literal true donuyor', rv === true, String(rv));
  await tick();
  check('sendResponse gercekten cagrildi',
    responded !== undefined && Object.prototype.hasOwnProperty.call(responded || {}, 'suspended'),
    JSON.stringify(responded));

  // ── Menu etiketi: onShown olmadan onden guncelleme
  console.log('\n-- Menu etiketi (onShown yok) --');
  const world2 = createBrowserWorld([
    { id: 1, index: 0, windowId: 1, active: true, pinned: false,
      url: SUSPEND_PREFIX + '?id=x&url=https%3A%2F%2Fa.example%2F&t=A&ts=1', title: 'A' },
  ]);
  const sw2 = bootServiceWorker(world2);
  for (const fn of sw2.L.onInstalled) await fn();
  await tick();
  check('askidaki aktif sekmede etiket "Geri Yukle"',
    /Restore/.test((world2.menus['toggle-suspend'] || {}).title || ''),
    (world2.menus['toggle-suspend'] || {}).title);

  world2.tabs[0].url = 'https://a.example/';
  for (const fn of sw2.L.tabActivated) await fn({ tabId: 1 });
  await tick();
  check('normal sekmeye gecince etiket "Askiya Al"',
    /Suspend/.test((world2.menus['toggle-suspend'] || {}).title || ''),
    (world2.menus['toggle-suspend'] || {}).title);

  // ── Kendi suspend sayfamiz "engelli sema" sanilmamali
  console.log('\n-- chrome-extension: sema catismasi --');
  const world3 = createBrowserWorld([
    { id: 1, index: 0, windowId: 1, active: true, pinned: false, highlighted: true,
      url: SUSPEND_PREFIX + '?id=y&url=https%3A%2F%2Fc.example%2F&t=C&ts=1', title: 'C' },
  ]);
  seedSuspended(world3, { y: { originalUrl: 'https://c.example/', title: 'C' } });
  const sw3 = bootServiceWorker(world3);
  for (const fn of sw3.L.onInstalled) await fn();
  for (const fn of sw3.L.onCommand) await fn('toggle-suspend');
  await tick();
  check('askidaki sekme geri yuklenebiliyor',
    world3.updates.some((u) => u.url === 'https://c.example/'),
    JSON.stringify(world3.updates));

  // ── RAM bosaltma: SW restart sonrasi discard tekrari
  console.log('\n-- Restart sonrasi discard tekrari --');
  const world5 = createBrowserWorld([
    { id: 1, index: 0, windowId: 1, active: true, pinned: false, discarded: false,
      url: SUSPEND_PREFIX + '?id=z&url=https%3A%2F%2Fe.example%2F&t=E&ts=1', title: 'E' },
    { id: 2, index: 1, windowId: 1, active: false, pinned: false, url: 'https://f.example/', title: 'F' },
  ]);
  const sw5a = bootServiceWorker(world5);
  for (const fn of sw5a.L.onInstalled) await fn();
  await tick();
  check('askidaki sekme aktifken activeTabId=1', world5.session.tabState.activeTabId === 1,
    String(world5.session.tabState.activeTabId));

  // SW olduruldu. Kullanici 2 nolu sekmeye geciyor -> 1 artik arka planda,
  // discard tekrari burada tetiklenmeli (Firefox aktif sekmeyi discard etmiyordu).
  const sw5b = bootServiceWorker(world5);
  world5.tabs[0].active = false;
  world5.tabs[1].active = true;
  for (const fn of sw5b.L.tabActivated) await fn({ tabId: 2 });
  await tick();
  check('restart sonrasi eski aktif sekme icin discard tekrari tetiklendi',
    world5.discarded.indexOf(1) !== -1, JSON.stringify(world5.discarded));

  // ── onReplaced: tab id degisirse state yeniden anahtarlanmali
  console.log('\n-- tabs.onReplaced yeniden anahtarlama --');
  const sw6 = bootServiceWorker(world5);
  for (const fn of sw6.L.tabReplaced) await fn(77, 1);
  await tick();
  check('URL kaydi yeni tabId-ye tasindi',
    typeof world5.session.tabState.urls['77'] === 'string' &&
    world5.session.tabState.urls['1'] === undefined,
    JSON.stringify(world5.session.tabState.urls));

  // ── Aktif sekme discard EDILMEMELI (bos ekran regresyonu)
  console.log('\n-- Aktif sekmede bos ekran regresyonu --');
  const world7 = createBrowserWorld([
    { id: 1, index: 0, windowId: 1, active: true, pinned: false, highlighted: true,
      discarded: false, url: 'https://g.example/', title: 'G' },
    { id: 2, index: 1, windowId: 1, active: false, pinned: false, url: 'https://h.example/', title: 'H' },
  ]);
  const sw7 = bootServiceWorker(world7);
  for (const fn of sw7.L.onInstalled) await fn();
  for (const fn of sw7.L.onCommand) await fn('toggle-suspend');
  await tick();
  // Sekme suspend sayfasini yukledi. Discard yolu FAVICON_PERSIST_GRACE_MS
  // (350ms) bekliyor - kisa bir tick ile olcersek "discard edilmedi" kontrolu
  // sahte gecerdi, o yuzden tam olarak bekliyoruz.
  for (const fn of sw7.L.tabUpdated) await fn(1, { status: 'complete' }, world7.tabs[0]);
  await settle();

  check('aktif sekme suspend oldu', world7.tabs[0].url.indexOf(SUSPEND_PREFIX) === 0,
    world7.tabs[0].url);
  check('AKTIF sekme discard EDILMEDI (bos ekran olusmaz)',
    world7.discarded.indexOf(1) === -1, JSON.stringify(world7.discarded));

  // Kullanici baska sekmeye geciyor -> RAM simdi bosalmali
  world7.tabs[0].active = false;
  world7.tabs[1].active = true;
  for (const fn of sw7.L.tabActivated) await fn({ tabId: 2 });
  await settle();
  check('sekmeden uzaklasinca discard tetiklendi (RAM bosalir)',
    world7.discarded.indexOf(1) !== -1, JSON.stringify(world7.discarded));

  // ── Restore suruyorken discard EDILMEMELI (restore + hizli sekme degisimi)
  console.log('\n-- Restore sirasinda discard korumasi --');
  const worldR = createBrowserWorld([
    { id: 1, index: 0, windowId: 1, active: false, pinned: false, discarded: false,
      url: SUSPEND_PREFIX + '?id=r&url=https%3A%2F%2Fr.example%2F&t=R&ts=1', title: 'R',
      pendingUrl: 'https://r.example/' },
    { id: 2, index: 1, windowId: 1, active: true, pinned: false, url: 'https://s.example/', title: 'S' },
  ]);
  const swR = bootServiceWorker(worldR);
  for (const fn of swR.L.tabActivated) await fn({ tabId: 2 });
  await settle();
  check('pendingUrl baska sayfaya giderken discard EDILMEDI',
    worldR.discarded.indexOf(1) === -1, JSON.stringify(worldR.discarded));

  delete worldR.tabs[0].pendingUrl;
  for (const fn of swR.L.tabActivated) await fn({ tabId: 2 });
  await settle();
  check('bekleyen navigasyon yoksa askidaki arka plan sekmesi discard edildi',
    worldR.discarded.indexOf(1) !== -1, JSON.stringify(worldR.discarded));

  // ── Faz 2: yedek alarmi, timestamp ile silme, ortak uuid, uyuyan SW'de kapanan sekme
  console.log('\n-- Faz 2 --');
  const worldP = createBrowserWorld([
    { id: 1, index: 0, windowId: 1, active: true, pinned: false, url: 'https://p.example/', title: 'P' },
  ]);
  const swP = bootServiceWorker(worldP);
  const preset = { periodInMinutes: 5, delayInMinutes: 5, marker: true };
  swP.alarms['tab-backup'] = preset;
  for (const fn of swP.L.onInstalled) await fn();
  await tick();
  check('yedek alarmi service worker uyaninca SIFIRLANMADI',
    swP.alarms['tab-backup'] === preset, JSON.stringify(swP.alarms['tab-backup']));

  worldP.local.backups = [
    { timestamp: 't2', tabCount: 0, tabs: [] },
    { timestamp: 't1', tabCount: 0, tabs: [] },
  ];
  const delListener = swP.L.onMessage[0];
  await new Promise((resolve) => delListener({ action: 'delete-backup', timestamp: 't1' }, {}, resolve));
  check('delete-backup timestamp ile dogru yedegi sildi',
    worldP.local.backups.length === 1 && worldP.local.backups[0].timestamp === 't2',
    JSON.stringify(worldP.local.backups.map((b) => b.timestamp)));

  const worldQ = createBrowserWorld([
    { id: 1, index: 0, windowId: 1, active: true, pinned: false,
      url: SUSPEND_PREFIX + '?id=shared&url=https%3A%2F%2Fq.example%2F&t=Q&ts=1', title: 'Q' },
    { id: 2, index: 1, windowId: 1, active: false, pinned: false,
      url: SUSPEND_PREFIX + '?id=shared&url=https%3A%2F%2Fq.example%2F&t=Q&ts=1', title: 'Q2' },
  ]);
  seedSuspended(worldQ, { shared: { originalUrl: 'https://q.example/', title: 'Q', suspendedAt: new Date().toISOString() } });
  const swQ = bootServiceWorker(worldQ);
  for (const fn of swQ.L.onInstalled) await fn();
  await new Promise((resolve) => swQ.L.onMessage[0]({ action: 'unsuspend' }, { tab: worldQ.tabs[0] }, resolve));
  check('cogaltilmis sekme geri yuklenince ortak kayit silinmedi',
    Boolean(readSuspended(worldQ).shared),
    JSON.stringify(readSuspended(worldQ)));

  const worldS = createBrowserWorld([
    { id: 1, index: 0, windowId: 1, active: false, pinned: false,
      url: SUSPEND_PREFIX + '?id=sleepy&url=https%3A%2F%2Fs.example%2F&t=S&ts=1', title: 'S' },
    { id: 2, index: 1, windowId: 1, active: true, pinned: false, url: 'https://t.example/', title: 'T' },
  ]);
  seedSuspended(worldS, { sleepy: { originalUrl: 'https://s.example/', title: 'S', suspendedAt: new Date().toISOString() } });
  const swS1 = bootServiceWorker(worldS);
  for (const fn of swS1.L.onInstalled) await fn();
  await tick();
  // SW uyurken sekme 1 kapaniyor; olay yeni SW ornegini uyandiriyor
  worldS.tabs = worldS.tabs.filter((t) => t.id !== 1);
  const swS2 = bootServiceWorker(worldS);
  for (const fn of swS2.L.tabRemoved) await fn(1, { isWindowClosing: false, windowId: 1 });
  await tick();
  check('uyuyan SW uyaninca kapanan askidaki sekmenin kaydi silindi',
    !readSuspended(worldS).sleepy,
    JSON.stringify(readSuspended(worldS)));

  // ── Faz 3: URL allowlist ve gonderici dogrulama
  console.log('\n-- Faz 3 --');
  const worldU = createBrowserWorld([
    { id: 1, index: 0, windowId: 1, active: true, pinned: false, url: 'https://u.example/', title: 'U' },
  ]);
  const swU = bootServiceWorker(worldU);
  const send3 = (msg, sender) => new Promise((resolve) => swU.L.onMessage[0](msg, sender || {}, resolve));
  for (const bad of ['DATA:text/html,<b>x</b>', ' javascript:alert(1)', 'file:///c:/x', 'chrome-extension://x/y.html', 'brave://settings']) {
    await send3({ action: 'restore-tab', url: bad, asSuspended: false });
  }
  check('http(s) disi adresler restore-tab ile ACILMADI', worldU.created.length === 0, JSON.stringify(worldU.created));
  await send3({ action: 'restore-tab', url: 'https://ok.example/', asSuspended: false });
  check('http(s) adres restore-tab ile acildi', worldU.created.length === 1, JSON.stringify(worldU.created));
  const foreign = await send3({ action: 'get-suspended-list' }, { id: 'baska-eklenti' });
  check('yabanci gondericinin mesaji reddedildi', Boolean(foreign && foreign.error), JSON.stringify(foreign));
  const blockedSuspend = await new Promise((resolve) => swU.L.onMessage[0]({ action: 'suspend-active' }, {}, resolve));
  check('http(s) sekme suspend edilebiliyor (allowlist yanlis engellemiyor)', blockedSuspend && blockedSuspend.success === true,
    JSON.stringify(blockedSuspend));

  // ── Faz 4: depolama migrasyonu (blob -> sekme basina anahtar)
  console.log('\n-- Depolama migrasyonu --');
  const worldM = createBrowserWorld([
    { id: 1, index: 0, windowId: 1, active: true, pinned: false, url: 'https://m.example/', title: 'M' },
  ]);
  const bigData = 'data:image/png;base64,' + 'A'.repeat(5000);
  worldM.local.suspended = {
    old1: { originalUrl: 'https://old1.example/', title: 'Old1', favIconUrl: bigData, greyFavIconUrl: 'data:image/png;base64,AAAA', suspendedAt: '2026-01-01T00:00:00.000Z' },
    old2: { originalUrl: 'https://old2.example/', title: 'Old2', favIconUrl: 'https://old2.example/f.ico', suspendedAt: '2026-01-01T00:00:00.000Z' },
  };
  worldM.local.backups = [{ timestamp: 'b1', tabCount: 1, tabs: [{ url: 'https://x.example/', title: 'X', favIconUrl: bigData, suspended: false }] }];
  const swM = bootServiceWorker(worldM);
  for (const fn of swM.L.onInstalled) await fn();
  await tick();
  const migrated = readSuspended(worldM);
  check('eski blob silindi', worldM.local.suspended === undefined, JSON.stringify(Object.keys(worldM.local)));
  check('kayitlar sekme basina anahtara tasindi', Object.keys(migrated).sort().join() === 'old1,old2', JSON.stringify(Object.keys(migrated)));
  check('gri ikon korundu', migrated.old1 && migrated.old1.greyFavIconUrl === 'data:image/png;base64,AAAA', JSON.stringify(migrated.old1 && Object.keys(migrated.old1)));
  check('buyuk data: ikon kayittan atildi, kisa http(s) korundu',
    migrated.old1.favIconUrl === '' && migrated.old2.favIconUrl === 'https://old2.example/f.ico',
    JSON.stringify([migrated.old1.favIconUrl.length, migrated.old2.favIconUrl]));
  check('yedeklerdeki buyuk data: ikon atildi', worldM.local.backups[0].tabs[0].favIconUrl === '', String(worldM.local.backups[0].tabs[0].favIconUrl.length));
  check('storageVersion yazildi', worldM.local.storageVersion === 2, String(worldM.local.storageVersion));
  const swM2 = bootServiceWorker(worldM);
  for (const fn of swM2.L.onInstalled) await fn();
  await tick();
  check('ikinci acilista migrasyon tekrar etmedi (idempotent)', Object.keys(readSuspended(worldM)).length === 2, JSON.stringify(Object.keys(readSuspended(worldM))));

  // ── Toplu suspend: `suspended` blob'unda kayip-guncelleme yarisi
  // Kullanicinin yaptigi senaryo: tab bar'da shift ile hepsini sec + Alt+Shift+S.
  console.log('\n-- Toplu suspend (12 sekme) --');
  const N = 12;
  const manyTabs = [];
  for (let i = 1; i <= N; i++) {
    manyTabs.push({
      id: i, index: i - 1, windowId: 1, active: i === 1, highlighted: true,
      pinned: false, discarded: false,
      url: 'https://same.example/page' + i,
      title: 'Sayfa ' + i,
      favIconUrl: 'https://same.example/favicon.ico',
    });
  }
  const world8 = createBrowserWorld(manyTabs);
  const sw8 = bootServiceWorker(world8, { favicon: true, storageLatency: 5, asyncNav: 25 });
  for (const fn of sw8.L.onInstalled) await fn();
  for (const fn of sw8.L.onCommand) await fn('toggle-suspend');
  await settle();
  await settle();

  const stored = readSuspended(world8);
  const uuids = Object.keys(stored);
  check(N + ' sekmenin HEPSI `suspended` blobunda',
    uuids.length === N, uuids.length + '/' + N + ' kayit kaldi');

  const withGrey = uuids.filter((u) => stored[u].greyFavIconUrl);
  check('HEPSININ greyscale favicon-u yazildi (ikon tutarliligi)',
    withGrey.length === N, withGrey.length + '/' + N + ' ikon yazildi');

  // ── Storage kaydi eksikse bile geri yukleme URL parametresinden calismali
  console.log('\n-- Kayit eksik: URL parametresinden geri yukleme --');
  const lostUrl = SUSPEND_PREFIX + '?id=lost&url=' +
    encodeURIComponent('https://kayip.example/makale') + '&t=Kayip&ts=1';
  const world9 = createBrowserWorld([
    { id: 1, index: 0, windowId: 1, active: true, pinned: false, highlighted: true,
      url: lostUrl, title: 'Kayip' },
  ]);
  // kayit YOK (hic seed edilmedi)
  const sw9 = bootServiceWorker(world9);
  for (const fn of sw9.L.onInstalled) await fn();
  for (const fn of sw9.L.onCommand) await fn('toggle-suspend');
  await tick();
  check('kayit eksikken bos sayfa DEGIL, dogru URL aciliyor',
    world9.updates.some((u) => u.url === 'https://kayip.example/makale'),
    JSON.stringify(world9.updates));
  check('about:newtab-e dusulmedi',
    !world9.updates.some((u) => u.url === 'about:newtab'),
    JSON.stringify(world9.updates));

  // Kotu niyetli/bozuk parametre kendi suspend sayfamiza dongu yapmamali
  const loopUrl = SUSPEND_PREFIX + '?id=loop&url=' + encodeURIComponent(SUSPEND_PREFIX + '?id=x') + '&t=L&ts=1';
  const world10 = createBrowserWorld([
    { id: 1, index: 0, windowId: 1, active: true, pinned: false, highlighted: true,
      url: loopUrl, title: 'L' },
  ]);
  const sw10 = bootServiceWorker(world10);
  for (const fn of sw10.L.onInstalled) await fn();
  for (const fn of sw10.L.onCommand) await fn('toggle-suspend');
  await tick();
  check('suspend sayfasina geri donme dongusu reddedildi',
    world10.updates.every((u) => String(u.url || '').indexOf(SUSPEND_PREFIX) !== 0),
    JSON.stringify(world10.updates));

  // ── Coklu secimde toplu geri yukleme
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
  const world11 = createBrowserWorld(allSus);
  seedSuspended(world11, store);
  const sw11 = bootServiceWorker(world11);
  for (const fn of sw11.L.onInstalled) await fn();
  for (const fn of sw11.L.onCommand) await fn('toggle-suspend');
  await tick();

  const geri = [1, 2, 3, 4].filter((i) =>
    world11.updates.some((u) => u.id === i && u.url === 'https://geri.example/' + i));
  check('hepsi askidayken 4 sekmenin 4-u de geri yuklendi',
    geri.length === 4, 'geri yuklenen: ' + geri.join(','));
  check('geri yuklenen kayitlar storage-dan silindi',
    Object.keys(readSuspended(world11)).length === 0,
    JSON.stringify(Object.keys(readSuspended(world11))));

  // Karisik secim: suspend yonu secilmeli, askidakilere DOKUNULMAMALI
  const mixed = [
    { id: 1, index: 0, windowId: 1, active: true, highlighted: true, pinned: false,
      url: susUrl(1), title: 'G1' },
    { id: 2, index: 1, windowId: 1, active: false, highlighted: true, pinned: false,
      url: 'https://acik.example/', title: 'Acik' },
  ];
  const world12 = createBrowserWorld(mixed);
  seedSuspended(world12, { u1: { originalUrl: 'https://geri.example/1', title: 'G1' } });
  const sw12 = bootServiceWorker(world12);
  for (const fn of sw12.L.onInstalled) await fn();
  for (const fn of sw12.L.onCommand) await fn('toggle-suspend');
  await tick();
  check('karisik secimde acik sekme askiya alindi',
    world12.updates.some((u) => u.id === 2 && String(u.url).indexOf(SUSPEND_PREFIX) === 0),
    JSON.stringify(world12.updates));
  check('karisik secimde askidaki sekme geri YUKLENMEDI',
    !world12.updates.some((u) => u.id === 1),
    JSON.stringify(world12.updates));

  // ── Suspend, greyscale favicon uretimi basarisiz olsa bile calismali
  console.log('\n-- Favicon uretimi basarisiz (offline) --');
  const world4 = createBrowserWorld([
    { id: 1, index: 0, windowId: 1, active: true, pinned: false, highlighted: true,
      url: 'https://d.example/', title: 'D', favIconUrl: 'https://d.example/f.ico' },
  ]);
  const sw4 = bootServiceWorker(world4);
  for (const fn of sw4.L.onInstalled) await fn();
  for (const fn of sw4.L.onCommand) await fn('toggle-suspend');
  await tick();
  check('favicon uretilemese de suspend oldu',
    world4.updates.some((u) => typeof u.url === 'string' && u.url.indexOf(SUSPEND_PREFIX) === 0),
    JSON.stringify(world4.updates));

  console.log('\n' + (fail === 0
    ? 'TUM TESTLER GECTI (' + pass + ')'
    : fail + ' TEST BASARISIZ (' + pass + ' gecti)'));
  process.exit(fail === 0 ? 0 : 1);
})();

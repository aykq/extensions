/**
 * Service worker restart tests for the Chromium build.
 *
 * Chromium stops an idle background service worker and later reruns the whole script, but onInstalled and
 * onStartup do not fire again. Each restart here loads background.js into a fresh vm realm that shares
 * the same persistent storage and then fires only an alarm or a tab event.
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
// Long enough for the discard path to finish (FAVICON_PERSIST_GRACE_MS is 350 ms).
// A short tick would let "was not discarded" checks pass for the wrong reason.
const settle = () => new Promise((r) => setTimeout(r, 700));

function createBrowserWorld(tabs) {
  return {
    local: {},
    session: {},
    tabs,
    updates: [],
    created: [],
    discarded: [],
    menus: {},
  };
}

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
      local: {
        get: async (key) => {
          // storage.local is async over IPC in a real browser. A stub without latency serializes read-modify-write races and hides them.
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

        // Real navigation is async: tabs.update returns first, the URL changes later and onUpdated(complete) later still.
        // A synchronous stub would hide timing bugs.
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

  check('first start records lastActive',
    Object.keys((world.session.tabState || {}).lastActive || {}).length === 2,
    JSON.stringify(world.session.tabState));
  check('auto-suspend alarm is created', Boolean(sw.alarms['auto-suspend-check']));
  check('context menu is created (5 entries)', Object.keys(world.menus).length === 5,
    Object.keys(world.menus).join(','));
  check('menus do NOT use the "tab" context',
    !Object.values(world.menus).some((m) => (m.contexts || []).indexOf('tab') !== -1));

  world.session.tabState.lastActive['2'] = Date.now() - 20 * 60 * 1000;
  const staleBefore = world.session.tabState.lastActive['2'];

  sw = bootServiceWorker(world);
  for (const fn of sw.L.onAlarm) await fn({ name: 'auto-suspend-check' });
  await tick();

  check('lastActive is NOT overwritten after a restart',
    world.session.tabState.lastActive['2'] === staleBefore,
    'simdi: ' + world.session.tabState.lastActive['2']);

  const suspendedTwo = world.updates.find((u) =>
    u.id === 2 && typeof u.url === 'string' && u.url.indexOf(SUSPEND_PREFIX) === 0);
  check('auto-suspend still works after a restart (the main risk)',
    Boolean(suspendedTwo), JSON.stringify(world.updates));

  check('the active tab (1) is NOT suspended',
    !world.updates.some((u) => u.id === 1), JSON.stringify(world.updates));

  console.log('\n-- Message contract --');
  const swMsg = bootServiceWorker(world);
  const listener = swMsg.L.onMessage[0];
  let responded;
  const rv = listener({ action: 'get-suspended-list' }, {}, (r) => { responded = r; });
  check('onMessage returns a literal true to keep the channel open', rv === true, String(rv));
  await tick();
  check('sendResponse was actually called',
    responded !== undefined && Object.prototype.hasOwnProperty.call(responded || {}, 'suspended'),
    JSON.stringify(responded));

  console.log('\n-- Menu label (no onShown) --');
  const world2 = createBrowserWorld([
    { id: 1, index: 0, windowId: 1, active: true, pinned: false,
      url: SUSPEND_PREFIX + '?id=x&url=https%3A%2F%2Fa.example%2F&t=A&ts=1', title: 'A' },
  ]);
  const sw2 = bootServiceWorker(world2);
  for (const fn of sw2.L.onInstalled) await fn();
  await tick();
  check('label reads "Restore" on a suspended active tab',
    /Restore/.test((world2.menus['toggle-suspend'] || {}).title || ''),
    (world2.menus['toggle-suspend'] || {}).title);

  world2.tabs[0].url = 'https://a.example/';
  for (const fn of sw2.L.tabActivated) await fn({ tabId: 1 });
  await tick();
  check('label reads "Suspend" after switching to a normal tab',
    /Suspend/.test((world2.menus['toggle-suspend'] || {}).title || ''),
    (world2.menus['toggle-suspend'] || {}).title);

  console.log('\n-- chrome-extension: scheme clash --');
  const world3 = createBrowserWorld([
    { id: 1, index: 0, windowId: 1, active: true, pinned: false, highlighted: true,
      url: SUSPEND_PREFIX + '?id=y&url=https%3A%2F%2Fc.example%2F&t=C&ts=1', title: 'C' },
  ]);
  seedSuspended(world3, { y: { originalUrl: 'https://c.example/', title: 'C' } });
  const sw3 = bootServiceWorker(world3);
  for (const fn of sw3.L.onInstalled) await fn();
  for (const fn of sw3.L.onCommand) await fn('toggle-suspend');
  await tick();
  check('a suspended tab can be restored',
    world3.updates.some((u) => u.url === 'https://c.example/'),
    JSON.stringify(world3.updates));

  console.log('\n-- Discard retry after restart --');
  const world5 = createBrowserWorld([
    { id: 1, index: 0, windowId: 1, active: true, pinned: false, discarded: false,
      url: SUSPEND_PREFIX + '?id=z&url=https%3A%2F%2Fe.example%2F&t=E&ts=1', title: 'E' },
    { id: 2, index: 1, windowId: 1, active: false, pinned: false, url: 'https://f.example/', title: 'F' },
  ]);
  const sw5a = bootServiceWorker(world5);
  for (const fn of sw5a.L.onInstalled) await fn();
  await tick();
  check('activeTabId is 1 while the suspended tab is active', world5.session.tabState.activeTabId === 1,
    String(world5.session.tabState.activeTabId));

  const sw5b = bootServiceWorker(world5);
  world5.tabs[0].active = false;
  world5.tabs[1].active = true;
  for (const fn of sw5b.L.tabActivated) await fn({ tabId: 2 });
  await tick();
  check('discard is retried for the old active tab after a restart',
    world5.discarded.indexOf(1) !== -1, JSON.stringify(world5.discarded));

  console.log('\n-- tabs.onReplaced re-keying --');
  const sw6 = bootServiceWorker(world5);
  for (const fn of sw6.L.tabReplaced) await fn(77, 1);
  await tick();
  check('the URL record moved to the new tabId',
    typeof world5.session.tabState.urls['77'] === 'string' &&
    world5.session.tabState.urls['1'] === undefined,
    JSON.stringify(world5.session.tabState.urls));

  console.log('\n-- Blank screen on the active tab regression --');
  const world7 = createBrowserWorld([
    { id: 1, index: 0, windowId: 1, active: true, pinned: false, highlighted: true,
      discarded: false, url: 'https://g.example/', title: 'G' },
    { id: 2, index: 1, windowId: 1, active: false, pinned: false, url: 'https://h.example/', title: 'H' },
  ]);
  const sw7 = bootServiceWorker(world7);
  for (const fn of sw7.L.onInstalled) await fn();
  for (const fn of sw7.L.onCommand) await fn('toggle-suspend');
  await tick();
  for (const fn of sw7.L.tabUpdated) await fn(1, { status: 'complete' }, world7.tabs[0]);
  await settle();

  check('the active tab was suspended', world7.tabs[0].url.indexOf(SUSPEND_PREFIX) === 0,
    world7.tabs[0].url);
  check('the ACTIVE tab is NOT discarded (no blank screen)',
    world7.discarded.indexOf(1) === -1, JSON.stringify(world7.discarded));

  world7.tabs[0].active = false;
  world7.tabs[1].active = true;
  for (const fn of sw7.L.tabActivated) await fn({ tabId: 2 });
  await settle();
  check('discard fires once you switch away (memory is freed)',
    world7.discarded.indexOf(1) !== -1, JSON.stringify(world7.discarded));

  console.log('\n-- Discard guard during restore --');
  const worldR = createBrowserWorld([
    { id: 1, index: 0, windowId: 1, active: false, pinned: false, discarded: false,
      url: SUSPEND_PREFIX + '?id=r&url=https%3A%2F%2Fr.example%2F&t=R&ts=1', title: 'R',
      pendingUrl: 'https://r.example/' },
    { id: 2, index: 1, windowId: 1, active: true, pinned: false, url: 'https://s.example/', title: 'S' },
  ]);
  const swR = bootServiceWorker(worldR);
  for (const fn of swR.L.tabActivated) await fn({ tabId: 2 });
  await settle();
  check('no discard while pendingUrl points at another page',
    worldR.discarded.indexOf(1) === -1, JSON.stringify(worldR.discarded));

  delete worldR.tabs[0].pendingUrl;
  for (const fn of swR.L.tabActivated) await fn({ tabId: 2 });
  await settle();
  check('a suspended background tab is discarded when no navigation is pending',
    worldR.discarded.indexOf(1) !== -1, JSON.stringify(worldR.discarded));

  console.log('\n-- Alarms, backups and shared records --');
  const worldP = createBrowserWorld([
    { id: 1, index: 0, windowId: 1, active: true, pinned: false, url: 'https://p.example/', title: 'P' },
  ]);
  const swP = bootServiceWorker(worldP);
  const preset = { periodInMinutes: 5, delayInMinutes: 5, marker: true };
  swP.alarms['tab-backup'] = preset;
  for (const fn of swP.L.onInstalled) await fn();
  await tick();
  check('the backup alarm is NOT reset when the service worker wakes up',
    swP.alarms['tab-backup'] === preset, JSON.stringify(swP.alarms['tab-backup']));

  worldP.local.backups = [
    { timestamp: 't2', tabCount: 0, tabs: [] },
    { timestamp: 't1', tabCount: 0, tabs: [] },
  ];
  const delListener = swP.L.onMessage[0];
  await new Promise((resolve) => delListener({ action: 'delete-backup', timestamp: 't1' }, {}, resolve));
  check('delete-backup removed the right backup by timestamp',
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
  check('restoring a duplicated tab did not delete the shared record',
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
  worldS.tabs = worldS.tabs.filter((t) => t.id !== 1);
  const swS2 = bootServiceWorker(worldS);
  for (const fn of swS2.L.tabRemoved) await fn(1, { isWindowClosing: false, windowId: 1 });
  await tick();
  check('a suspended tab closed while the worker slept has its record removed on wake-up',
    !readSuspended(worldS).sleepy,
    JSON.stringify(readSuspended(worldS)));

  console.log('\n-- URL allowlist and sender check --');
  const worldU = createBrowserWorld([
    { id: 1, index: 0, windowId: 1, active: true, pinned: false, url: 'https://u.example/', title: 'U' },
  ]);
  const swU = bootServiceWorker(worldU);
  const send3 = (msg, sender) => new Promise((resolve) => swU.L.onMessage[0](msg, sender || {}, resolve));
  for (const bad of ['DATA:text/html,<b>x</b>', ' javascript:alert(1)', 'file:///c:/x', 'chrome-extension://x/y.html', 'brave://settings']) {
    await send3({ action: 'restore-tab', url: bad, asSuspended: false });
  }
  check('non-http(s) addresses are NOT opened by restore-tab', worldU.created.length === 0, JSON.stringify(worldU.created));
  await send3({ action: 'restore-tab', url: 'https://ok.example/', asSuspended: false });
  check('an http(s) address is opened by restore-tab', worldU.created.length === 1, JSON.stringify(worldU.created));
  const foreign = await send3({ action: 'get-suspended-list' }, { id: 'baska-eklenti' });
  check('a message from a foreign sender is rejected', Boolean(foreign && foreign.error), JSON.stringify(foreign));
  const blockedSuspend = await new Promise((resolve) => swU.L.onMessage[0]({ action: 'suspend-active' }, {}, resolve));
  check('an http(s) tab can be suspended (the allowlist does not block it by mistake)', blockedSuspend && blockedSuspend.success === true,
    JSON.stringify(blockedSuspend));

  console.log('\n-- Storage migration --');
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
  check('the old blob was deleted', worldM.local.suspended === undefined, JSON.stringify(Object.keys(worldM.local)));
  check('records moved to one key per tab', Object.keys(migrated).sort().join() === 'old1,old2', JSON.stringify(Object.keys(migrated)));
  check('the grayscale icon was kept', migrated.old1 && migrated.old1.greyFavIconUrl === 'data:image/png;base64,AAAA', JSON.stringify(migrated.old1 && Object.keys(migrated.old1)));
  check('a large data: icon was dropped from the record, a short http(s) one kept',
    migrated.old1.favIconUrl === '' && migrated.old2.favIconUrl === 'https://old2.example/f.ico',
    JSON.stringify([migrated.old1.favIconUrl.length, migrated.old2.favIconUrl]));
  check('a large data: icon was dropped from backups', worldM.local.backups[0].tabs[0].favIconUrl === '', String(worldM.local.backups[0].tabs[0].favIconUrl.length));
  check('storageVersion was written', worldM.local.storageVersion === 2, String(worldM.local.storageVersion));
  const swM2 = bootServiceWorker(worldM);
  for (const fn of swM2.L.onInstalled) await fn();
  await tick();
  check('the migration did not repeat on the second start (idempotent)', Object.keys(readSuspended(worldM)).length === 2, JSON.stringify(Object.keys(readSuspended(worldM))));

  console.log('\n-- Bulk suspend (12 tabs) --');
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
  check(N + ' tabs ALL in the `suspended` blob',
    uuids.length === N, uuids.length + '/' + N + ' kayit kaldi');

  const withGrey = uuids.filter((u) => stored[u].greyFavIconUrl);
  check('EVERY grayscale favicon was written (icon consistency)',
    withGrey.length === N, withGrey.length + '/' + N + ' ikon yazildi');

  console.log('\n-- Missing record: restore from the URL parameter --');
  const lostUrl = SUSPEND_PREFIX + '?id=lost&url=' +
    encodeURIComponent('https://kayip.example/makale') + '&t=Kayip&ts=1';
  const world9 = createBrowserWorld([
    { id: 1, index: 0, windowId: 1, active: true, pinned: false, highlighted: true,
      url: lostUrl, title: 'Kayip' },
  ]);
  const sw9 = bootServiceWorker(world9);
  for (const fn of sw9.L.onInstalled) await fn();
  for (const fn of sw9.L.onCommand) await fn('toggle-suspend');
  await tick();
  check('with a missing record the correct URL opens, not a blank page',
    world9.updates.some((u) => u.url === 'https://kayip.example/makale'),
    JSON.stringify(world9.updates));
  check('did not fall back to about:newtab',
    !world9.updates.some((u) => u.url === 'about:newtab'),
    JSON.stringify(world9.updates));

  const loopUrl = SUSPEND_PREFIX + '?id=loop&url=' + encodeURIComponent(SUSPEND_PREFIX + '?id=x') + '&t=L&ts=1';
  const world10 = createBrowserWorld([
    { id: 1, index: 0, windowId: 1, active: true, pinned: false, highlighted: true,
      url: loopUrl, title: 'L' },
  ]);
  const sw10 = bootServiceWorker(world10);
  for (const fn of sw10.L.onInstalled) await fn();
  for (const fn of sw10.L.onCommand) await fn('toggle-suspend');
  await tick();
  check('a loop back to the suspend page is refused',
    world10.updates.every((u) => String(u.url || '').indexOf(SUSPEND_PREFIX) !== 0),
    JSON.stringify(world10.updates));

  console.log('\n-- Bulk restore (multi-selection) --');
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
  check('with all suspended, all 4 tabs were restored',
    geri.length === 4, 'geri yuklenen: ' + geri.join(','));
  check('restored records were removed from storage',
    Object.keys(readSuspended(world11)).length === 0,
    JSON.stringify(Object.keys(readSuspended(world11))));

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
  check('in a mixed selection the open tab was suspended',
    world12.updates.some((u) => u.id === 2 && String(u.url).indexOf(SUSPEND_PREFIX) === 0),
    JSON.stringify(world12.updates));
  check('in a mixed selection the suspended tab was NOT restored',
    !world12.updates.some((u) => u.id === 1),
    JSON.stringify(world12.updates));

  console.log('\n-- Favicon generation fails (offline) --');
  const world4 = createBrowserWorld([
    { id: 1, index: 0, windowId: 1, active: true, pinned: false, highlighted: true,
      url: 'https://d.example/', title: 'D', favIconUrl: 'https://d.example/f.ico' },
  ]);
  const sw4 = bootServiceWorker(world4);
  for (const fn of sw4.L.onInstalled) await fn();
  for (const fn of sw4.L.onCommand) await fn('toggle-suspend');
  await tick();
  check('suspend works even when the favicon cannot be generated',
    world4.updates.some((u) => typeof u.url === 'string' && u.url.indexOf(SUSPEND_PREFIX) === 0),
    JSON.stringify(world4.updates));

  console.log('\n' + (fail === 0
    ? 'ALL TESTS PASSED (' + pass + ')'
    : fail + ' TESTS FAILED (' + pass + ' passed)'));
  process.exit(fail === 0 ? 0 : 1);
})();

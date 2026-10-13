// Runs src/background.js against a fake chrome.tabs API.
const fs = require('fs'), vm = require('vm'), path = require('path');
const SRC = path.join(__dirname, '..', 'src', 'background.js');

function makeSW(tabs, opts = {}) {
  const calls = [];
  let listener = null;
  const chrome = {
    runtime: { id: 'ext-id', onMessage: { addListener: (fn) => (listener = fn) } },
    tabs: {
      query: async (q) => { calls.push(['query', q.windowId]); return tabs.filter((t) => t.windowId === q.windowId).map((t) => ({ ...t })); },
      update: async (id, p) => { calls.push(['update', id, p.active]); },
      remove: async (id) => { calls.push(['remove', id]); if (opts.removeRejects) throw new Error('Tabs cannot be edited right now'); },
      create: async (p) => { calls.push(['create', p.windowId, p.openerTabId, p.index]); },
      reload: async (id, p) => { calls.push(['reload', id, p.bypassCache]); },
    },
  };
  const sandbox = { chrome, console, Promise };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SRC, 'utf8'), sandbox);
  const send = async (action, tab) => {
    const rv = listener({ action }, { tab });
    await new Promise((r) => setImmediate(r));
    return rv;
  };
  return { send, calls, listener: () => listener };
}

const results = [];
const t = (name, fn) => fn().then((r) => results.push([r === true, name, r === true ? '' : String(r)]),
                                  (e) => results.push([false, name, 'THREW ' + e.message]));
const eq = (g, w) => JSON.stringify(g) === JSON.stringify(w) ? true : `got ${JSON.stringify(g)} want ${JSON.stringify(w)}`;
const TABS = [
  { id: 10, index: 0, windowId: 1 }, { id: 11, index: 1, windowId: 1 }, { id: 12, index: 2, windowId: 1 },
  { id: 20, index: 0, windowId: 2 }, { id: 21, index: 1, windowId: 2 },
];
const tab = (id) => TABS.find((x) => x.id === id);
const withoutQuery = (calls) => calls.filter((c) => c[0] !== 'query');

(async () => {
  await t('closing a middle tab activates the next one', async () => {
    const sw = makeSW(TABS); await sw.send('closeTabFocusNext', tab(11));
    return eq(withoutQuery(sw.calls), [['update', 12, true], ['remove', 11]]);
  });
  await t('closing the last tab activates the previous one', async () => {
    const sw = makeSW(TABS); await sw.send('closeTabFocusNext', tab(12));
    return eq(withoutQuery(sw.calls), [['update', 11, true], ['remove', 12]]);
  });
  await t('closing the first tab activates the next one', async () => {
    const sw = makeSW(TABS); await sw.send('closeTabFocusNext', tab(10));
    return eq(withoutQuery(sw.calls), [['update', 11, true], ['remove', 10]]);
  });
  await t('closing the only tab only removes it', async () => {
    const sw = makeSW([{ id: 10, index: 0, windowId: 1 }]); await sw.send('closeTabFocusNext', { id: 10, index: 0, windowId: 1 });
    return eq(withoutQuery(sw.calls), [['remove', 10]]);
  });
  await t('tabs come back unsorted but are ordered by index', async () => {
    const sw = makeSW([{ id: 12, index: 2, windowId: 1 }, { id: 10, index: 0, windowId: 1 }, { id: 11, index: 1, windowId: 1 }]);
    await sw.send('closeTabFocusNext', { id: 10, index: 0, windowId: 1 });
    return eq(withoutQuery(sw.calls), [['update', 11, true], ['remove', 10]]);
  });
  await t('only the sender window is queried, never another window', async () => {
    const sw = makeSW(TABS); await sw.send('closeTabFocusNext', tab(20));
    return eq(sw.calls, [['query', 2], ['update', 21, true], ['remove', 20]]);
  });
  await t('new tab goes right after the sender, in the sender window', async () => {
    const sw = makeSW(TABS); await sw.send('newTabAfterCurrent', tab(21));
    return eq(sw.calls, [['create', 2, 21, 2]]);
  });
  await t('reload keeps the cache', async () => {
    const sw = makeSW(TABS); await sw.send('reload', tab(11));
    return eq(sw.calls, [['reload', 11, false]]);
  });
  await t('message without sender tab does nothing', async () => {
    const sw = makeSW(TABS);
    for (const a of ['closeTabFocusNext', 'newTabAfterCurrent', 'reload']) await sw.send(a, undefined);
    return eq(sw.calls, []);
  });
  await t('empty or unknown messages do not throw', async () => {
    const sw = makeSW(TABS);
    sw.listener()(null, {}); sw.listener()({}, {}); sw.listener()({ action: 'nope' }, { tab: tab(11) });
    await new Promise((r) => setImmediate(r));
    return eq(sw.calls, []);
  });
  await t('listener returns undefined, never a Promise or true', async () => {
    const sw = makeSW(TABS);
    return eq(sw.listener()({ action: 'reload' }, { tab: tab(11) }), undefined);
  });
  await t('rejected tabs.remove is swallowed', async () => {
    const sw = makeSW(TABS, { removeRejects: true });
    await sw.send('closeTabFocusNext', tab(11));
    return eq(withoutQuery(sw.calls), [['update', 12, true], ['remove', 11]]);
  });

  let fail = 0;
  for (const [ok, name, msg] of results) { if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${msg ? '  -- ' + msg : ''}`); }
  console.log(`\n${results.length - fail}/${results.length} passed`);
  process.exit(fail ? 1 : 0);
})();

// Runs src/content.js inside a fake DOM and drives the whole gesture state machine event by event.
const fs = require('fs'), vm = require('vm'), path = require('path');
const SRC = path.join(__dirname, '..', 'src', 'content.js');

function makeEnv(opts = {}) {
  const listeners = {};
  const sent = [], nav = [], canvasOps = [];
  const ctx = new Proxy({}, { get: (_, p) => (p === 'clearRect' ? () => canvasOps.push('clear') : () => {}), set: () => true });
  const reg = (t, fn) => (listeners[t] ||= []).push(fn);
  const unreg = (t, fn) => { listeners[t] = (listeners[t] || []).filter((f) => f !== fn); };
  const win = {
    innerWidth: 1280, innerHeight: 720, devicePixelRatio: 1,
    history: { back: () => nav.push('back'), forward: () => nav.push('forward') },
    addEventListener: reg, removeEventListener: unreg,
  };
  const doc = {
    visibilityState: 'visible',
    createElement: () => ({
      style: { setProperty() {} }, width: 0, height: 0,
      getContext: () => (opts.noCanvasContext ? null : ctx), remove: () => canvasOps.push('remove'),
    }),
    documentElement: { appendChild: () => canvasOps.push('append') },
  };
  let alive = true;
  const api = {
    runtime: {
      get id() { return alive ? 'ext-id' : undefined; },
      sendMessage: (m) => { if (opts.sendThrows) throw new Error('Extension context invalidated.'); sent.push(m.action); return Promise.resolve(); },
    },
    storage: {
      sync: { get: () => Promise.resolve(opts.settings || {}) },
      onChanged: { addListener: () => {} },
    },
  };
  const sandbox = {
    document: doc, window: win, chrome: api, Math, console, Promise,
    location: { hostname: opts.hostname || 'example.com' },
    requestAnimationFrame: () => 1, cancelAnimationFrame: () => {},
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SRC, 'utf8'), sandbox);
  const fire = (t, e) => (listeners[t] || []).forEach((fn) => fn(e));
  return { fire, sent, nav, canvasOps, listeners, win, doc, kill: () => { alive = false; } };
}

const trusted = (e) => ({ isTrusted: true, ...e });

// path: [[x,y],...]; down -> move per point -> up -> contextmenu
function gesture(env, pts, o = {}) {
  const btn = o.button ?? 2;
  const [sx, sy] = pts[0];
  env.fire('mousedown', trusted({ button: btn, buttons: btn === 2 ? 2 : 1, clientX: sx, clientY: sy, ...(o.down || {}) }));
  for (const [x, y] of pts.slice(1)) env.fire('mousemove', trusted({ buttons: o.moveButtons ?? 2, clientX: x, clientY: y }));
  if (o.escape) { env.fire('keydown', trusted({ key: 'Escape' })); return; }
  if (o.stop) return;
  let prevented = false;
  const cm = trusted({ preventDefault: () => (prevented = true), stopPropagation: () => {} });
  if (o.ctxBeforeUp) env.fire('contextmenu', cm);
  env.fire('mouseup', trusted({ button: btn, clientX: pts.at(-1)[0], clientY: pts.at(-1)[1] }));
  if (!o.ctxBeforeUp) env.fire('contextmenu', cm);
  return prevented;
}

const line = (x0, y0, x1, y1, n = 20) =>
  Array.from({ length: n + 1 }, (_, i) => [Math.round(x0 + (x1 - x0) * i / n), Math.round(y0 + (y1 - y0) * i / n)]);

const results = [];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function t(name, fn) {
  try { const r = await fn(); results.push([r === true, name, r === true ? '' : String(r)]); }
  catch (e) { results.push([false, name, 'THREW ' + e.message]); }
}
const eq = (got, want) => JSON.stringify(got) === JSON.stringify(want) ? true : `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`;
const ops = (e) => e.canvasOps.filter((o) => o !== 'clear');

(async () => {
  // ---- directions ----
  await t('LEFT -> history.back', () => { const e = makeEnv(); gesture(e, line(400, 300, 300, 300)); return eq([e.nav, e.sent], [['back'], []]); });
  await t('RIGHT -> history.forward', () => { const e = makeEnv(); gesture(e, line(300, 300, 400, 300)); return eq([e.nav, e.sent], [['forward'], []]); });
  await t('DOWN -> closeTabFocusNext', () => { const e = makeEnv(); gesture(e, line(300, 200, 300, 300)); return eq([e.nav, e.sent], [[], ['closeTabFocusNext']]); });
  await t('UP -> newTabAfterCurrent', () => { const e = makeEnv(); gesture(e, line(300, 300, 300, 200)); return eq([e.nav, e.sent], [[], ['newTabAfterCurrent']]); });
  await t('RIGHT_LEFT -> reload', () => { const e = makeEnv(); gesture(e, [...line(300, 300, 420, 300, 12), ...line(420, 300, 300, 302, 12)]); return eq(e.sent, ['reload']); });
  await t('RIGHT_LEFT works with few samples (fast return)', () => { const e = makeEnv(); gesture(e, [[300, 300], [420, 300], [300, 300]]); return eq(e.sent, ['reload']); });
  await t('RIGHT_LEFT works with a slow out and fast back', () => {
    const e = makeEnv(); gesture(e, [...line(300, 300, 420, 300, 40), [300, 301]]); return eq(e.sent, ['reload']);
  });

  // ---- thresholds and negatives ----
  await t('below threshold (50px) does nothing', () => { const e = makeEnv(); gesture(e, line(400, 300, 350, 300)); return eq([e.nav, e.sent], [[], []]); });
  await t('above threshold (61px) fires', () => { const e = makeEnv(); gesture(e, line(400, 300, 339, 300)); return eq(e.nav, ['back']); });
  await t('left click is ignored', () => { const e = makeEnv(); gesture(e, line(400, 300, 300, 300), { button: 0 }); return eq([e.nav, e.sent], [[], []]); });
  await t('circle is not RIGHT_LEFT', () => {
    const e = makeEnv();
    const circ = Array.from({ length: 40 }, (_, i) => { const a = -Math.PI / 2 + i * 2 * Math.PI / 39; return [Math.round(300 + 80 * Math.cos(a)), Math.round(300 + 80 * Math.sin(a))]; });
    gesture(e, circ); return eq(e.sent, []);
  });
  await t('Escape cancels the gesture', () => { const e = makeEnv(); gesture(e, line(400, 300, 300, 300), { escape: true }); return eq([e.nav, e.sent], [[], []]); });
  await t('diagonal 45 degrees does nothing (dead zone)', () => { const e = makeEnv(); gesture(e, line(300, 300, 380, 380)); return eq([e.nav, e.sent], [[], []]); });
  await t('44 and 46 degree strokes do not flip into different actions', () => {
    const a = makeEnv(); gesture(a, line(300, 300, 300 + 100, 300 + 96));
    const b = makeEnv(); gesture(b, line(300, 300, 300 + 96, 300 + 100));
    return eq([a.nav, a.sent, b.nav, b.sent], [[], [], [], []]);
  });
  await t('28 degrees from horizontal still counts as horizontal', () => { const e = makeEnv(); gesture(e, line(400, 300, 300, 300 + 53)); return eq(e.nav, ['back']); });
  await t('28 degrees from vertical still counts as vertical', () => { const e = makeEnv(); gesture(e, line(300, 200, 300 + 53, 300)); return eq(e.sent, ['closeTabFocusNext']); });

  // ---- trust and lost-state handling ----
  await t('synthetic (untrusted) events are ignored', () => {
    const e = makeEnv();
    e.fire('mousedown', { isTrusted: false, button: 2, buttons: 2, clientX: 300, clientY: 300 });
    e.fire('mousemove', { isTrusted: false, buttons: 2, clientX: 300, clientY: 200 });
    e.fire('mouseup', { isTrusted: false, button: 2, clientX: 300, clientY: 200 });
    return eq([e.nav, e.sent, ops(e)], [[], [], []]);
  });
  await t('mouse moves without the right button cancel the stroke', () => {
    const e = makeEnv(); gesture(e, line(400, 300, 300, 300), { moveButtons: 0, stop: true });
    e.fire('mouseup', trusted({ button: 2, clientX: 300, clientY: 300 }));
    return eq([e.nav, e.sent, ops(e)], [[], [], []]);
  });
  await t('lost mouseup then new mousedown leaves no orphan canvas', () => {
    const e = makeEnv();
    gesture(e, line(400, 300, 350, 300), { stop: true });
    gesture(e, line(400, 300, 350, 300), { stop: true });
    const appended = ops(e).filter((o) => o === 'append').length, removed = ops(e).filter((o) => o === 'remove').length;
    return eq([appended, removed], [2, 1]);
  });
  await t('window blur cancels the stroke and removes the canvas', () => {
    const e = makeEnv(); gesture(e, line(400, 300, 350, 300), { stop: true });
    e.fire('blur', trusted({ target: e.win }));
    e.fire('mouseup', trusted({ button: 2, clientX: 300, clientY: 300 }));
    return eq([e.nav, ops(e)], [[], ['append', 'remove']]);
  });
  await t('blur of an inner element does not cancel the stroke', () => {
    const e = makeEnv(); gesture(e, line(400, 300, 330, 300), { stop: true });
    e.fire('blur', trusted({ target: {} }));
    e.fire('mouseup', trusted({ button: 2, clientX: 340, clientY: 300 }));
    return eq(e.nav, ['back']);
  });
  await t('left button during a stroke cancels it and swallows the click', () => {
    const e = makeEnv(); gesture(e, line(400, 300, 330, 300), { stop: true });
    let prevented = false;
    e.fire('mousedown', trusted({ button: 0, buttons: 3, preventDefault: () => (prevented = true), stopPropagation: () => {} }));
    e.fire('mouseup', trusted({ button: 2, clientX: 330, clientY: 300 }));
    let clickPrevented = false;
    e.fire('click', trusted({ preventDefault: () => (clickPrevented = true), stopPropagation: () => {} }));
    return eq([e.nav, e.sent, prevented, clickPrevented, ops(e)], [[], [], true, true, ['append', 'remove']]);
  });
  await t('a normal left click is never swallowed', () => {
    const e = makeEnv(); gesture(e, line(400, 300, 330, 300));
    e.fire('mousedown', trusted({ button: 0, buttons: 1, preventDefault() {}, stopPropagation() {} }));
    let clickPrevented = false;
    e.fire('click', trusted({ preventDefault: () => (clickPrevented = true), stopPropagation() {} }));
    return eq(clickPrevented, false);
  });
  await t('swallow flag from a cancelled stroke does not eat a later click', () => {
    const e = makeEnv(); gesture(e, line(400, 300, 330, 300), { stop: true });
    e.fire('mousedown', trusted({ button: 0, buttons: 3, preventDefault() {}, stopPropagation() {} }));
    e.fire('mousedown', trusted({ button: 0, buttons: 1, preventDefault() {}, stopPropagation() {} }));
    let clickPrevented = false;
    e.fire('click', trusted({ preventDefault: () => (clickPrevented = true), stopPropagation() {} }));
    return eq(clickPrevented, false);
  });
  await t('hidden tab cancels the stroke', () => {
    const e = makeEnv(); gesture(e, line(400, 300, 350, 300), { stop: true });
    e.doc.visibilityState = 'hidden'; e.fire('visibilitychange', trusted({}));
    e.fire('mouseup', trusted({ button: 2, clientX: 300, clientY: 300 }));
    return eq([e.nav, ops(e)], [[], ['append', 'remove']]);
  });

  // ---- context menu ----
  await t('contextmenu after mouseup is suppressed after a drag', () => { const e = makeEnv(); return eq(gesture(e, line(400, 300, 300, 300)), true); });
  await t('contextmenu before mouseup is suppressed after a drag', () => { const e = makeEnv(); return eq(gesture(e, line(400, 300, 300, 300), { ctxBeforeUp: true }), true); });
  await t('a still right click opens the menu', () => { const e = makeEnv(); return eq(gesture(e, [[400, 300]]), false); });
  await t('1px jitter still opens the menu', () => { const e = makeEnv(); return eq(gesture(e, [[400, 300], [401, 300]]), false); });
  await t('3px movement suppresses the menu without firing an action', () => { const e = makeEnv(); const p = gesture(e, [[400, 300], [403, 300]]); return eq([p, e.nav, e.sent], [true, [], []]); });
  await t('two strokes in a row: the flag does not leak', () => {
    const e = makeEnv(); gesture(e, line(400, 300, 300, 300));
    return eq([gesture(e, [[400, 300]]), e.nav], [false, ['back']]);
  });
  await t('menu flag is released when a stroke is lost, next still click opens the menu', () => {
    const e = makeEnv(); gesture(e, line(400, 300, 350, 300), { stop: true });
    return eq(gesture(e, [[400, 300]]), false);
  });

  // ---- canvas ----
  await t('canvas appears only after a real drag, and is removed', () => { const e = makeEnv(); gesture(e, line(400, 300, 300, 300)); return eq(ops(e), ['append', 'remove']); });
  await t('still right click never creates a canvas', () => { const e = makeEnv(); gesture(e, [[400, 300]]); return eq(ops(e), []); });
  await t('Escape removes the canvas', () => { const e = makeEnv(); gesture(e, line(400, 300, 300, 300), { escape: true }); return eq(ops(e), ['append', 'remove']); });
  await t('missing 2d context does not break the gesture', () => { const e = makeEnv({ noCanvasContext: true }); gesture(e, line(400, 300, 300, 300)); return eq(e.nav, ['back']); });

  // ---- messaging failures ----
  await t('sendMessage throwing does not escape the handler', () => {
    const e = makeEnv({ sendThrows: true }); gesture(e, line(300, 200, 300, 300)); return true;
  });
  await t('after the extension context dies the listeners are removed', () => {
    const e = makeEnv(); e.kill(); gesture(e, line(300, 200, 300, 300));
    return eq(Object.values(e.listeners).every((a) => a.length === 0), true);
  });

  // ---- settings ----
  await t('blocked site disables gestures', async () => {
    const e = makeEnv({ hostname: 'maps.example.com', settings: { blockedSites: ['example.com'] } });
    await wait(5); gesture(e, line(400, 300, 300, 300)); return eq([e.nav, e.sent], [[], []]);
  });
  await t('unrelated site is not blocked by a suffix lookalike', async () => {
    const e = makeEnv({ hostname: 'notexample.com', settings: { blockedSites: ['example.com'] } });
    await wait(5); gesture(e, line(400, 300, 300, 300)); return eq(e.nav, ['back']);
  });
  await t('custom minDistance is honoured', async () => {
    const e = makeEnv({ settings: { minDistance: 120 } });
    await wait(5); gesture(e, line(400, 300, 300, 300)); return eq(e.nav, []);
  });
  await t('absurd minDistance falls back to the default', async () => {
    const e = makeEnv({ settings: { minDistance: 99999 } });
    await wait(5); gesture(e, line(400, 300, 300, 300)); return eq(e.nav, ['back']);
  });

  let fail = 0;
  for (const [ok, name, msg] of results) { if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${msg ? '  -- ' + msg : ''}`); }
  console.log(`\n${results.length - fail}/${results.length} passed`);
  process.exit(fail ? 1 : 0);
})();

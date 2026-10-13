(function () {
  'use strict';

  // A page element with id="browser" can shadow the global, so check the real API object.
  const api = (typeof browser !== 'undefined' && browser.runtime && browser.runtime.id) ? browser : chrome;

  const AXIS_RATIO     = 1.5;   // dominant axis must be this much longer, otherwise the stroke is ignored
  const MOVE_THRESHOLD = 2;     // px of movement after which the stroke counts as a drag and the menu is suppressed
  const DEFAULTS       = { minDistance: 60, blockedSites: [] };

  let settings = { ...DEFAULTS, blockedSites: [] };
  let startX = 0, startY = 0;
  let isGesturing     = false;
  let suppressCtxMenu = false;
  let swallowClick    = false;
  let trail = [];
  let canvas = null, ctx = null;
  let rafId = null, dirty = false;

  // ── Settings ──────────────────────────────────────────
  function applySettings(next) {
    const dist = Number(next.minDistance);
    settings = {
      minDistance: dist >= 20 && dist <= 400 ? dist : DEFAULTS.minDistance,
      blockedSites: Array.isArray(next.blockedSites) ? next.blockedSites : [],
    };
  }

  function readSettings() {
    try {
      const p = api.storage.sync.get(DEFAULTS);
      if (p && p.then) p.then(applySettings, () => {});
    } catch (_) { /* storage unavailable, defaults stay */ }
  }

  function loadSettings() {
    readSettings();
    try { if (api.storage.onChanged) api.storage.onChanged.addListener(readSettings); } catch (_) { /* ignore */ }
  }

  function isBlocked() {
    const host = location.hostname.toLowerCase();
    return settings.blockedSites.some((entry) => {
      const s = String(entry).trim().toLowerCase();
      return s && (host === s || host.endsWith('.' + s));
    });
  }

  // ── Canvas ────────────────────────────────────────────
  function ensureCanvas() {
    if (canvas) return;
    const c = document.createElement('canvas');
    const styles = {
      'position': 'fixed', 'top': '0', 'left': '0', 'width': '100vw', 'height': '100vh',
      'z-index': '2147483647', 'pointer-events': 'none', 'display': 'block',
      'margin': '0', 'padding': '0', 'border': '0', 'opacity': '1', 'visibility': 'visible',
    };
    for (const k in styles) c.style.setProperty(k, styles[k], 'important');
    const context = c.getContext && c.getContext('2d');
    if (!context) return;
    canvas = c; ctx = context;
    sizeCanvas();
    document.documentElement.appendChild(canvas);
    dirty = true;
    rafId = requestAnimationFrame(renderLoop);
  }

  function sizeCanvas() {
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width  = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    dirty = true;
  }

  function removeCanvas() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    if (canvas) canvas.remove();
    canvas = null; ctx = null;
  }

  function renderLoop() {
    if (!ctx) return;
    if (dirty && trail.length >= 2) {
      const dpr = window.devicePixelRatio || 1;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.strokeStyle = 'rgba(120,160,255,0.6)';
      ctx.lineWidth   = 2;
      ctx.lineCap     = 'round';
      ctx.lineJoin    = 'round';
      ctx.beginPath();
      ctx.moveTo(trail[0].x, trail[0].y);
      for (let i = 1; i < trail.length; i++) ctx.lineTo(trail[i].x, trail[i].y);
      ctx.stroke();
      dirty = false;
    }
    rafId = requestAnimationFrame(renderLoop);
  }

  // ── Gesture analysis ──────────────────────────────────
  function getDirection(dx, dy) {
    const ax = Math.abs(dx), ay = Math.abs(dy);
    if (ax >= ay * AXIS_RATIO) return dx > 0 ? 'RIGHT' : 'LEFT';
    if (ay >= ax * AXIS_RATIO) return dy > 0 ? 'DOWN' : 'UP';
    return null;
  }

  function analyzeGesture(points) {
    if (points.length < 2) return null;
    const min   = settings.minDistance;
    const start = points[0];
    const end   = points[points.length - 1];

    let peakX = start.x;
    let minY  = start.y, maxY = start.y;
    for (let i = 1; i < points.length; i++) {
      if (points[i].x > peakX) peakX = points[i].x;
      if (points[i].y < minY) minY = points[i].y;
      if (points[i].y > maxY) maxY = points[i].y;
    }

    const rightExtent  = peakX - start.x;
    const returnExtent = peakX - end.x;
    const yRange       = maxY - minY;
    const totalHoriz   = rightExtent + returnExtent;

    // Right then left. The vertical range check rejects circles.
    if (rightExtent >= min && returnExtent >= min && yRange < totalHoriz * 0.45) {
      return 'RIGHT_LEFT';
    }

    const dx = end.x - start.x;
    const dy = end.y - start.y;
    if (Math.hypot(dx, dy) < min) return null;
    return getDirection(dx, dy);
  }

  // ── Actions ───────────────────────────────────────────
  function alive() {
    try { return !!api.runtime.id; } catch (_) { return false; }
  }

  function send(action) {
    if (!alive()) { teardown(); return; }
    try {
      const p = api.runtime.sendMessage({ action });
      if (p && p.catch) p.catch(() => {});
    } catch (_) { teardown(); }
  }

  function executeGesture(gesture) {
    switch (gesture) {
      case 'LEFT':       window.history.back(); break;
      case 'RIGHT':      window.history.forward(); break;
      case 'DOWN':       send('closeTabFocusNext'); break;
      case 'UP':         send('newTabAfterCurrent'); break;
      case 'RIGHT_LEFT': send('reload'); break;
    }
  }

  // ── Lifecycle ─────────────────────────────────────────
  function cancel(releaseMenu) {
    isGesturing = false;
    if (releaseMenu) suppressCtxMenu = false;
    trail = [];
    removeCanvas();
  }

  // ── Event handlers ────────────────────────────────────
  function onMouseDown(e) {
    if (!e.isTrusted) return;
    if (e.button === 0) {
      // Left button during a stroke cancels it; the click it would produce must not reach the page.
      swallowClick = isGesturing;
      if (isGesturing) { e.preventDefault(); e.stopPropagation(); cancel(false); }
      return;
    }
    if (e.button !== 2) return;
    cancel(true);
    if (isBlocked()) return;
    startX = e.clientX; startY = e.clientY;
    isGesturing = true;
    trail = [{ x: startX, y: startY }];
  }

  function onMouseMove(e) {
    if (!e.isTrusted || !isGesturing) return;
    // Right button already released outside the page: the stroke is dead.
    if (!(e.buttons & 2)) { cancel(true); return; }
    trail.push({ x: e.clientX, y: e.clientY });
    dirty = true;
    if (!suppressCtxMenu && Math.hypot(e.clientX - startX, e.clientY - startY) > MOVE_THRESHOLD) {
      suppressCtxMenu = true;
      ensureCanvas();
    }
  }

  function onMouseUp(e) {
    if (!e.isTrusted || e.button !== 2 || !isGesturing) return;
    const gesture = analyzeGesture(trail);
    cancel(false);
    if (gesture) executeGesture(gesture);
  }

  function onClick(e) {
    if (!e.isTrusted || !swallowClick) return;
    swallowClick = false;
    e.preventDefault();
    e.stopPropagation();
  }

  function onKeyDown(e) {
    if (e.key === 'Escape' && isGesturing) cancel(false);
  }

  function onContextMenu(e) {
    if (!e.isTrusted || !suppressCtxMenu) return;
    e.preventDefault();
    e.stopPropagation();
    suppressCtxMenu = false;
  }

  function onBlur(e) {
    // Element blur events also reach a capturing window listener.
    if (e.target === window && isGesturing) cancel(true);
  }

  function onVisibility() {
    if (document.visibilityState === 'hidden' && isGesturing) cancel(true);
  }

  const handlers = [
    ['mousedown', onMouseDown], ['mousemove', onMouseMove], ['mouseup', onMouseUp],
    ['keydown', onKeyDown], ['click', onClick], ['contextmenu', onContextMenu],
    ['blur', onBlur], ['visibilitychange', onVisibility], ['resize', sizeCanvas],
  ];
  for (const [type, fn] of handlers) window.addEventListener(type, fn, true);

  // After an extension update the old script stays in open tabs with a dead API.
  function teardown() {
    cancel(true);
    for (const [type, fn] of handlers) window.removeEventListener(type, fn, true);
  }

  loadSettings();
})();

const browser = globalThis.browser ?? globalThis.chrome;
const msg = (key) => browser.i18n.getMessage(key);

const SUSPEND_PAGE                = browser.runtime.getURL("suspend/suspend.html");
const BACKUP_ALARM                = "tab-backup";
const AUTO_SUSPEND_ALARM          = "auto-suspend-check";
const ORPHAN_STARTUP_ALARM        = "orphan-startup-check";
// A tab that is still navigating can look orphaned, so young records are skipped.
const ORPHAN_MIN_AGE_MS           = 10 * 60 * 1000;
const DEFAULT_BACKUP_INTERVAL_MINUTES = 5;
const MIN_BACKUP_INTERVAL_MINUTES     = 1;
const MAX_BACKUP_INTERVAL_MINUTES     = 180;
const AUTO_SUSPEND_CHECK_INTERVAL = 1;
const MAX_BACKUPS                 = 20;
const FAVICON_TIMEOUT_MS          = 2000;
// Time for the browser to store the new tab icon before the tab is discarded.
const FAVICON_PERSIST_GRACE_MS    = 350;

function generateUUID() {
  return crypto.randomUUID();
}

async function uuidInUseElsewhere(uuid, exceptTabId) {
  const tabs = await browser.tabs.query({});
  return tabs.some((t) => t.id !== exceptTabId && isSuspendPage(t.url) && extractUUIDFromUrl(t.url) === uuid);
}

function isSuspendPage(url) {
  if (!url) return false;
  return url.startsWith(SUSPEND_PAGE);
}

function extractUUIDFromUrl(url) {
  try {
    const u = new URL(url);
    return u.searchParams.get("id");
  } catch {
    return null;
  }
}

function urlParamOf(suspendUrl) {
  try {
    const raw = new URL(suspendUrl).searchParams.get("url");
    if (!raw) return "";
    if (isSuspendPage(raw) || isBlockedUrl(raw)) return "";
    return raw;
  } catch {
    return "";
  }
}

function buildSuspendUrl(uuid, originalUrl, title, favIconUrl) {
  const u  = encodeURIComponent(originalUrl || "");
  const t  = encodeURIComponent((title || "").slice(0, 400));
  const ts = encodeURIComponent(new Date().toISOString());
  const favOk = favIconUrl
    && !favIconUrl.startsWith("data:")
    && favIconUrl.length < 512;
  const fav = favOk ? `&fav=${encodeURIComponent(favIconUrl)}` : "";
  return `${SUSPEND_PAGE}?id=${uuid}&url=${u}&t=${t}&ts=${ts}${fav}`;
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(""), ms)),
  ]);
}

// Allowlist: only http(s) can be suspended or restored. Always test isSuspendPage() before isBlockedUrl(),
// the suspend page is a chrome-extension: URL as well.
function isBlockedUrl(url) {
  if (!url) return true;
  try {
    const protocol = new URL(url).protocol;
    return protocol !== "http:" && protocol !== "https:";
  } catch {
    return true;
  }
}

// One storage key per suspended tab. A single shared blob lets concurrent writers overwrite each other, do not go back to it.
const SUSPENDED_PREFIX = "s:";
const STORAGE_VERSION  = 2;
const MAX_STORED_FAVICON_URL_LENGTH = 512;

function suspendedKey(uuid) { return SUSPENDED_PREFIX + uuid; }

async function getSuspendedEntry(uuid) {
  const key = suspendedKey(uuid);
  const stored = await browser.storage.local.get(key);
  return stored[key];
}

async function setSuspendedEntry(uuid, entry) {
  await browser.storage.local.set({ [suspendedKey(uuid)]: entry });
}

async function deleteSuspendedEntry(uuid) {
  await browser.storage.local.remove(suspendedKey(uuid));
}

async function getAllSuspended() {
  const all = await browser.storage.local.get(null);
  const out = {};
  for (const [key, value] of Object.entries(all)) {
    if (key.startsWith(SUSPENDED_PREFIX)) out[key.slice(SUSPENDED_PREFIX.length)] = value;
  }
  return out;
}

function storableFavIconUrl(url) {
  if (!url || url.length >= MAX_STORED_FAVICON_URL_LENGTH) return "";
  return isBlockedUrl(url) ? "" : url;
}

async function getBackups() {
  const { backups = [] } = await browser.storage.local.get("backups");
  return backups;
}

async function setBackups(backups) {
  await browser.storage.local.set({ backups });
}

// Serializes read-modify-write on backups so the alarm, the orphan scan and popup deletes cannot overwrite each other.
let backupsChain = Promise.resolve();

function mutateBackups(fn) {
  const run = backupsChain.then(async () => {
    const backups = await getBackups();
    const result = await fn(backups);
    await setBackups(backups);
    return result;
  });
  backupsChain = run.then(() => {}, () => {});
  return run;
}

// Served from the extension origin, so fetching it is not blocked by the site's CORS rules.
function faviconCacheUrl(pageUrl, size) {
  const u = new URL(browser.runtime.getURL("/_favicon/"));
  u.searchParams.set("pageUrl", pageUrl);
  u.searchParams.set("size", String(size));
  return u.toString();
}

async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  // Chunked: btoa over one huge string overflows the stack.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return "data:image/png;base64," + btoa(bin);
}

const FAVICON_MAX_BYTES = 256 * 1024;

async function fetchFaviconBlob(favIconUrl, pageUrl) {
  const candidates = [];
  if (pageUrl && !isBlockedUrl(pageUrl)) candidates.push(faviconCacheUrl(pageUrl, 32));
  if (favIconUrl && (!isBlockedUrl(favIconUrl) || favIconUrl.startsWith("data:image/"))) candidates.push(favIconUrl);

  // withTimeout does not cancel the fetch, abort it so the download does not keep running.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FAVICON_TIMEOUT_MS);
  try {
    for (const url of candidates) {
      try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) continue;
        if (Number(response.headers.get("content-length") || 0) > FAVICON_MAX_BYTES) continue;
        const blob = await response.blob();
        if (blob.size > 0 && blob.size <= FAVICON_MAX_BYTES) return blob;
      } catch {
      }
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function toGreyscaleFavicon(favIconUrl, pageUrl) {
  if (!favIconUrl && !pageUrl) return "";
  try {
    const blob = await fetchFaviconBlob(favIconUrl, pageUrl);
    if (!blob) return "";
    const bitmap = await createImageBitmap(blob);

    const size = Math.min(bitmap.width || 32, 64);
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext("2d");

    ctx.filter = "grayscale(100%) opacity(45%)";
    ctx.drawImage(bitmap, 0, 0, size, size);
    bitmap.close();
    ctx.filter = "none";

    drawPauseOverlay(ctx, size);

    const greyscaleBlob = await canvas.convertToBlob({ type: "image/png" });
    return await blobToDataUrl(greyscaleBlob);
  } catch {
    return "";
  }
}

function drawPauseOverlay(ctx, canvasSize) {
  const r  = Math.round(canvasSize * 0.32);
  const cx = canvasSize - r - 1;
  const cy = canvasSize - r - 1;

  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(18, 18, 20, 0.88)";
  ctx.fill();

  const barW = Math.max(2, Math.round(r * 0.28));
  const barH = Math.round(r * 1.0);
  const gap  = Math.round(r * 0.22);
  const barX1 = cx - gap / 2 - barW;
  const barX2 = cx + gap / 2;
  const barY  = cy - barH / 2;

  ctx.fillStyle = "rgba(255, 255, 255, 0.92)";
  ctx.beginPath();
  ctx.roundRect(barX1, barY, barW, barH, 1);
  ctx.fill();
  ctx.beginPath();
  ctx.roundRect(barX2, barY, barW, barH, 1);
  ctx.fill();
}

// tabId to a timestamp before which the tab must not be discarded. Lost when the worker restarts, so isDiscardable() also checks pendingUrl.
const restoringUntil = new Map();
const RESTORE_GUARD_MS = 15_000;
const FAVICON_WAIT_MS  = 2000;
const FAVICON_POLL_MS  = 100;
const discardingTabs   = new Set();
const suspendingTabs  = new Set();

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function suspendTab(tab) {
  if (!tab || !tab.id) return { error: msg("errInvalidTab") };
  if (isSuspendPage(tab.url)) return { error: msg("errAlreadySuspended") };
  if (isBlockedUrl(tab.url)) return { error: msg("errNotSuspendable") };
  // A private tab's URL and title would be written to disk.
  if (tab.incognito) return { error: msg("errIncognito") };
  // A quick double Alt+Shift+S would create two records.
  if (suspendingTabs.has(tab.id)) return { error: msg("errSuspendInProgress") };
  suspendingTabs.add(tab.id);
  try {
    return await suspendTabUnguarded(tab);
  } finally {
    suspendingTabs.delete(tab.id);
  }
}

async function suspendTabUnguarded(tab) {
  const uuid        = generateUUID();
  const suspendedAt = new Date().toISOString();

  // Generate before navigating: once the tab is discarded its page can no longer update the icon.
  const greyFavIconUrl = await withTimeout(
    toGreyscaleFavicon(tab.favIconUrl || "", tab.url || ""),
    FAVICON_TIMEOUT_MS
  ).catch(() => "");

  try {
    await setSuspendedEntry(uuid, {
      originalUrl: tab.url,
      title: tab.title || tab.url,
      favIconUrl: storableFavIconUrl(tab.favIconUrl),
      greyFavIconUrl,
      suspendedAt,
      windowId: tab.windowId,
    });
  } catch (err) {
    console.warn("[tab-suspender] could not write the suspended record:", err);
  }

  const suspendUrl = buildSuspendUrl(uuid, tab.url, tab.title || tab.url, tab.favIconUrl || "");
  // Discarding is triggered from tabs.onUpdated and sweepSuspendedTabs, a per-call listener can miss the complete event.
  await browser.tabs.update(tab.id, { url: suspendUrl });

  return { success: true, uuid };
}

async function waitForTabFavicon(tab) {
  const uuid  = extractUUIDFromUrl(tab.url);
  const entry = uuid ? await getSuspendedEntry(uuid) : null;
  if (entry?.greyFavIconUrl) {
    const deadline = Date.now() + FAVICON_WAIT_MS;
    while (Date.now() < deadline) {
      const t = await browser.tabs.get(tab.id).catch(() => null);
      if (!t) return;
      if ((t.favIconUrl || "").startsWith("data:")) break;
      await sleep(FAVICON_POLL_MS);
    }
    await sleep(FAVICON_PERSIST_GRACE_MS);
  }
}

function isDiscardable(t) {
  if (!t || t.active || t.discarded || t.status !== "complete") return false;
  if (!isSuspendPage(t.url)) return false;
  // A restore in flight still reports the suspend URL; discarding then would freeze the tab on the placeholder.
  if (t.pendingUrl && !isSuspendPage(t.pendingUrl)) return false;
  if ((restoringUntil.get(t.id) || 0) > Date.now()) return false;
  return true;
}

async function discardSuspendedTab(tabId) {
  if (tabId === undefined || tabId === null || discardingTabs.has(tabId)) return;
  discardingTabs.add(tabId);
  try {
    const tab = await browser.tabs.get(tabId).catch(() => null);
    if (!isDiscardable(tab)) return;

    await waitForTabFavicon(tab);

    const fresh = await browser.tabs.get(tabId).catch(() => null);
    if (!isDiscardable(fresh)) return;

    await browser.tabs.discard(tabId).catch(() => {});
    const after = await browser.tabs.get(tabId).catch(() => null);
    if (after && !after.discarded) {
      console.warn(`[tab-suspender] discard failed: tab ${tabId}`);
    }
  } finally {
    discardingTabs.delete(tabId);
  }
}

async function sweepSuspendedTabs() {
  const tabs = await browser.tabs.query({});
  await Promise.allSettled(
    tabs.filter((t) => isSuspendPage(t.url) && !t.active && !t.discarded)
        .map((t) => discardSuspendedTab(t.id))
  );
}

async function unsuspendTab(tab) {
  if (!tab || !tab.id) return { error: msg("errInvalidTab") };
  if (!isSuspendPage(tab.url)) return { error: msg("errNotSuspended") };

  const uuid = extractUUIDFromUrl(tab.url);
  if (!uuid) return { error: msg("errNoId") };

  const entry = await getSuspendedEntry(uuid);

  // The record is not the only source of truth: the suspend URL carries the original address, so a lost record does not lose the tab.
  const originalUrl = entry?.originalUrl || urlParamOf(tab.url);

  if (!originalUrl) {
    await browser.tabs.update(tab.id, { url: "chrome://newtab" });
    return { error: msg("errNoOriginalUrl") };
  }

  restoringUntil.set(tab.id, Date.now() + RESTORE_GUARD_MS);
  await browser.tabs.update(tab.id, { url: originalUrl });

  // Delete after navigating so the record survives a failed navigation.
  if (!(await uuidInUseElsewhere(uuid, tab.id))) {
    await deleteSuspendedEntry(uuid);
  }

  return { success: true };
}

browser.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-suspend") return;
  await ensureInitialized();

  const highlighted = await browser.tabs.query({ highlighted: true, currentWindow: true });
  if (!highlighted.length) return;

  if (highlighted.length > 1) {
    const allSuspended = highlighted.every((tab) => isSuspendPage(tab.url));

    await Promise.allSettled(highlighted.map((tab) => {
      if (allSuspended) return unsuspendTab(tab);
      return isSuspendPage(tab.url) ? null : suspendTab(tab);
    }));
  } else {
    const tab = highlighted[0];
    if (isSuspendPage(tab.url)) {
      await unsuspendTab(tab);
    } else {
      await suspendTab(tab);
    }
  }
});

async function handleMessage(message, sender) {
  if (sender.id !== browser.runtime.id) return { error: msg("errUnknownSender") };
  await ensureInitialized();
  const { action } = message;

  if (action === "unsuspend") {
    const tab = sender.tab;
    if (!tab) return { error: msg("errNoSenderTab") };
    return await unsuspendTab(tab);
  }

  if (action === "suspend-active") {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab) return { error: msg("errNoActiveTab") };
    return await suspendTab(tab);
  }

  if (action === "get-suspended-list") {
    const suspended = await getAllSuspended();
    return { suspended };
  }

  if (action === "get-backups") {
    const backups = await getBackups();
    return { backups };
  }

  if (action === "create-backup-now") {
    await createBackup();
    return { success: true };
  }

  if (action === "restore-tab") {
    const { url, asSuspended, title, favIconUrl } = message;
    if (isBlockedUrl(url)) return { error: msg("errCannotRestore") };
    if (asSuspended) {
      const uuid = generateUUID();
      await setSuspendedEntry(uuid, {
        originalUrl: url,
        title: title || url,
        favIconUrl: storableFavIconUrl(favIconUrl),
        suspendedAt: new Date().toISOString(),
        windowId: null,
      });
      await browser.tabs.create({ url: buildSuspendUrl(uuid, url, title, favIconUrl) });
    } else {
      await browser.tabs.create({ url });
    }
    return { success: true };
  }

  if (action === "restore-all-backup") {
    const { tabs } = message;
    for (const t of tabs) {
      if (isBlockedUrl(t.url)) continue;
      if (t.suspended) {
        const uuid = generateUUID();
        await setSuspendedEntry(uuid, {
          originalUrl: t.url,
          title: t.title || t.url,
          favIconUrl: storableFavIconUrl(t.favIconUrl),
          suspendedAt: new Date().toISOString(),
          windowId: null,
        });
        await browser.tabs.create({ url: buildSuspendUrl(uuid, t.url, t.title, t.favIconUrl || ""), active: false });
      } else {
        await browser.tabs.create({ url: t.url, active: false });
      }
    }
    return { success: true };
  }

  if (action === "delete-backup") {
    const { timestamp } = message;
    if (!timestamp) return { error: msg("errMissingTimestamp") };
    await mutateBackups((backups) => {
      const at = backups.findIndex((b) => b.timestamp === timestamp);
      if (at !== -1) backups.splice(at, 1);
    });
    return { success: true };
  }

  if (action === "unsuspend-all") {
    const allTabs      = await browser.tabs.query({});
    const suspendedTabs = allTabs.filter(t => isSuspendPage(t.url));
    await Promise.allSettled(suspendedTabs.map((tab) => unsuspendTab(tab)));
    return { success: true, count: suspendedTabs.length };
  }

  if (action === "get-stats") {
    const allTabs       = await browser.tabs.query({});
    const suspendedTabs = allTabs.filter(t => isSuspendPage(t.url));
    return {
      totalTabs:      allTabs.length,
      suspendedCount: suspendedTabs.length,
      activeTabs:     allTabs.length - suspendedTabs.length,
    };
  }

  if (action === "get-all-tabs-for-export") {
    const [allTabs, suspended] = await Promise.all([
      browser.tabs.query({}),
      getAllSuspended(),
    ]);

    const tabs = allTabs.filter(tab => !tab.incognito).map(tab => {
      if (isSuspendPage(tab.url)) {
        const uuid  = extractUUIDFromUrl(tab.url);
        const entry = uuid ? suspended[uuid] : null;
        let url   = entry?.originalUrl || "";
        let title = entry?.title       || "";

        if (!url) {
          try {
            const params = new URL(tab.url).searchParams;
            url   = params.get("url") || "";
            title = params.get("t") || url;
          } catch {}
        }

        return {
          url:       url || tab.url,
          title:     title || tab.title,
          suspended: true,
          pinned:    tab.pinned,
          windowId:  tab.windowId,
        };
      }
      return {
        url:       tab.url,
        title:     tab.title,
        suspended: false,
        pinned:    tab.pinned,
        windowId:  tab.windowId,
      };
    }).filter(t => !isBlockedUrl(t.url));

    return { tabs };
  }

  if (action === "get-auto-suspend-settings") {
    const settings = await getAutoSuspendSettings();
    return { settings };
  }

  if (action === "set-auto-suspend-settings") {
    const { settings } = message;
    await browser.storage.local.set({ autoSuspend: settings });
    await ensureAutoSuspendAlarm(settings);
    return { success: true };
  }

  if (action === "get-backup-settings") {
    const backupIntervalMinutes = await getBackupIntervalMinutes();
    return { backupIntervalMinutes };
  }

  if (action === "set-backup-settings") {
    const requested = parseInt(message.backupIntervalMinutes, 10);
    const backupIntervalMinutes = Number.isFinite(requested)
      ? Math.min(MAX_BACKUP_INTERVAL_MINUTES, Math.max(MIN_BACKUP_INTERVAL_MINUTES, requested))
      : DEFAULT_BACKUP_INTERVAL_MINUTES;
    await browser.storage.local.set({ backupIntervalMinutes });
    await ensureBackupAlarm();
    return { success: true, backupIntervalMinutes };
  }
}

// Chromium ignores a Promise returned from an async listener. Answer through sendResponse and return a literal true.
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((result) => sendResponse(result))
    .catch((err) => sendResponse({ error: String(err?.message || err) }));
  return true;
});

async function createBackup() {
  const [allTabs, suspended] = await Promise.all([
    browser.tabs.query({}),
    getAllSuspended(),
  ]);

  const tabSnapshots = allTabs.filter((tab) => !tab.incognito).map((tab) => {
    if (isSuspendPage(tab.url)) {
      const uuid  = extractUUIDFromUrl(tab.url);
      const entry = uuid ? suspended[uuid] : null;

      let originalUrl = entry?.originalUrl || "";
      let title       = entry?.title       || "";

      if (!originalUrl) {
        try {
          const params = new URL(tab.url).searchParams;
          originalUrl  = params.get("url") || "";
          title        = params.get("t") || originalUrl;
        } catch {}
      }

      return {
        url:       originalUrl || tab.url,
        title:     title || tab.title || originalUrl,
        favIconUrl: storableFavIconUrl(entry?.favIconUrl),
        suspended: true,
        pinned:    tab.pinned,
        windowId:  tab.windowId,
      };
    }
    return {
      url:       tab.url,
      title:     tab.title || tab.url,
      favIconUrl: storableFavIconUrl(tab.favIconUrl),
      suspended: false,
      pinned:    tab.pinned,
      windowId:  tab.windowId,
    };
  });

  const filteredTabs = tabSnapshots.filter((t) => !isBlockedUrl(t.url));

  const snapshot = {
    timestamp: new Date().toISOString(),
    tabCount:  filteredTabs.length,
    tabs:      filteredTabs,
  };

  await mutateBackups((backups) => {
    backups.unshift(snapshot);
    if (backups.length > MAX_BACKUPS) backups.splice(MAX_BACKUPS);
  });
}

async function getBackupIntervalMinutes() {
  const { backupIntervalMinutes = DEFAULT_BACKUP_INTERVAL_MINUTES } =
    await browser.storage.local.get("backupIntervalMinutes");
  return backupIntervalMinutes;
}

async function ensureBackupAlarm() {
  const minutes  = await getBackupIntervalMinutes();
  const existing = await browser.alarms.get(BACKUP_ALARM);
  // alarms.create with an existing name resets its countdown, so recreating it on every wake-up would stop periodic backups from ever firing.
  if (existing && existing.periodInMinutes === minutes) return;
  browser.alarms.create(BACKUP_ALARM, {
    periodInMinutes: minutes,
    delayInMinutes:  minutes,
  });
}

browser.alarms.onAlarm.addListener(async (alarm) => {
  await ensureInitialized();

  if (alarm.name === BACKUP_ALARM) {
    await createBackup();
    await detectOrphanedSuspended();
  }
  if (alarm.name === ORPHAN_STARTUP_ALARM) await detectOrphanedSuspended();
  if (alarm.name === AUTO_SUSPEND_ALARM) await autoSuspendCheck();
  sweepSuspendedTabs().catch(() => {});
});

async function getAutoSuspendSettings() {
  const { autoSuspend = { enabled: false, thresholdMinutes: 30 } } =
    await browser.storage.local.get("autoSuspend");
  return autoSuspend;
}

async function ensureAutoSuspendAlarm(settings) {
  const existing = await browser.alarms.get(AUTO_SUSPEND_ALARM);
  if (settings.enabled && !existing) {
    browser.alarms.create(AUTO_SUSPEND_ALARM, {
      periodInMinutes: AUTO_SUSPEND_CHECK_INTERVAL,
      delayInMinutes:  AUTO_SUSPEND_CHECK_INTERVAL,
    });
  } else if (!settings.enabled && existing) {
    await browser.alarms.clear(AUTO_SUSPEND_ALARM);
  }
}

async function autoSuspendCheck() {
  const settings = await getAutoSuspendSettings();
  if (!settings.enabled) return;

  const threshold = settings.thresholdMinutes * 60 * 1000;
  const now       = Date.now();
  const allTabs   = await browser.tabs.query({});

  const state = await readTabState();

  for (const tab of allTabs) {
    if (tab.pinned)              continue;
    // tab.active is live, so every window keeps its own active tab.
    if (tab.active)              continue;
    if (tab.audible)             continue;
    if (tab.discarded)           continue;
    if (tab.incognito)           continue;
    if (isSuspendPage(tab.url))  continue;
    if (isBlockedUrl(tab.url))   continue;

    const lastActive = state.lastActive[tab.id];
    if (lastActive === undefined) continue;

    if (now - lastActive >= threshold) {
      await suspendTab(tab).catch((err) => console.warn("[tab-suspender] automatic suspension failed:", err));
    }
  }
}

async function detectOrphanedSuspended() {
  const allTabs = await browser.tabs.query({});
  const suspended = await getAllSuspended();

  const openUUIDs = new Set();
  for (const tab of allTabs) {
    if (isSuspendPage(tab.url)) {
      const uuid = extractUUIDFromUrl(tab.url);
      if (uuid) openUUIDs.add(uuid);
    }
  }

  const cutoff   = Date.now() - ORPHAN_MIN_AGE_MS;
  const orphaned = Object.entries(suspended).filter(([uuid, entry]) =>
    !openUUIDs.has(uuid) && new Date(entry.suspendedAt).getTime() < cutoff);
  if (orphaned.length === 0) return;

  const orphanedTabs = orphaned.filter(([, entry]) => !isBlockedUrl(entry.originalUrl)).map(([, entry]) => ({
    url:       entry.originalUrl,
    title:     entry.title,
    favIconUrl: storableFavIconUrl(entry.favIconUrl),
    suspended: true,
    pinned:    false,
    windowId:  null,
  }));

  const snapshot = {
    timestamp:         new Date().toISOString(),
    tabCount:          orphanedTabs.length,
    tabs:              orphanedTabs,
    isOrphanedSession: true,
  };

  await mutateBackups((backups) => {
    backups.unshift(snapshot);
    if (backups.length > MAX_BACKUPS) backups.splice(MAX_BACKUPS);
  });

  await browser.storage.local.remove(orphaned.map(([uuid]) => suspendedKey(uuid)));
}

// The service worker is stopped when idle and module variables are lost, and onInstalled/onStartup do not fire again.
// Idle clocks and tab positions therefore live in storage.session.
const TAB_STATE_KEY = "tabState";

function emptyTabState() {
  return { urls: {}, index: {}, lastActive: {}, activeTabId: null };
}

async function readTabState() {
  try {
    const got = await browser.storage.session.get(TAB_STATE_KEY);
    return { ...emptyTabState(), ...(got?.[TAB_STATE_KEY] || {}) };
  } catch {
    return emptyTabState();
  }
}

// Listeners fire concurrently; the chain keeps read-modify-write steps from overwriting each other.
let tabStateChain = Promise.resolve();

function mutateTabState(fn) {
  tabStateChain = tabStateChain.then(async () => {
    const state = await readTabState();
    fn(state);
    await browser.storage.session.set({ [TAB_STATE_KEY]: state });
    return state;
  }).catch(() => {});
  return tabStateChain;
}

async function refreshIndexCache(windowId) {
  const tabs = await browser.tabs.query({ windowId });
  await mutateTabState((st) => {
    for (const t of tabs) st.index[t.id] = { index: t.index, windowId: t.windowId };
  });
}

function forgetTab(st, tabId) {
  delete st.urls[tabId];
  delete st.index[tabId];
  delete st.lastActive[tabId];
}

browser.tabs.onActivated.addListener(async ({ tabId }) => {
  await ensureInitialized();

  let previousTabId = null;
  await mutateTabState((st) => {
    previousTabId = st.activeTabId;
    st.activeTabId = tabId;
    st.lastActive[tabId] = Date.now();
    if (previousTabId !== null && previousTabId !== tabId) st.lastActive[previousTabId] = Date.now();
  });

  await updateToggleMenuTitle(tabId);

  sweepSuspendedTabs().catch(() => {});
});

browser.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete") {
    if (isSuspendPage(tab.url)) discardSuspendedTab(tabId).catch(() => {});
    else restoringUntil.delete(tabId);
  }

  const urlChanged = Boolean(changeInfo.url || changeInfo.status === "complete");
  if (!urlChanged) return;

  await mutateTabState((st) => {
    if (urlChanged && tab.url) st.urls[tabId] = tab.url;
    if (tab.index !== undefined) st.index[tabId] = { index: tab.index, windowId: tab.windowId };
  });

  if (urlChanged && tab.active) await updateToggleMenuTitle(tabId);
});

// Chromium can swap a tab for a new tabId (prerender, discard). Re-key the state or the suspended record leaks.
browser.tabs.onReplaced.addListener(async (addedTabId, removedTabId) => {
  await mutateTabState((st) => {
    if (st.urls[removedTabId] !== undefined)       st.urls[addedTabId]       = st.urls[removedTabId];
    if (st.index[removedTabId] !== undefined)      st.index[addedTabId]      = st.index[removedTabId];
    if (st.lastActive[removedTabId] !== undefined) st.lastActive[addedTabId] = st.lastActive[removedTabId];
    if (st.activeTabId === removedTabId)           st.activeTabId            = addedTabId;
    forgetTab(st, removedTabId);
  });
});

browser.tabs.onMoved.addListener(async (tabId, moveInfo) => {
  await refreshIndexCache(moveInfo.windowId);
});

browser.tabs.onCreated.addListener(async (tab) => {
  await mutateTabState((st) => {
    if (tab.url) st.urls[tab.id] = tab.url;
    st.index[tab.id] = { index: tab.index, windowId: tab.windowId };
    st.lastActive[tab.id] = Date.now();
  });
  await refreshIndexCache(tab.windowId);
});

browser.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
  await ensureInitialized();

  if (removeInfo.isWindowClosing) {
    await mutateTabState((st) => forgetTab(st, tabId));
    return;
  }

  // Read and delete in one step, a separate read can miss a queued write.
  let before = null;
  await mutateTabState((st) => {
    before = {
      url:       st.urls[tabId],
      index:     st.index[tabId],
      wasActive: st.activeTabId === tabId,
    };
    forgetTab(st, tabId);
  });
  if (!before) return;

  const cachedUrl = before.url;
  if (cachedUrl && isSuspendPage(cachedUrl)) {
    const uuid = extractUUIDFromUrl(cachedUrl);
    if (uuid && !(await uuidInUseElsewhere(uuid, tabId))) {
      await deleteSuspendedEntry(uuid);
    }
  }

  if (!before.wasActive || !before.index) return;

  const cached = before.index;

  const { index: closedIndex, windowId } = cached;
  const remaining = await browser.tabs.query({ windowId });
  if (remaining.length === 0) return;

  remaining.sort((a, b) => a.index - b.index);

  const target = remaining.find(t => t.index >= closedIndex)
              ?? remaining[remaining.length - 1];

  if (target && !target.active) {
    await browser.tabs.update(target.id, { active: true });
  }
});

async function migrateStorage() {
  const { storageVersion = 1 } = await browser.storage.local.get("storageVersion");
  if (storageVersion >= STORAGE_VERSION) return;

  const { suspended } = await browser.storage.local.get("suspended");
  if (suspended && typeof suspended === "object") {
    const batch = {};
    for (const [uuid, entry] of Object.entries(suspended)) {
      batch[suspendedKey(uuid)] = { ...entry, favIconUrl: storableFavIconUrl(entry.favIconUrl) };
    }
    if (Object.keys(batch).length) await browser.storage.local.set(batch);
    await browser.storage.local.remove("suspended");
  }

  await mutateBackups((backups) => {
    for (const snapshot of backups) {
      for (const t of snapshot.tabs || []) t.favIconUrl = storableFavIconUrl(t.favIconUrl);
    }
  });

  await browser.storage.local.set({ storageVersion: STORAGE_VERSION });
}

async function initialize() {
  await migrateStorage();
  await ensureBackupAlarm();

  const autoSuspendSettings = await getAutoSuspendSettings();
  await ensureAutoSuspendAlarm(autoSuspendSettings);

  const allTabs = await browser.tabs.query({});
  const now = Date.now();

  await mutateTabState((st) => {
    for (const tab of allTabs) {
      if (tab.url) st.urls[tab.id] = tab.url;
      st.index[tab.id] = { index: tab.index, windowId: tab.windowId };
      // Never overwrite: this reruns on every wake-up, and resetting idle clocks would keep automatic suspension from ever firing.
      if (st.lastActive[tab.id] === undefined) st.lastActive[tab.id] = now;
      if (tab.active && st.activeTabId === null) st.activeTabId = tab.id;
    }
  });
}

// Only on install and startup: on every wake-up it would drop the record of a tab that closed while the worker slept.
async function pruneDeadTabState() {
  const allTabs = await browser.tabs.query({});
  await mutateTabState((st) => {
    const live = new Set(allTabs.map((t) => String(t.id)));
    for (const key of Object.keys(st.lastActive)) {
      if (!live.has(key)) {
        delete st.lastActive[key];
        delete st.urls[key];
        delete st.index[key];
      }
    }
  });
}

// Every listener that touches tab state awaits this first. Safe to call repeatedly.
let initPromise = null;

function ensureInitialized() {
  if (!initPromise) {
    initPromise = initialize().catch((err) => {
      initPromise = null;
      throw err;
    });
  }
  return initPromise;
}

browser.runtime.onInstalled.addListener(async () => {
  await ensureInitialized();
  await pruneDeadTabState();
  await setupContextMenus();
});

browser.runtime.onStartup.addListener(async () => {
  await ensureInitialized();
  await pruneDeadTabState();
  await setupContextMenus();
  // Session restore may still be adding tabs; scanning now could delete valid records, so the scan runs from an alarm.
  browser.alarms.create(ORPHAN_STARTUP_ALARM, { delayInMinutes: 1 });
  sweepSuspendedTabs().catch(() => {});
});

// Chromium has no tab strip context, the toolbar icon menu replaces it.
const MENU_CONTEXTS = ["page", "action"];

const TOGGLE_TITLE_SUSPEND = msg("menuSuspend");
const TOGGLE_TITLE_RESTORE = msg("menuRestore");

async function setupContextMenus() {
  await browser.contextMenus.removeAll();

  browser.contextMenus.create({
    id: "root",
    title: "Tab Suspender",
    contexts: MENU_CONTEXTS,
  });

  browser.contextMenus.create({
    id: "toggle-suspend",
    parentId: "root",
    title: TOGGLE_TITLE_SUSPEND,
    contexts: MENU_CONTEXTS,
  });

  browser.contextMenus.create({
    id: "sep-1",
    parentId: "root",
    type: "separator",
    contexts: MENU_CONTEXTS,
  });

  browser.contextMenus.create({
    id: "backup-now",
    parentId: "root",
    title: msg("menuBackupNow"),
    contexts: MENU_CONTEXTS,
  });

  browser.contextMenus.create({
    id: "open-popup",
    parentId: "root",
    title: msg("menuShowBackups"),
    contexts: MENU_CONTEXTS,
  });

  const [active] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
  if (active) await updateToggleMenuTitle(active.id);
}

// Chromium has no menus.onShown, so the label is updated ahead of time whenever the active tab changes.
async function updateToggleMenuTitle(tabId) {
  try {
    const tab = await browser.tabs.get(tabId);
    if (!tab.active) return;
    await browser.contextMenus.update("toggle-suspend", {
      title: isSuspendPage(tab.url) ? TOGGLE_TITLE_RESTORE : TOGGLE_TITLE_SUSPEND,
    });
  } catch {
  }
}

browser.contextMenus.onClicked.addListener(async (info, tab) => {
  await ensureInitialized();
  const { menuItemId } = info;

  if (menuItemId === "toggle-suspend") {
    if (!tab) return;
    if (isSuspendPage(tab.url)) {
      await unsuspendTab(tab);
    } else {
      await suspendTab(tab);
    }
    if (tab.id !== undefined) await updateToggleMenuTitle(tab.id);
    return;
  }

  if (menuItemId === "backup-now") {
    await createBackup();
    return;
  }

  if (menuItemId === "open-popup") {
    try {
      await browser.action.openPopup();
    } catch {
      await browser.tabs.create({ url: browser.runtime.getURL("popup/popup.html") });
    }
    return;
  }
});

/**
 * Tab Suspender — background.js (Chromium / Brave)
 * Service worker. Suspend/unsuspend mantığı, backup sistemi, state yönetimi.
 */

// Chromium'da `browser` namespace'i yok, Firefox'ta ikisi de var.
const browser = globalThis.browser ?? globalThis.chrome;
const msg = (key) => browser.i18n.getMessage(key);

// ─── Sabitler ────────────────────────────────────────────────────────────────

const SUSPEND_PAGE                = browser.runtime.getURL("suspend/suspend.html");
const BACKUP_ALARM                = "tab-backup";
const AUTO_SUSPEND_ALARM          = "auto-suspend-check";
const ORPHAN_STARTUP_ALARM        = "orphan-startup-check";
const ORPHAN_MIN_AGE_MS           = 10 * 60 * 1000; // yeni askiya alinan (navigasyonu suren) sekmenin kaydi orphan sayilmaz
const DEFAULT_BACKUP_INTERVAL_MINUTES = 5;
const MIN_BACKUP_INTERVAL_MINUTES     = 1;
const MAX_BACKUP_INTERVAL_MINUTES     = 180;
const AUTO_SUSPEND_CHECK_INTERVAL = 1; // dakika
const MAX_BACKUPS                 = 20;
const FAVICON_TIMEOUT_MS          = 2000; // greyscale favicon üretimi bu süreyi aşarsa discard'ı bekletmeyi bırak
const FAVICON_PERSIST_GRACE_MS    = 350;  // favicon set edildikten sonra tarayıcının session store'a kaydetmesi için pay

// ─── Yardımcı fonksiyonlar ────────────────────────────────────────────────────

function generateUUID() {
  return crypto.randomUUID();
}

/** Cogaltilan/yeniden acilan sekmeler ayni uuid'yi tasir; baska sekme kullaniyorsa kayit silinmemeli. */
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

/** Suspend URL'sindeki `url=` parametresi — storage'dan bagimsiz geri yukleme yolu. */
function urlParamOf(suspendUrl) {
  try {
    const raw = new URL(suspendUrl).searchParams.get("url");
    if (!raw) return "";
    // Kendi suspend sayfamiza ya da engelli bir semaya geri donmeyi reddet
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

/**
 * Yalniz http(s) askiya alinabilir/geri yuklenebilir; geri kalan her sey (data:, file:,
 * javascript:, brave:, chrome-extension: ...) engelli. Allowlist: blocklist buyuk/kucuk harf
 * ve bastaki bosluk ("DATA:", " javascript:") ile atlatilabiliyordu.
 * DIKKAT: suspend sayfasi da chrome-extension: semasinda; isBlockedUrl() cagrilarinin
 * HEPSINDE isSuspendPage() kontrolu ONCE gelmeli, yoksa geri yukleme calismaz.
 */
function isBlockedUrl(url) {
  if (!url) return true;
  try {
    const protocol = new URL(url).protocol;
    return protocol !== "http:" && protocol !== "https:";
  } catch {
    return true;
  }
}

// ─── Storage yardımcıları ─────────────────────────────────────────────────────

/**
 * KRITIK: askidaki sekme kayitlari SEKME BASINA ayri anahtarda (`s:<uuid>`). Eskiden tek bir
 * `suspended` blob'u vardi: her degisiklik tum blob'u okuyup geri yaziyor, es zamanli
 * yazicilar birbirini eziyordu (toplu suspend'de kayip ikon/kayit) ve her yazim tum acik
 * suspend sayfalarina yayinlaniyordu. Tek-anahtar yazimlari birbirini ezemez; blob'u geri
 * getirme. Eski blob migrateStorage() ile tasinir.
 */
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

/** Tum kayitlar {uuid: entry}. get(null) yedekleri de okur: yalniz seyrek yollarda (yedek, orphan taramasi, disa aktarma). */
async function getAllSuspended() {
  const all = await browser.storage.local.get(null);
  const out = {};
  for (const [key, value] of Object.entries(all)) {
    if (key.startsWith(SUSPENDED_PREFIX)) out[key.slice(SUSPENDED_PREFIX.length)] = value;
  }
  return out;
}

/** Yalniz kisa http(s) adresler saklanir; buyuk data: ikonlari yedekleri/kayitlari sisirirdi (kota 10 MB). */
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

// backups da okuma-degistirme-yazma: alarm, orphan taramasi ve popup silmesi birbirini ezmesin.
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

// ─── Greyscale favicon dönüşümü ──────────────────────────────────────────────

/**
 * Chromium'un favicon onbellegine giden extension-ici URL. "favicon" izni bunu acar.
 * Kritik: bu URL eklentinin kendi origin'inde oldugu icin fetch CORS'a takilmaz —
 * sitenin favicon URL'sini dogrudan fetch etmek ise cogu sitede CORS'tan sessizce
 * basarisiz olur (Firefox surumunde de aynisi oluyordu).
 */
function faviconCacheUrl(pageUrl, size) {
  const u = new URL(browser.runtime.getURL("/_favicon/"));
  u.searchParams.set("pageUrl", pageUrl);
  u.searchParams.set("size", String(size));
  return u.toString();
}

async function blobToDataUrl(blob) {
  // FileReader'in ServiceWorkerGlobalScope'ta varligina guvenmiyoruz;
  // arrayBuffer + btoa her worker baglaminda mevcut.
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  const CHUNK = 0x8000; // btoa girdisini parcalamazsak buyuk ikonlarda stack asimi olur
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return "data:image/png;base64," + btoa(bin);
}

const FAVICON_MAX_BYTES = 256 * 1024;

async function fetchFaviconBlob(favIconUrl, pageUrl) {
  const candidates = [];
  if (pageUrl && !isBlockedUrl(pageUrl)) candidates.push(faviconCacheUrl(pageUrl, 32));
  // favIconUrl sayfanin kontrolunde: yalniz http(s) ya da yerel data:image, boyut sinirli.
  if (favIconUrl && (!isBlockedUrl(favIconUrl) || favIconUrl.startsWith("data:image/"))) candidates.push(favIconUrl);

  // withTimeout fetch'i iptal etmez; indirme arkada surup belleğe dolmasin.
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
        // sonraki adaya gec
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

// ─── Suspend ─────────────────────────────────────────────────────────────────

// tabId → timestamp until which the tab must not be discarded (restore in flight).
// NOT (Chromium): bu Map service worker yeniden baslayinca bosalir; discardSuspendedTab
// icindeki status/pendingUrl kontrolleri bu durumu ayrica yakalar.
const restoringUntil = new Map();
const RESTORE_GUARD_MS = 15_000;
const FAVICON_WAIT_MS  = 2000; // tarayici gri ikonu sekmeye isleyene kadar discard'i en fazla bu kadar beklet
const FAVICON_POLL_MS  = 100;
const discardingTabs   = new Set();
const suspendingTabs  = new Set();

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function suspendTab(tab) {
  if (!tab || !tab.id) return { error: msg("errInvalidTab") };
  if (isSuspendPage(tab.url)) return { error: msg("errAlreadySuspended") };
  if (isBlockedUrl(tab.url)) return { error: msg("errNotSuspendable") };
  // Gizli sekmenin URL/basligi storage.local'a ve yedeklere diske yazilirdi.
  if (tab.incognito) return { error: msg("errIncognito") };
  // Hizli cift Alt+Shift+S: navigasyon commit olmadan ikinci cagri ikinci uuid uretirdi.
  if (suspendingTabs.has(tab.id)) return { error: msg("errSuspendInProgress") };
  suspendingTabs.add(tab.id);
  try {
    return await suspendTabUnguarded(tab);
  } finally {
    suspendingTabs.delete(tab.id);
  }
}

async function suspendTabUnguarded(tab) {
  // Sabitlenmiş sekmeler manuel olarak (popup/Alt+Shift+S/context menu) suspend
  // edilebilir — kullanıcı bunu bilinçli istiyor. Otomatik suspend ise pinned
  // sekmeleri hâlâ atlıyor (bkz. autoSuspendCheck).

  const uuid        = generateUUID();
  const suspendedAt = new Date().toISOString();

  // KRITIK: gri ikon navigasyondan ONCE uretilip kayda yazilir; suspend sayfasi
  // ilk render'da bulur. Sonradan yazilirsa discard ikon islenmeden tetiklenebiliyor
  // ve sekme duz eklenti ikonuyla donuyor (discard sonrasi sayfa bir daha guncellenemez).
  const greyFavIconUrl = await withTimeout(
    toGreyscaleFavicon(tab.favIconUrl || "", tab.url || ""),
    FAVICON_TIMEOUT_MS
  ).catch(() => "");

  // Storage hatasi (kota vb.) suspend'i durdurmasin: orijinal URL zaten suspend
  // URL'sindeki `url=` parametresinde tasiniyor.
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
  await browser.tabs.update(tab.id, { url: suspendUrl });

  // Discard burada YAPILMAZ: tabs.onUpdated (status=complete) ve sweepSuspendedTabs
  // tetikler. Per-call listener, tabs.update ile listener kaydi arasinda
  // `complete` olayini kacirabiliyordu.
  return { success: true, uuid };
}

/** Suspend sayfasi sekmeye gri ikonu islemeden discard etme (discard sonrasi ikon donar). */
async function waitForTabFavicon(tab) {
  const uuid  = extractUUIDFromUrl(tab.url);
  const entry = uuid ? await getSuspendedEntry(uuid) : null;
  if (entry?.greyFavIconUrl) {
    // suspend.html'deki statik <link rel=icon> eklenti ikonunu hemen raporlar;
    // gri ikon ancak JS calisinca gelir ve `data:` olarak raporlanir.
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
  // Restore navigasyonu suruyorsa tab.url commit'e kadar hala suspend sayfasini
  // gosterir; discard o navigasyonu iptal edip sekmeyi suspend ekraninda dondurur.
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

    // Beklerken kullanici sekmeye gecmis ya da restore etmis olabilir: taze durum.
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

/** Aktif olmayan, yuklenmis tum suspend sayfalarini discard eder (RAM'i asil bosaltan yol). */
async function sweepSuspendedTabs() {
  const tabs = await browser.tabs.query({});
  await Promise.allSettled(
    tabs.filter((t) => isSuspendPage(t.url) && !t.active && !t.discarded)
        .map((t) => discardSuspendedTab(t.id))
  );
}

// ─── Unsuspend ────────────────────────────────────────────────────────────────

async function unsuspendTab(tab) {
  if (!tab || !tab.id) return { error: msg("errInvalidTab") };
  if (!isSuspendPage(tab.url)) return { error: msg("errNotSuspended") };

  const uuid = extractUUIDFromUrl(tab.url);
  if (!uuid) return { error: msg("errNoId") };

  const entry = await getSuspendedEntry(uuid);

  // Storage kaydi tek dogruluk kaynagi DEGIL: suspend URL'si orijinal adresi
  // `url=` parametresinde tasiyor ve bu, storage'a hic bagli olmayan bir yol.
  // Kayit herhangi bir sebeple eksikse (yazim kaybi, orphan temizligi, storage
  // hatasi) sekmeyi bos sayfaya gondermek yerine parametreden geri yukluyoruz —
  // aksi halde kullanici sekmenin adresini tamamen kaybediyor.
  const originalUrl = entry?.originalUrl || urlParamOf(tab.url);

  if (!originalUrl) {
    await browser.tabs.update(tab.id, { url: "chrome://newtab" });
    return { error: msg("errNoOriginalUrl") };
  }

  restoringUntil.set(tab.id, Date.now() + RESTORE_GUARD_MS);
  await browser.tabs.update(tab.id, { url: originalUrl });

  // Silme navigasyondan SONRA: navigasyon basarisiz olursa kayit durmali.
  if (!(await uuidInUseElsewhere(uuid, tab.id))) {
    await deleteSuspendedEntry(uuid);
  }

  return { success: true };
}

// ─── Toggle (kısayol tuşu) ────────────────────────────────────────────────────

browser.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-suspend") return;
  await ensureInitialized();

  const highlighted = await browser.tabs.query({ highlighted: true, currentWindow: true });
  if (!highlighted.length) return;

  if (highlighted.length > 1) {
    // Çoklu seçim toggle'ı: seçimin TAMAMI askıdaysa hepsini geri yükle,
    // aksi halde askıda olmayanları askıya al. Karışık seçimde suspend
    // yönünü seçiyoruz — böylece "hepsini askıya al" alışkanlığı bozulmuyor
    // ve yanlışlıkla 20 sekmeyi aynı anda yeniden yükletmek zorlaşıyor.
    const allSuspended = highlighted.every((tab) => isSuspendPage(tab.url));

    // Paralel: ikon uretimleri birbirini beklemesin; tek sekmedeki hata digerlerini durdurmasin.
    await Promise.allSettled(highlighted.map((tab) => {
      if (allSuspended) return unsuspendTab(tab);
      return isSuspendPage(tab.url) ? null : suspendTab(tab);
    }));
  } else {
    // Tek sekme: toggle davranışı
    const tab = highlighted[0];
    if (isSuspendPage(tab.url)) {
      await unsuspendTab(tab);
    } else {
      await suspendTab(tab);
    }
  }
});

// ─── Message handler ──────────────────────────────────────────────────────────

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
    // Index degil timestamp: popup acikken alarm yeni yedek ekleyip index'leri kaydirabilir.
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

  // Tüm workspace'lerdeki gerçek sekme sayısı (storage yerine gerçek sekme taraması)
  if (action === "get-stats") {
    const allTabs       = await browser.tabs.query({});
    const suspendedTabs = allTabs.filter(t => isSuspendPage(t.url));
    return {
      totalTabs:      allTabs.length,
      suspendedCount: suspendedTabs.length,
      activeTabs:     allTabs.length - suspendedTabs.length,
    };
  }

  // Tüm açık sekmeleri dışa aktar — suspended sekmeler gerçek URL ile
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

  // Otomatik askıya alma ayarları
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

// KRITIK (Chromium): onMessage listener'i `async` yapilirsa donen Promise
// YOK SAYILIR — sadece literal `true` donmek kanali acik tutar ve yanit
// sendResponse ile verilmek zorundadir. Firefox'ta async listener'in donusu
// dogrudan yanit olurdu; popup burada yanit bekledigi icin bu sarma sart.
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((result) => sendResponse(result))
    .catch((err) => sendResponse({ error: String(err?.message || err) }));
  return true;
});

// ─── Backup sistemi ───────────────────────────────────────────────────────────

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
  // KRITIK: alarms.create ayni isimle geri sayimi SIFIRLAR; service worker her
  // uyandiginda bu cagrilirsa periyodik yedek hic tetiklenmez. Yalniz alarm yoksa
  // ya da aralik degistiyse olustur.
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
    // Sadece tarayıcı başlangıcında değil, periyodik olarak da orphan
    // temizliği yap — uzun süre kapatılmayan oturumlarda (pencere kapatma,
    // sekme yarış durumları vb.) suspended storage'ın sınırsız büyümesini
    // önler.
    await detectOrphanedSuspended();
  }
  if (alarm.name === ORPHAN_STARTUP_ALARM) await detectOrphanedSuspended();
  if (alarm.name === AUTO_SUSPEND_ALARM) await autoSuspendCheck();
  sweepSuspendedTabs().catch(() => {});
});

// ─── Otomatik askıya alma ─────────────────────────────────────────────────────

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
    // tab.active canli deger: cok pencereli kullanimda her penceredeki aktif
    // sekme korunur (tek bir activeTabId sadece birini korurdu).
    if (tab.active)              continue;
    if (tab.audible)             continue; // muzik/goruntulu gorusme kesilmesin
    if (tab.discarded)           continue;
    if (tab.incognito)           continue;
    if (isSuspendPage(tab.url))  continue;
    if (isBlockedUrl(tab.url))   continue;

    const lastActive = state.lastActive[tab.id];
    if (lastActive === undefined) continue;

    if (now - lastActive >= threshold) {
      // Tek sekmedeki hata (ornegin surukleme sirasinda "Tabs cannot be edited right now")
      // kalan sekmelerin islenmesini durdurmasin.
      await suspendTab(tab).catch((err) => console.warn("[tab-suspender] automatic suspension failed:", err));
    }
  }
}

// ─── Önceki oturum orphan tespiti ────────────────────────────────────────────

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

  // Navigasyonu suren sekmede tab.url commit'e kadar eski adresi gosterir; yeni kayitlari atla.
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

  // Silme yedek yazildiktan SONRA: yalniz oksuz uuid anahtarlari silinir, aradaki
  // bir suspend'in yazdigi yeni kayitlara dokunulmaz.
  await browser.storage.local.remove(orphaned.map(([uuid]) => suspendedKey(uuid)));
}

// ─── Tab state (service worker'i asan kalici state) ──────────────────────────

// KRITIK (Chromium): service worker ~30 sn bostan sonra oldurulur, uyaninca
// top-level kod bastan calisir ve modul-seviyesi Map'ler BOSALIR. Ayrica
// onInstalled/onStartup bu uyanmalarda tekrar FIRE ETMEZ. Bu state modul
// degiskeninde tutulursa: (a) "son aktif olma zamani" her uyanista silinir ve
// otomatik askiya alma hicbir zaman esigi gecemez, (b) sekme kapaninca hangi
// sekmeye odaklanilacagi bilinemez. O yuzden storage.session kullaniliyor —
// bellekte durur, tarayici kapaninca silinir; tam istedigimiz omur.
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

// Bircok listener ayni anda tetiklenebiliyor. Serilestirmezsek read-modify-write
// yarisi olusur ve son yazan digerlerinin degisikligini silerdi.
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
    // Sekmeden AYRILDIGI an da bosta sayaci baslar; yoksa uzun suredir kullanilan
    // sekme ayrilir ayrilmaz otomatik askiya alinirdi.
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
  if (!urlChanged) return; // baslik/ikon/ses olaylari state yazmasin

  await mutateTabState((st) => {
    if (urlChanged && tab.url) st.urls[tabId] = tab.url;
    if (tab.index !== undefined) st.index[tabId] = { index: tab.index, windowId: tab.windowId };
  });

  // Chromium'da menus.onShown/refresh yok — "Askiya Al" / "Geri Yukle" etiketini
  // menu acilirken degil, aktif sekme degistiginde onden guncelliyoruz.
  if (urlChanged && tab.active) await updateToggleMenuTitle(tabId);
});

// Chromium bazi durumlarda (prerender takasi, discard) bir sekmeyi yeni bir
// tabId ile degistirebiliyor. State'imiz tabId ile anahtarlandigi icin
// yeniden anahtarlamazsak: askidaki sekmenin URL kaydi oksuz kalir, sekme
// kapaninca `suspended` blob'undan silinmez ve blob sismeye baslar.
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

// ─── Tab kapatılınca ──────────────────────────────────────────────────────────

browser.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
  await ensureInitialized();

  if (removeInfo.isWindowClosing) {
    await mutateTabState((st) => forgetTab(st, tabId));
    return;
  }

  // Okuma ve silme AYNI mutasyon adiminda: ayri bir readTabState() cagrisi
  // zincirde bekleyen yazimi kacirip kapanan sekmenin URL/index'ini kaybedebilir.
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

// ─── Başlangıç ────────────────────────────────────────────────────────────────

/**
 * v1 -> v2: `suspended` blob'unu sekme basina anahtarlara tasi, yedeklerdeki buyuk data:
 * ikonlarini at. Idempotent: yarida kesilirse sonraki uyanista yeniden calisir (once yaz, sonra sil).
 */
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
      // KRITIK: mevcut lastActive EZILMEZ. Service worker dakikada bir uyandigi
      // icin burasi sik sik yeniden calisir; her seferinde "simdi" yazsaydik
      // bosta kalma sayaci hic dolmaz ve otomatik askiya alma sessizce olurdu.
      if (st.lastActive[tab.id] === undefined) st.lastActive[tab.id] = now;
      // lastActive ile ayni kural: mevcut degeri EZME. Aksi halde SW olduktan
      // sonra kullanici sekme degistirdiginde initialize() once activeTabId'yi
      // YENI sekmeye set eder, onActivated da "onceki sekme" olarak yine ayni
      // sekmeyi gorur ve askidaki eski sekme icin discard tekrari hic tetiklenmez
      // (RAM'i asil bosaltan yol budur).
      if (tab.active && st.activeTabId === null) st.activeTabId = tab.id;
    }
  });
}

/**
 * Biz uyurken kapanmis sekmelerin kaydini temizler. YALNIZ onStartup/onInstalled'da:
 * initialize() her uyanista calisir ve onRemoved'u tetikleyen uyanista kapanan sekmenin
 * kaydini onRemoved okumadan silerdi (suspended kaydi sizar, odak mantigi bozulurdu).
 */
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

// Service worker her uyandiginda top-level kod bastan calisir ama
// onInstalled/onStartup FIRE ETMEZ. Bu yuzden state'e dokunan her listener
// once burayi bekler; idempotent oldugu icin tekrar cagrilmasi zararsiz.
let initPromise = null;

function ensureInitialized() {
  if (!initPromise) {
    initPromise = initialize().catch((err) => {
      initPromise = null; // basarisiz init'i onbellege alma, sonraki listener tekrar denesin
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
  // Session restore sekmeleri eklemeyi bitirmeden taranirsa mesru kayitlar silinirdi:
  // tarama kisa bir gecikmeyle alarmdan yapilir.
  browser.alarms.create(ORPHAN_STARTUP_ALARM, { delayInMinutes: 1 });
  sweepSuspendedTabs().catch(() => {});
});

// ─── Context Menü ─────────────────────────────────────────────────────────────

// DIKKAT (Chromium): `contexts: ["tab"]` YOK — sekme seridi sag tik menusu
// eklentilere kapali. Firefox surumundeki sekme-seridi girisi burada
// kaybolur; yerine araç çubuğu ikonunun sag tik menusu ("action") eklendi.
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

/**
 * Chromium'da `contextMenus.onShown` / `refresh()` yok — menu acilirken baslik
 * degistirilemiyor. Bu yuzden etiket ONDEN, aktif sekme her degistiginde
 * guncelleniyor. Menu her zaman aktif sekmenin durumunu gosterir.
 */
async function updateToggleMenuTitle(tabId) {
  try {
    const tab = await browser.tabs.get(tabId);
    if (!tab.active) return;
    await browser.contextMenus.update("toggle-suspend", {
      title: isSuspendPage(tab.url) ? TOGGLE_TITLE_RESTORE : TOGGLE_TITLE_SUSPEND,
    });
  } catch {
    // Sekme kapanmis ya da menuler henuz kurulmamis olabilir — sessizce gec.
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
    // openPopup() Chromium'da kullanici jesti / uygun pencere yoksa reddedebiliyor.
    // Sessizce olu bir menu girisi birakmamak icin popup'i sekmede aciyoruz.
    try {
      await browser.action.openPopup();
    } catch {
      await browser.tabs.create({ url: browser.runtime.getURL("popup/popup.html") });
    }
    return;
  }
});

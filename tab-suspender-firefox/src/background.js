/**
 * Zen Tab Suspender — background.js
 * Service worker. Suspend/unsuspend mantığı, backup sistemi, state yönetimi.
 */

const msg = (key) => browser.i18n.getMessage(key);

// ─── Sabitler ────────────────────────────────────────────────────────────────

const SUSPEND_PAGE                = browser.runtime.getURL("suspend/suspend.html");
const BACKUP_ALARM                = "tab-backup";
const AUTO_SUSPEND_ALARM          = "auto-suspend-check";
const ORPHAN_STARTUP_ALARM        = "orphan-startup-check";
const ORPHAN_MIN_AGE_MS           = 10 * 60 * 1000; // yeni askıya alınan (navigasyonu süren) sekmenin kaydı orphan sayılmaz
const DEFAULT_BACKUP_INTERVAL_MINUTES = 5;
const MIN_BACKUP_INTERVAL_MINUTES     = 1;
const MAX_BACKUP_INTERVAL_MINUTES     = 180;
const AUTO_SUSPEND_CHECK_INTERVAL = 1; // dakika
const MAX_BACKUPS                 = 20;
const FAVICON_TIMEOUT_MS          = 2000; // greyscale favicon üretimi bu süreyi aşarsa discard'ı bekletmeyi bırak
const FAVICON_PERSIST_GRACE_MS    = 350;  // favicon set edildikten sonra Firefox'un session store'a kaydetmesi için pay

// ─── Yardımcı fonksiyonlar ────────────────────────────────────────────────────

function generateUUID() {
  return crypto.randomUUID();
}

/** Çoğaltılan/yeniden açılan sekmeler aynı uuid'yi taşır; başka sekme kullanıyorsa kayıt silinmemeli. */
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

/** Suspend URL'sindeki `url=` parametresi — storage'dan bağımsız geri yükleme yolu. */
function urlParamOf(suspendUrl) {
  try {
    const raw = new URL(suspendUrl).searchParams.get("url");
    if (!raw) return "";
    // Kendi suspend sayfamıza ya da engelli bir şemaya geri dönmeyi reddet
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
 * Yalnız http(s) askıya alınabilir/geri yüklenebilir; geri kalan her şey (data:, file:,
 * javascript:, about:, moz-extension: ...) engelli. Allowlist: blocklist büyük/küçük harf
 * ve baştaki boşluk ("DATA:", " javascript:") ile atlatılabiliyordu.
 * DİKKAT: suspend sayfası da moz-extension: şemasında; isBlockedUrl() çağrılarının
 * HEPSİNDE isSuspendPage() kontrolü ÖNCE gelmeli, yoksa geri yükleme çalışmaz.
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

function formatTimestamp(isoString) {
  return new Date(isoString).toLocaleString("tr-TR", {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ─── Storage yardımcıları ─────────────────────────────────────────────────────

async function getSuspended() {
  const { suspended = {} } = await browser.storage.local.get("suspended");
  return suspended;
}

async function setSuspended(suspended) {
  await browser.storage.local.set({ suspended });
}

/**
 * KRITIK: `suspended` TEK bir storage anahtarı — her değişiklik tüm blob'u
 * okuyup geri yazıyor. Serileştirilmezse eş zamanlı yazıcılar birbirini ezer
 * (kayıp güncelleme): toplu suspend'de her sekme için arka planda çalışan
 * greyscale favicon yazımı diğerlerinin yazdığını siliyor. Brave portunda
 * ölçüldü: 12 sekmeden yalnızca 3'ünün ikonu yazılabiliyordu.
 * Blob'a dokunan HER yol bu zincirden geçmeli; çıplak getSuspended/setSuspended
 * çifti kullanma.
 */
let suspendedChain = Promise.resolve();

function mutateSuspended(fn) {
  const run = suspendedChain.then(async () => {
    const suspended = await getSuspended();
    const result = await fn(suspended);
    await setSuspended(suspended);
    return result;
  });
  suspendedChain = run.then(() => {}, () => {}); // zincir bir hatada kırılmasın
  return run;
}

async function getBackups() {
  const { backups = [] } = await browser.storage.local.get("backups");
  return backups;
}

async function setBackups(backups) {
  await browser.storage.local.set({ backups });
}

// backups da okuma-değiştirme-yazma: alarm, orphan taraması ve popup silmesi birbirini ezmesin.
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

const FAVICON_MAX_BYTES = 256 * 1024;

async function toGreyscaleFavicon(favIconUrl) {
  // favIconUrl sayfanın kontrolünde: yalnız http(s) ya da yerel data:image.
  if (!favIconUrl || (isBlockedUrl(favIconUrl) && !favIconUrl.startsWith("data:image/"))) return "";
  // withTimeout fetch'i iptal etmez; indirme arkada sürüp belleğe dolmasın.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FAVICON_TIMEOUT_MS);
  try {
    const response = await fetch(favIconUrl, { signal: controller.signal });
    if (!response.ok) return "";
    if (Number(response.headers.get("content-length") || 0) > FAVICON_MAX_BYTES) return "";
    const blob = await response.blob();
    if (blob.size > FAVICON_MAX_BYTES) return "";
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

    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => resolve("");
      reader.readAsDataURL(greyscaleBlob);
    });
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
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

// tabId → discard'dan önce beklenmesi gereken promise (greyscale favicon + persist payı).
// Hem waitForTabToLoad'daki ilk discard denemesi hem de discardIfSuspended (kullanıcı
// sekmeden uzaklaştığında) aynı promise'i bekler; discard hangi yoldan tetiklenirse
// tetiklensin favicon hazır olmadan tetiklenmesin diye.
const faviconReadyPromises = new Map();
const suspendingTabs      = new Set();

// tabId → bu zamana kadar discard edilmemeli (restore navigasyonu sürüyor).
const restoringUntil   = new Map();
const RESTORE_GUARD_MS = 15_000;

/**
 * Restore sürerken tab.url, navigasyon commit olana kadar hâlâ suspend sayfasını gösterir;
 * o sırada discard navigasyonu iptal edip sekmeyi suspend ekranında dondurur.
 */
function isDiscardable(t) {
  if (!t || t.discarded || t.active) return false;
  if (t.status === "loading") return false;
  if (!isSuspendPage(t.url)) return false;
  if (t.pendingUrl && !isSuspendPage(t.pendingUrl)) return false;
  if ((restoringUntil.get(t.id) || 0) > Date.now()) return false;
  return true;
}

async function suspendTab(tab) {
  if (!tab || !tab.id) return { error: msg("errInvalidTab") };
  if (isSuspendPage(tab.url)) return { error: msg("errAlreadySuspended") };
  if (isBlockedUrl(tab.url)) return { error: msg("errNotSuspendable") };
  // Gizli sekmenin URL/başlığı storage.local'a ve yedeklere diske yazılırdı.
  if (tab.incognito) return { error: msg("errIncognito") };
  // Hızlı çift Alt+Shift+S: navigasyon commit olmadan ikinci çağrı ikinci uuid üretirdi.
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
  // sekmeleri hâlâ atlıyor (bkz. autoSuspendCheck, satır ~612), o yüzden burada
  // ayrıca bir engel gerekmiyor.

  const uuid        = generateUUID();
  const suspendedAt = new Date().toISOString();

  // Sekme, storage yazımını beklemeden hemen suspend sayfasına geçiyor —
  // sayfa kritik veriyi zaten URL parametrelerinden okuyor, storage sadece
  // favicon gibi ekstra veriyi zenginleştiriyor. Büyümüş bir `suspended`
  // blob'unun tamamını okuyup yazmak (getSuspended/setSuspended) navigasyondan
  // ÖNCE yapılırsa, sekme sayısı arttıkça suspend sayfasının açılışı yavaşlar.
  const suspendUrl = buildSuspendUrl(uuid, tab.url, tab.title || tab.url, tab.favIconUrl || "");
  await browser.tabs.update(tab.id, { url: suspendUrl });

  await mutateSuspended((suspended) => {
    suspended[uuid] = {
      originalUrl: tab.url,
      title: tab.title || tab.url,
      favIconUrl: tab.favIconUrl || "",
      greyFavIconUrl: "",
      suspendedAt,
      windowId: tab.windowId,
    };
  });

  // Greyscale favicon üretimi (ağ isteği içerir) navigasyonu bloklamasın —
  // arka planda hesaplanır, storage'a yazılınca suspend.js kendi
  // storage.onChanged dinleyicisiyle sayfadaki ikonu günceller.
  const greyReady = updateGreyFavicon(uuid, tab.favIconUrl || "");

  // Discard'ı, greyscale favicon sayfaya uygulanana kadar (en fazla FAVICON_TIMEOUT_MS)
  // bekletiyoruz. Aksi halde discard, favicon hazır olmadan tetiklenirse sekme eklentinin
  // düz ikonuyla donuyor — discard sonrası sayfa artık JS çalıştırmadığından bir daha
  // güncellenemiyor ve bu, tarayıcı yeniden başlatıldığında da kalıcı oluyor. Bu promise'i
  // faviconReadyPromises'e de kaydediyoruz çünkü discard iki farklı yoldan tetiklenebilir:
  // burada (sayfa yüklendiğinde) ya da kullanıcı sekmeden uzaklaştığında (discardIfSuspended).
  const readyToDiscard = greyReady
    .catch(() => {}) // storage/network hatası discard'ı asla engellemesin
    .then(() => new Promise((resolve) => setTimeout(resolve, FAVICON_PERSIST_GRACE_MS)));
  faviconReadyPromises.set(tab.id, readyToDiscard);
  readyToDiscard.finally(() => {
    if (faviconReadyPromises.get(tab.id) === readyToDiscard) faviconReadyPromises.delete(tab.id);
  });

  waitForTabToLoad(tab.id, suspendUrl, async () => {
    await readyToDiscard;
    // Beklerken kullanıcı restore etmiş ya da sekmeyi kapatmış olabilir: taze durum.
    const fresh = await browser.tabs.get(tab.id).catch(() => null);
    if (!fresh || fresh.discarded || fresh.status === "loading" || !isSuspendPage(fresh.url)) return;
    if ((restoringUntil.get(tab.id) || 0) > Date.now()) return;
    browser.tabs.discard(tab.id).catch(() => {});
  });

  return { success: true, uuid };
}

async function updateGreyFavicon(uuid, favIconUrl) {
  const greyFavIconUrl = await withTimeout(toGreyscaleFavicon(favIconUrl), FAVICON_TIMEOUT_MS);
  if (!greyFavIconUrl) return;

  await mutateSuspended((suspended) => {
    if (!suspended[uuid]) return; // bu arada unsuspend edilmiş olabilir
    suspended[uuid].greyFavIconUrl = greyFavIconUrl;
  });
}

function waitForTabToLoad(tabId, expectedUrl, callback) {
  function listener(updatedTabId, changeInfo, tab) {
    if (updatedTabId === tabId && changeInfo.status === "complete") {
      if (tab.url && tab.url.startsWith(SUSPEND_PAGE)) {
        browser.tabs.onUpdated.removeListener(listener);
        callback();
      } else {
        browser.tabs.onUpdated.removeListener(listener);
      }
    }
  }
  browser.tabs.onUpdated.addListener(listener);
}

async function discardIfSuspended(tabId) {
  if (tabId === undefined || tabId === null) return;

  let tab;
  try {
    tab = await browser.tabs.get(tabId);
  } catch {
    return; // Sekme kapanmış olabilir
  }

  if (tab.discarded) return;
  if (!isSuspendPage(tab.url)) return;

  const pending = faviconReadyPromises.get(tabId);
  if (pending) await pending;

  // Beklerken kullanıcı restore edip sekmeye dönmüş olabilir: taze durum + restore koruması.
  const fresh = await browser.tabs.get(tabId).catch(() => null);
  if (!isDiscardable(fresh)) return;

  await browser.tabs.discard(tabId).catch(() => {});

  const after = await browser.tabs.get(tabId).catch(() => null);
  if (after && !after.discarded) {
    console.warn(`[tab-suspender] discard failed: tab ${tabId}`);
  }
}

// ─── Unsuspend ────────────────────────────────────────────────────────────────

async function unsuspendTab(tab) {
  if (!tab || !tab.id) return { error: msg("errInvalidTab") };
  if (!isSuspendPage(tab.url)) return { error: msg("errNotSuspended") };

  const uuid = extractUUIDFromUrl(tab.url);
  if (!uuid) return { error: msg("errNoId") };

  const entry = await mutateSuspended((suspended) => suspended[uuid]);

  // Storage kaydı tek doğruluk kaynağı DEĞİL: suspend URL'si orijinal adresi
  // `url=` parametresinde taşıyor ve bu, storage'a hiç bağlı olmayan bir yol.
  // Kayıt herhangi bir sebeple eksikse sekmeyi boş sayfaya göndermek yerine
  // parametreden geri yüklüyoruz — aksi halde kullanıcı adresi tamamen kaybediyor.
  const originalUrl = entry?.originalUrl || urlParamOf(tab.url);

  if (!originalUrl) {
    await browser.tabs.update(tab.id, { url: "about:newtab" });
    return { error: msg("errNoOriginalUrl") };
  }

  restoringUntil.set(tab.id, Date.now() + RESTORE_GUARD_MS);
  await browser.tabs.update(tab.id, { url: originalUrl });

  // Silme navigasyondan SONRA: navigasyon başarısız olursa kayıt durmalı.
  if (!(await uuidInUseElsewhere(uuid, tab.id))) {
    await mutateSuspended((suspended) => { delete suspended[uuid]; });
  }

  return { success: true };
}

// ─── Toggle (kısayol tuşu) ────────────────────────────────────────────────────

browser.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-suspend") return;

  const highlighted = await browser.tabs.query({ highlighted: true, currentWindow: true });
  if (!highlighted.length) return;

  if (highlighted.length > 1) {
    // Çoklu seçim toggle'ı: seçimin TAMAMI askıdaysa hepsini geri yükle,
    // aksi halde askıda olmayanları askıya al. Karışık seçimde suspend
    // yönünü seçiyoruz — böylece "hepsini askıya al" alışkanlığı bozulmuyor
    // ve yanlışlıkla 20 sekmeyi aynı anda yeniden yükletmek zorlaşıyor.
    const allSuspended = highlighted.every((tab) => isSuspendPage(tab.url));

    // Tek sekmedeki hata diğerlerini durdurmasın.
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

browser.runtime.onMessage.addListener(async (message, sender) => {
  if (sender.id !== browser.runtime.id) return { error: msg("errUnknownSender") };
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
    const suspended = await getSuspended();
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
      await mutateSuspended((suspended) => {
        suspended[uuid] = {
          originalUrl: url,
          title: title || url,
          favIconUrl: favIconUrl || "",
          suspendedAt: new Date().toISOString(),
          windowId: null,
        };
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
        await mutateSuspended((suspended) => {
          suspended[uuid] = {
            originalUrl: t.url,
            title: t.title || t.url,
            favIconUrl: t.favIconUrl || "",
            suspendedAt: new Date().toISOString(),
            windowId: null,
          };
        });
        await browser.tabs.create({ url: buildSuspendUrl(uuid, t.url, t.title, t.favIconUrl || ""), active: false });
      } else {
        await browser.tabs.create({ url: t.url, active: false });
      }
    }
    return { success: true };
  }

  if (action === "delete-backup") {
    // Index değil timestamp: popup açıkken alarm yeni yedek ekleyip index'leri kaydırabilir.
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
      getSuspended(),
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
            title = params.get("t") || "" || url;
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
});

// ─── Backup sistemi ───────────────────────────────────────────────────────────

async function createBackup() {
  const [allTabs, suspended] = await Promise.all([
    browser.tabs.query({}),
    getSuspended(),
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
          title        = params.get("t") || "" || originalUrl;
        } catch {}
      }

      return {
        url:       originalUrl || tab.url,
        title:     title || tab.title || originalUrl,
        favIconUrl: entry?.favIconUrl || "",
        suspended: true,
        pinned:    tab.pinned,
        windowId:  tab.windowId,
      };
    }
    return {
      url:       tab.url,
      title:     tab.title || tab.url,
      favIconUrl: tab.favIconUrl || "",
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
  // alarms.create aynı isimle geri sayımı SIFIRLAR: yalnız alarm yoksa ya da aralık değiştiyse oluştur.
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
  const state     = await readTabState();

  for (const tab of allTabs) {
    if (tab.pinned)              continue;
    if (tab.active)              continue;
    if (tab.audible)             continue; // müzik/görüntülü görüşme kesilmesin
    if (tab.discarded)           continue;
    if (tab.incognito)           continue;
    if (isSuspendPage(tab.url))  continue;
    if (isBlockedUrl(tab.url))   continue;

    const lastActive = state.lastActive[tab.id];
    if (lastActive === undefined) continue;

    if (now - lastActive >= threshold) {
      // Tek sekmedeki hata kalan sekmelerin işlenmesini durdurmasın.
      await suspendTab(tab).catch((err) => console.warn("[tab-suspender] automatic suspension failed:", err));
    }
  }
}

// ─── Önceki oturum orphan tespiti ────────────────────────────────────────────

async function detectOrphanedSuspended() {
  const allTabs = await browser.tabs.query({});
  const suspended = await mutateSuspended((s) => s); // zincir üzerinden tutarlı okuma

  const openUUIDs = new Set();
  for (const tab of allTabs) {
    if (isSuspendPage(tab.url)) {
      const uuid = extractUUIDFromUrl(tab.url);
      if (uuid) openUUIDs.add(uuid);
    }
  }

  // Navigasyonu süren sekmede tab.url commit'e kadar eski adresi gösterir; yeni kayıtları atla.
  const cutoff   = Date.now() - ORPHAN_MIN_AGE_MS;
  const orphaned = Object.entries(suspended).filter(([uuid, entry]) =>
    !openUUIDs.has(uuid) && new Date(entry.suspendedAt).getTime() < cutoff);
  if (orphaned.length === 0) return;

  const orphanedTabs = orphaned.filter(([, entry]) => !isBlockedUrl(entry.originalUrl)).map(([, entry]) => ({
    url:       entry.originalUrl,
    title:     entry.title,
    favIconUrl: entry.favIconUrl || "",
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

  // Silme yedek yazıldıktan SONRA ve zincir üzerinden: aradaki bir suspend
  // işleminin yazdığı yeni kayıtları ezmemek için blob tekrar okunup
  // yalnızca öksüz uuid'ler siliniyor.
  await mutateSuspended((current) => {
    for (const [uuid] of orphaned) delete current[uuid];
  });
}

// ─── Tab state ────────────────────────────────────────────────────────────────

// Firefox unloads an idle background script and later reruns it from the top, but onInstalled
// and onStartup do not fire again. State kept in module variables would be lost, so it lives
// in storage.session (memory only, cleared when the browser closes).
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
    // The idle clock of a tab also starts the moment you leave it.
    if (previousTabId !== null && previousTabId !== tabId) st.lastActive[previousTabId] = Date.now();
  });

  if (previousTabId !== null && previousTabId !== tabId) {
    discardIfSuspended(previousTabId);
  }
});

browser.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  const urlChanged = Boolean(changeInfo.url || changeInfo.status === "complete");
  if (!urlChanged) return;

  await mutateTabState((st) => {
    if (tab.url) st.urls[tabId] = tab.url;
    if (tab.index !== undefined) st.index[tabId] = { index: tab.index, windowId: tab.windowId };
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

// ─── Tab closed ───────────────────────────────────────────────────────────────

browser.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
  await ensureInitialized();

  if (removeInfo.isWindowClosing) {
    await mutateTabState((st) => forgetTab(st, tabId));
    return;
  }

  // Read and delete in one step, otherwise a queued write can make us miss this tab's URL and index.
  let before = null;
  await mutateTabState((st) => {
    before = { url: st.urls[tabId], index: st.index[tabId], wasActive: st.activeTabId === tabId };
    forgetTab(st, tabId);
  });
  if (!before) return;

  if (before.url && isSuspendPage(before.url)) {
    const uuid = extractUUIDFromUrl(before.url);
    if (uuid && !(await uuidInUseElsewhere(uuid, tabId))) {
      await mutateSuspended((suspended) => { delete suspended[uuid]; });
    }
  }

  if (!before.wasActive || !before.index) return;

  const { index: closedIndex, windowId } = before.index;
  const remaining = await browser.tabs.query({ windowId });
  if (remaining.length === 0) return;

  remaining.sort((a, b) => a.index - b.index);

  const target = remaining.find(t => t.index >= closedIndex)
              ?? remaining[remaining.length - 1];

  if (target && !target.active) {
    await browser.tabs.update(target.id, { active: true });
  }
});

// ─── Startup ──────────────────────────────────────────────────────────────────

async function initialize() {
  await ensureBackupAlarm();

  const autoSuspendSettings = await getAutoSuspendSettings();
  await ensureAutoSuspendAlarm(autoSuspendSettings);

  const allTabs = await browser.tabs.query({});
  const now = Date.now();

  await mutateTabState((st) => {
    for (const tab of allTabs) {
      if (tab.url) st.urls[tab.id] = tab.url;
      st.index[tab.id] = { index: tab.index, windowId: tab.windowId };
      // Never overwrite an existing value: this reruns on every wake-up, and resetting the idle clock each time would stop automatic suspension from ever firing.
      if (st.lastActive[tab.id] === undefined) st.lastActive[tab.id] = now;
      if (tab.active && st.activeTabId === null) st.activeTabId = tab.id;
    }
  });
}

// Only on install and browser start: running it on every wake-up would drop the record of a tab that closed while the script was unloaded.
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

// Every listener that touches tab state waits for this first; it is safe to call repeatedly.
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
});

// ─── Context Menü ─────────────────────────────────────────────────────────────

async function setupContextMenus() {
  await browser.menus.removeAll();

  browser.menus.create({
    id: "root",
    title: "Tab Suspender",
    contexts: ["page", "tab"],
  });

  browser.menus.create({
    id: "toggle-suspend",
    parentId: "root",
    title: msg("menuSuspend"),
    contexts: ["page", "tab"],
  });

  browser.menus.create({
    id: "sep-1",
    parentId: "root",
    type: "separator",
    contexts: ["page", "tab"],
  });

  browser.menus.create({
    id: "backup-now",
    parentId: "root",
    title: msg("menuBackupNow"),
    contexts: ["page", "tab"],
  });

  browser.menus.create({
    id: "open-popup",
    parentId: "root",
    title: msg("menuShowBackups"),
    contexts: ["page", "tab"],
  });
}

browser.menus.onShown.addListener(async (info, tab) => {
  if (!tab) return;

  const suspended = isSuspendPage(tab.url);

  await browser.menus.update("toggle-suspend", {
    title: suspended ? msg("menuRestore") : msg("menuSuspend"),
  });

  browser.menus.refresh();
});

browser.menus.onClicked.addListener(async (info, tab) => {
  const { menuItemId } = info;

  if (menuItemId === "toggle-suspend") {
    if (!tab) return;
    if (isSuspendPage(tab.url)) {
      await unsuspendTab(tab);
    } else {
      await suspendTab(tab);
    }
    return;
  }

  if (menuItemId === "backup-now") {
    await createBackup();
    return;
  }

  if (menuItemId === "open-popup") {
    browser.action.openPopup().catch(() => {});
    return;
  }
});

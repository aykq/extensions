/**
 * suspend.js
 *
 * Veri öncelik sırası:
 *   1. URL parametreleri  — her zaman mevcuttur, storage silinse de çalışır
 *   2. storage.local      — favicon, greyFavIconUrl gibi ekstra veriler için
 */

const msg = (key, ...subs) => browser.i18n.getMessage(key, subs.map(String));

let currentUUID = null;

// ─── DOM ─────────────────────────────────────────────────────────────────────

function show(id) { document.getElementById(id).classList.remove("hidden"); }
function hide(id) { document.getElementById(id).classList.add("hidden"); }

function setState(state) {
  hide("state-loading");
  hide("state-suspended");
  hide("state-error");
  show(`state-${state}`);
}

// Yalnız http(s): ?url= parametresi herhangi biri tarafından hazırlanabilir.
function isHttpUrl(value) {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

// ─── Zaman ───────────────────────────────────────────────────────────────────

function formatDate(isoString) {
  if (!isoString) return "—";
  return new Date(isoString).toLocaleString(browser.i18n.getUILanguage(), {
    day: "numeric", month: "long", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

function getElapsed(isoString) {
  if (!isoString) return "—";
  const ms = Date.now() - new Date(isoString).getTime();
  const s  = Math.floor(ms / 1000);
  const m  = Math.floor(s / 60);
  const h  = Math.floor(m / 60);
  const d  = Math.floor(h / 24);
  if (d > 0) return msg("elapsedDays", d, h % 24);
  if (h > 0) return msg("elapsedHours", h, m % 60);
  if (m > 0) return msg("elapsedMinutes", m);
  return msg("elapsedSeconds", s);
}

// ─── Favicon ─────────────────────────────────────────────────────────────────

function loadFavicon(favIconUrl) {
  const img      = document.getElementById("favicon");
  const fallback = document.getElementById("favicon-fallback");

  img.classList.add("hidden");
  fallback.classList.add("hidden");

  if (!favIconUrl) {
    fallback.classList.remove("hidden");
    return;
  }

  const test    = new Image();
  test.onload   = () => { img.src = favIconUrl; img.classList.remove("hidden"); };
  test.onerror  = () => { fallback.classList.remove("hidden"); };
  test.src      = favIconUrl;
}

function setTabFavicon(greyUrl) {
  // Öncelik: greyscale > extension'ın kendi pause ikonu (orijinal favicon'a asla dönme —
  // aksi halde greyscale üretimi CORS/eksik favicon nedeniyle başarısız olduğunda
  // suspend edilen sekme aktif bir sekmeden ayırt edilemez hale gelir)
  const url = greyUrl || browser.runtime.getURL("../icons/48.png");
  document.querySelectorAll("link[rel~='icon']").forEach(el => el.remove());
  const link  = document.createElement("link");
  link.rel    = "icon";
  link.type   = "image/png";
  link.href   = url;
  document.head.appendChild(link);
}

// ─── Elapsed timer ────────────────────────────────────────────────────────────

let elapsedInterval = null;

function startElapsedTimer(suspendedAt) {
  const update = () => setText("time-elapsed", getElapsed(suspendedAt));
  update();
  elapsedInterval = setInterval(update, 10_000);
}

// ─── Unsuspend ────────────────────────────────────────────────────────────────

async function doUnsuspend() {
  if (elapsedInterval) clearInterval(elapsedInterval);

  // Önce background'a mesaj gönder (storage'ı temizler ve navigate eder)
  try {
    const res = await browser.runtime.sendMessage({ action: "unsuspend" });
    // Background yanıt verdiyse (başarı ya da hata) navigasyonu o yönetiyor;
    // fallback'i de çalıştırmak iki navigasyonu yarıştırırdı.
    if (res) return;
  } catch (_) { /* background hazır değil olabilir */ }

  // Fallback: storage yoksa URL'den oku ve direkt navigate et
  const params      = new URLSearchParams(window.location.search);
  const originalUrl = params.get("url");
  if (originalUrl && isHttpUrl(originalUrl)) {
    window.location.href = originalUrl;
  }
}

// ─── Ana render ───────────────────────────────────────────────────────────────

async function render() {
  const params = new URLSearchParams(window.location.search);
  currentUUID  = params.get("id");

  // ── 1) URL parametrelerinden kritik veriyi al (her zaman güvenilir) ──
  const urlParam   = params.get("url");
  const titleParam = params.get("t");
  const tsParam    = params.get("ts");

  if (!urlParam) {
    // Çok eski format veya doğrudan açılmış — sadece bu durumda hata göster
    setState("error");
    return;
  }

  const favParam = params.get("fav");

  const baseEntry = {
    originalUrl   : urlParam,
    title         : titleParam || urlParam,
    suspendedAt   : tsParam || null,
    favIconUrl    : favParam || "",
    greyFavIconUrl: "",
  };

  // Storage'ı beklemeden hemen ayarla — depolama okuması yalnızca favicon gibi
  // ekstra verileri zenginleştiriyor, başlık her zaman URL parametrelerinden
  // güvenilir şekilde okunabiliyor. Bu, tarayıcının gerçek başlığı gösterene
  // kadar geçen süreyi kısaltır.
  document.title = baseEntry.title;
  setText("tab-title", baseEntry.title);

  // ── 2) Storage'dan ekstra veriyi zenginleştir (favicon vs.) ──
  if (currentUUID) {
    try {
      const { suspended = {} } = await browser.storage.local.get("suspended");
      const stored = suspended[currentUUID];
      if (stored) {
        baseEntry.favIconUrl     = stored.favIconUrl     || "";
        baseEntry.greyFavIconUrl = stored.greyFavIconUrl || "";
        // suspendedAt storage'dan daha kesin (URL encode edilirken kesilebilir)
        if (stored.suspendedAt) baseEntry.suspendedAt = stored.suspendedAt;
      }
    } catch (_) { /* storage okunamadı — sorun değil, baseEntry yeterli */ }
  }

  // ── 3) DOM'u doldur ── (title zaten yukarıda erken set edildi)
  const urlEl   = document.getElementById("tab-url");
  urlEl.textContent = baseEntry.originalUrl;
  urlEl.href        = isHttpUrl(baseEntry.originalUrl) ? baseEntry.originalUrl : "#";

  setText("suspended-at", formatDate(baseEntry.suspendedAt));

  loadFavicon(baseEntry.favIconUrl);
  setTabFavicon(baseEntry.greyFavIconUrl);

  if (baseEntry.suspendedAt) startElapsedTimer(baseEntry.suspendedAt);
  else setText("time-elapsed", "—");

  setState("suspended");
}

// ─── Event listeners ──────────────────────────────────────────────────────────

document.getElementById("btn-unsuspend").addEventListener("click", doUnsuspend);
document.getElementById("btn-newtab").addEventListener("click", () => {
  browser.tabs.create({ url: "about:newtab" });
});

// background.js greyscale favicon üretimini bitirip storage'a yazdığında
// (bu, sayfa ilk render olduğunda henüz hazır olmayabilir) sayfa hâlâ açıksa
// (discard edilmemişse) ikon burada güncellenir. tabs.sendMessage yerine
// storage.onChanged kullanıyoruz çünkü tabs.sendMessage yalnızca content
// script'lere ulaşır — suspend.html bir extension sayfası, content script değil.
browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.suspended || !currentUUID) return;
  const entry = changes.suspended.newValue?.[currentUUID];
  if (entry?.greyFavIconUrl) {
    setTabFavicon(entry.greyFavIconUrl);
  }
});

// Not: Alt+Shift+S burada AYRICA dinlenmiyor — background.js'teki global
// "toggle-suspend" komutu zaten bu sekmede tetiklenince isSuspendPage()
// kontrolüyle unsuspendTab()'i çağırıyor. İkisini birden dinlemek, sayfanın
// kendi yönlendirmesiyle global komutun aynı anda çalışıp birbirini yarışa
// sokmasına (ve sekmenin anında tekrar suspend edilmesine) yol açıyordu.

render();

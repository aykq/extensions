/**
 * popup.js — Extension popup mantığı
 * İstatistikler, backup listesi, backup detay + restore, ayarlar, export
 */

// Chromium'da `browser` namespace'i yok, Firefox'ta ikisi de var.
const browser = globalThis.browser ?? globalThis.chrome;

const msg = (key, ...subs) => browser.i18n.getMessage(key, subs.map(String));

// ─── State ────────────────────────────────────────────────────────────────────

let currentBackupIndex = null;
let backupsCache = [];

// ─── Mesaj yardımcısı ─────────────────────────────────────────────────────────

async function send(message) {
  try {
    return await browser.runtime.sendMessage(message);
  } catch (err) {
    console.error("[Popup] sendMessage failed:", err);
    return null;
  }
}

// ─── Toast ────────────────────────────────────────────────────────────────────

let toastTimer = null;

function showToast(msg) {
  let toast = document.querySelector(".toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.className = "toast";
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2000);
}

// ─── Tarih/saat formatı ───────────────────────────────────────────────────────

function formatTimestamp(isoString) {
  return new Date(isoString).toLocaleString(browser.i18n.getUILanguage(), {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ─── View yönetimi ────────────────────────────────────────────────────────────

function showView(id) {
  document.querySelectorAll(".view").forEach((v) => v.classList.add("hidden"));
  document.getElementById(id).classList.remove("hidden");
}

// ─── İstatistikler ────────────────────────────────────────────────────────────

async function loadStats() {
  const res = await send({ action: "get-stats" });
  if (!res) return;
  document.getElementById("stat-total").textContent     = res.totalTabs;
  document.getElementById("stat-active").textContent    = res.activeTabs;
  document.getElementById("stat-suspended").textContent = res.suspendedCount;
}

// ─── Backup listesi ───────────────────────────────────────────────────────────

async function loadBackups() {
  const res = await send({ action: "get-backups" });
  backupsCache = res?.backups || [];
  renderBackupList();
}

function renderBackupList() {
  const list  = document.getElementById("backup-list");
  const empty = document.getElementById("backup-empty");

  list.querySelectorAll(".backup-item").forEach((el) => el.remove());

  if (backupsCache.length === 0) {
    empty.style.display = "";
    return;
  }

  empty.style.display = "none";

  backupsCache.forEach((backup, index) => {
    const item = document.createElement("div");
    item.className    = "backup-item";
    item.dataset.index = index;

    // Önceki oturumdan kalan sekmeler — özel görsel
    if (backup.isOrphanedSession) {
      item.classList.add("backup-orphaned");
    }

    const suspendedInBackup = backup.tabs.filter((t) => t.suspended).length;
    const meta = suspendedInBackup > 0
      ? msg("tabsCountSuspended", backup.tabCount, suspendedInBackup)
      : msg("tabsCount", backup.tabCount);

    item.innerHTML = `
      <div class="backup-item-left">
        <span class="backup-time">${formatTimestamp(backup.timestamp)}</span>
        <span class="backup-meta">${meta}</span>
      </div>
      <div class="backup-item-right">
        <button class="btn-delete" data-index="${index}" title="${msg("titleDelete")}">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
            <path d="M10 11v6M14 11v6"/>
          </svg>
        </button>
        <svg class="chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="9 18 15 12 9 6"/>
        </svg>
      </div>
    `;

    item.addEventListener("click", (e) => {
      if (e.target.closest(".btn-delete")) return;
      openBackupDetail(index);
    });

    item.querySelector(".btn-delete").addEventListener("click", async (e) => {
      e.stopPropagation();
      await send({ action: "delete-backup", timestamp: backup.timestamp });
      backupsCache.splice(index, 1);
      renderBackupList();
      showToast(msg("toastBackupDeleted"));
    });

    list.appendChild(item);
  });
}

// ─── Backup detay görünümü ────────────────────────────────────────────────────

function openBackupDetail(index) {
  currentBackupIndex = index;
  const backup = backupsCache[index];
  if (!backup) return;

  document.getElementById("detail-timestamp").textContent = formatTimestamp(backup.timestamp);
  document.getElementById("detail-count").textContent     = msg("tabsCount", backup.tabCount);

  renderDetailTabs(backup.tabs);
  showView("view-detail");
}

const OPEN_ICON_SVG = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
  <polyline points="15 3 21 3 21 9"/>
  <line x1="10" y1="14" x2="21" y2="3"/>
</svg>`;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// Favicon'u tarayicinin kendi onbelleginden iste: popup acilinca N ucuncu taraf siteye
// istek gitmez ve sayfa kontrolundeki favIconUrl hicbir attribute'a yazilmaz.
function buildFavicon(tab) {
  const fallback = el("div", "tab-favicon-fallback");
  if (!/^https?:\/\//i.test(tab.url || "")) return [fallback];

  const src = new URL(browser.runtime.getURL("/_favicon/"));
  src.searchParams.set("pageUrl", tab.url);
  src.searchParams.set("size", "16");

  const img = el("img", "tab-favicon");
  img.alt = "";
  img.src = src.toString();
  fallback.style.display = "none";
  img.addEventListener("error", () => {
    img.style.display = "none";
    fallback.style.display = "block";
  });
  return [img, fallback];
}

function renderDetailTabs(tabs) {
  const list = document.getElementById("detail-tab-list");
  list.replaceChildren();

  tabs.forEach((tab) => {
    const item = el("div", "detail-tab-item");

    const info = el("div", "tab-info");
    info.append(...buildFavicon(tab));
    const texts = el("div", "tab-texts");
    texts.append(
      el("span", "tab-item-title", tab.title || tab.url),
      el("span", "tab-item-url", trimUrl(tab.url)),
    );
    info.append(texts);

    const badges = el("div", "tab-badges");
    if (tab.suspended) badges.append(el("span", "badge-suspended", msg("badgeSuspended")));
    const openBtn = el("button", "btn-open-tab");
    openBtn.title = msg("titleOpen");
    openBtn.innerHTML = OPEN_ICON_SVG; // sabit SVG, degisken yok
    openBtn.addEventListener("click", async () => {
      await send({
        action: "restore-tab",
        url: tab.url,
        title: tab.title,
        favIconUrl: tab.favIconUrl,
        asSuspended: tab.suspended,
      });
      showToast(msg("toastTabOpened"));
    });
    badges.append(openBtn);

    item.append(info, badges);
    list.appendChild(item);
  });
}

// ─── Yardımcı fonksiyonlar ────────────────────────────────────────────────────

function escapeHtml(str) {
  // textContent->innerHTML tirnaklari kacirmaz; attribute baglaminda guvenli olmasi icin elle.
  return String(str || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function trimUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname + (u.pathname !== "/" ? u.pathname : "");
  } catch {
    return url;
  }
}

// ─── Export yardımcısı ────────────────────────────────────────────────────────

function downloadFile(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── Backup export (detay görünümü) ──────────────────────────────────────────

function exportAsTxt(backup) {
  const date  = formatTimestamp(backup.timestamp);
  const lines = [
    msg("expBackupTitle"),
    msg("expDate", date),
    msg("expTabCount", backup.tabCount),
    msg("expSuspendedCount", backup.tabs.filter(x => x.suspended).length),
    "",
    ...backup.tabs.map(x =>
      x.suspended
        ? `${msg("expMarkerSuspended")} ${x.url}  (${x.title || ""})`
        : x.url
    ),
  ];

  const slug = date.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 40);
  downloadFile(lines.join("\n"), `backup_${slug}.txt`, "text/plain;charset=utf-8");
}

function exportAsJson(backup) {
  const out = {
    exportedAt: new Date().toISOString(),
    backupDate: backup.timestamp,
    tabCount:   backup.tabCount,
    tabs: backup.tabs.map(x => ({
      url:       x.url,
      title:     x.title || "",
      suspended: x.suspended,
      pinned:    x.pinned,
    })),
  };
  const date = formatTimestamp(backup.timestamp).replace(/[^a-zA-Z0-9]/g, "_").slice(0, 40);
  downloadFile(JSON.stringify(out, null, 2), `backup_${date}.json`, "application/json");
}

// ─── Tüm sekmeleri dışa aktar (canlı snapshot) ───────────────────────────────

async function exportAllTabs(format) {
  const res = await send({ action: "get-all-tabs-for-export" });
  if (!res?.tabs) { showToast(msg("toastTabsFailed")); return; }
  const tabs = res.tabs;

  if (format === "txt") {
    const date  = formatTimestamp(new Date().toISOString());
    const lines = [
      msg("expAllTitle"),
      msg("expDate", date),
      msg("expTabCount", tabs.length),
      msg("expSuspendedCount", tabs.filter(x => x.suspended).length),
      "",
      ...tabs.map(x =>
        x.suspended
          ? `${msg("expMarkerSuspended")} ${x.url}  (${x.title || ""})`
          : x.url
      ),
    ];
    downloadFile(lines.join("\n"), `tabs_${Date.now()}.txt`, "text/plain;charset=utf-8");
    showToast(msg("toastTxtDownloaded"));
  } else {
    const out = {
      exportedAt:     new Date().toISOString(),
      tabCount:       tabs.length,
      suspendedCount: tabs.filter(x => x.suspended).length,
      tabs: tabs.map(x => ({
        url:       x.url,
        title:     x.title || "",
        suspended: x.suspended,
        pinned:    x.pinned,
      })),
    };
    downloadFile(JSON.stringify(out, null, 2), `tabs_${Date.now()}.json`, "application/json");
    showToast(msg("toastJsonDownloaded"));
  }
}

// ─── Otomatik askıya alma ayarları ───────────────────────────────────────────

async function loadAutoSuspendSettings() {
  const res = await send({ action: "get-auto-suspend-settings" });
  if (!res) return;
  const { enabled, thresholdMinutes } = res.settings;

  const toggle       = document.getElementById("auto-suspend-toggle");
  const threshSelect = document.getElementById("auto-suspend-threshold");
  const threshRow    = document.getElementById("threshold-row");

  toggle.checked         = enabled;
  threshSelect.value     = String(thresholdMinutes);
  threshRow.style.display = enabled ? "" : "none";
}

async function saveAutoSuspendSettings() {
  const enabled          = document.getElementById("auto-suspend-toggle").checked;
  const thresholdMinutes = parseInt(document.getElementById("auto-suspend-threshold").value);
  document.getElementById("threshold-row").style.display = enabled ? "" : "none";
  await send({ action: "set-auto-suspend-settings", settings: { enabled, thresholdMinutes } });
}

// ─── Backup sıklığı ayarı ─────────────────────────────────────────────────────

function setBackupIntervalText(minutes) {
  document.getElementById("backup-empty-sub").textContent = msg("backupIntervalInfo", minutes);
}

async function loadBackupSettings() {
  const res = await send({ action: "get-backup-settings" });
  if (!res) return;
  document.getElementById("backup-interval").value = res.backupIntervalMinutes;
  setBackupIntervalText(res.backupIntervalMinutes);
}

async function saveBackupSettings() {
  const input   = document.getElementById("backup-interval");
  const minutes = parseInt(input.value);
  const res = await send({ action: "set-backup-settings", backupIntervalMinutes: minutes });
  if (!res) return;
  input.value = res.backupIntervalMinutes;
  setBackupIntervalText(res.backupIntervalMinutes);
}

// ─── Event listeners ──────────────────────────────────────────────────────────

// Tüm askıdaki sekmeleri geri yükle
document.getElementById("btn-unsuspend-all").addEventListener("click", async () => {
  const res = await send({ action: "unsuspend-all" });
  if (res?.count === 0) {
    showToast(msg("toastNoSuspended"));
  } else {
    showToast(msg("toastTabsRestored", res?.count || 0));
    await loadStats();
  }
});

// Aktif sekmeyi askıya al
document.getElementById("btn-suspend-active").addEventListener("click", async () => {
  const res = await send({ action: "suspend-active" });
  if (res?.error) {
    showToast(res.error);
  } else {
    showToast(msg("toastTabSuspended"));
    await loadStats();
  }
});

// Şimdi yedekle
document.getElementById("btn-backup-now").addEventListener("click", async () => {
  await send({ action: "create-backup-now" });
  await loadBackups();
  showToast(msg("toastBackupTaken"));
});

// Detay'dan geri dön
document.getElementById("btn-back").addEventListener("click", () => {
  showView("view-main");
  currentBackupIndex = null;
});

// Tümünü geri yükle
document.getElementById("btn-restore-all").addEventListener("click", async () => {
  if (currentBackupIndex === null) return;
  const backup = backupsCache[currentBackupIndex];
  if (!backup) return;

  const confirmed = confirm(msg("confirmRestoreAll", backup.tabCount));
  if (!confirmed) return;

  await send({ action: "restore-all-backup", tabs: backup.tabs });
  showToast(msg("toastAllTabsOpened"));
});

// Backup detay export
document.getElementById("btn-export-txt").addEventListener("click", () => {
  if (currentBackupIndex === null) return;
  const backup = backupsCache[currentBackupIndex];
  if (!backup) return;
  exportAsTxt(backup);
  showToast(msg("toastTxtDownloaded"));
});

document.getElementById("btn-export-json").addEventListener("click", () => {
  if (currentBackupIndex === null) return;
  const backup = backupsCache[currentBackupIndex];
  if (!backup) return;
  exportAsJson(backup);
  showToast(msg("toastJsonDownloaded"));
});

// Tüm sekmeleri dışa aktar
document.getElementById("btn-export-all-txt").addEventListener("click",  () => exportAllTabs("txt"));
document.getElementById("btn-export-all-json").addEventListener("click", () => exportAllTabs("json"));

// Settings toggle (collapsible)
document.getElementById("settings-toggle").addEventListener("click", () => {
  document.getElementById("settings-body").classList.toggle("hidden");
  document.getElementById("settings-chevron").classList.toggle("rotated");
});

// Auto-suspend ayarları
document.getElementById("auto-suspend-toggle").addEventListener("change",    saveAutoSuspendSettings);
document.getElementById("auto-suspend-threshold").addEventListener("change", saveAutoSuspendSettings);

// Backup sıklığı ayarı
document.getElementById("backup-interval").addEventListener("change", saveBackupSettings);

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  await Promise.all([loadStats(), loadBackups(), loadAutoSuspendSettings(), loadBackupSettings()]);
}

init();

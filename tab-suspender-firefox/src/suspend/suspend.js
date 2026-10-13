const msg = (key, ...subs) => browser.i18n.getMessage(key, subs.map(String));

let currentUUID = null;

function show(id) { document.getElementById(id).classList.remove("hidden"); }
function hide(id) { document.getElementById(id).classList.add("hidden"); }

function setState(state) {
  hide("state-loading");
  hide("state-suspended");
  hide("state-error");
  show(`state-${state}`);
}

// The ?url= parameter can be crafted by anyone, only http(s) is followed.
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
  // Prefer the grayscale icon, then the extension's own pause icon. Never fall back to the original favicon,
  // a suspended tab would look like an active one.
  const url = greyUrl || browser.runtime.getURL("../icons/48.png");
  document.querySelectorAll("link[rel~='icon']").forEach(el => el.remove());
  const link  = document.createElement("link");
  link.rel    = "icon";
  link.type   = "image/png";
  link.href   = url;
  document.head.appendChild(link);
}

let elapsedInterval = null;

function startElapsedTimer(suspendedAt) {
  const update = () => setText("time-elapsed", getElapsed(suspendedAt));
  update();
  elapsedInterval = setInterval(update, 10_000);
}

async function doUnsuspend() {
  if (elapsedInterval) clearInterval(elapsedInterval);

  try {
    const res = await browser.runtime.sendMessage({ action: "unsuspend" });
    // If the background answered, it owns the navigation; running the fallback too would race two navigations.
    if (res) return;
  } catch (_) {  }

  const params      = new URLSearchParams(window.location.search);
  const originalUrl = params.get("url");
  if (originalUrl && isHttpUrl(originalUrl)) {
    window.location.href = originalUrl;
  }
}

async function render() {
  const params = new URLSearchParams(window.location.search);
  // searchParams.get() already decodes; decoding again breaks titles that contain %.
  currentUUID  = params.get("id");

  const urlParam   = params.get("url");
  const titleParam = params.get("t");
  const tsParam    = params.get("ts");

  if (!urlParam) {
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

  document.title = baseEntry.title;
  setText("tab-title", baseEntry.title);

  if (currentUUID) {
    try {
      const { suspended = {} } = await browser.storage.local.get("suspended");
      const stored = suspended[currentUUID];
      if (stored) {
        baseEntry.favIconUrl     = stored.favIconUrl     || "";
        baseEntry.greyFavIconUrl = stored.greyFavIconUrl || "";
        if (stored.suspendedAt) baseEntry.suspendedAt = stored.suspendedAt;
      }
    } catch (_) {  }
  }

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

document.getElementById("btn-unsuspend").addEventListener("click", doUnsuspend);
document.getElementById("btn-newtab").addEventListener("click", () => {
  browser.tabs.create({ url: "about:newtab" });
});

// tabs.sendMessage only reaches content scripts and this is an extension page, so the background signals the icon through storage.onChanged.
browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.suspended || !currentUUID) return;
  const entry = changes.suspended.newValue?.[currentUUID];
  if (entry?.greyFavIconUrl) {
    setTabFavicon(entry.greyFavIconUrl);
  }
});

// Alt+Shift+S is not handled here on purpose: the global command already restores this tab, and handling it twice races and re-suspends the tab.
render();

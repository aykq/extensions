# Tab Suspender

Frees memory by replacing inactive tabs with a lightweight placeholder page and discarding the real page. Suspend a tab by hand, with a shortcut, or let the extension do it after a period of inactivity. Click the placeholder to bring the original page back.

Chromium version (Chrome, Brave, Edge, Manifest V3). A Firefox and Zen version lives in [tab-suspender-firefox](../tab-suspender-firefox).

[Türkçe](README.tr.md)

## How suspending works

1. The tab navigates to a page inside the extension. The address of that page carries the original URL, the title and the time, so the tab can always be restored from its own address even if the extension's storage is lost.
2. The extension draws a grayscale copy of the site's favicon with a small pause badge and uses it as the tab icon, so a suspended tab is easy to tell apart.
3. Once the tab is not the one you are looking at, the browser discards it. That is the step that actually releases the memory. The tab you are currently viewing is never discarded, it is discarded the moment you switch away. If you restore a tab, it is protected from discarding for 15 seconds while it loads.
4. The placeholder page shows the favicon, the title, the original URL as a link, when the tab was suspended, how long ago that was (refreshed every 10 seconds) and a Restore button.

Restoring navigates the same tab back to the original URL and deletes the stored record. If the record is missing, the address stored in the placeholder's own URL is used, so you do not end up on a blank page.

## What can and cannot be suspended

- Only `http` and `https` pages are suspended. `chrome://`, `brave://`, `file:`, extension pages, `data:` and similar are refused, and so is the Web Store.
- Private (incognito) tabs are never suspended, because the URL and title would be written to disk. They are also left out of backups and exports.
- Pinned tabs can be suspended by hand. Automatic suspension skips them.

## Ways to suspend and restore

**Shortcut: Alt+Shift+S.** Toggles the active tab. It can be changed on the browser's extension shortcuts page (`chrome://extensions/shortcuts`).

With several tabs selected (Ctrl or Shift click in the tab strip), the shortcut acts on all of them:

| Selection | Result |
|---|---|
| All are suspended | All are restored |
| None is suspended | All are suspended |
| Mixed | The open ones are suspended, suspended ones are left alone |

For a mixed selection the extension deliberately chooses to suspend, so that a habit of "suspend everything" works and nobody restores dozens of tabs at once by accident. Restoring a large selection loads every page at the same time, which costs memory and bandwidth.

**Toolbar popup.** Buttons for suspending the active tab and for restoring every suspended tab in all windows.

**Right-click menu.** Right-click on a page or on the extension's toolbar icon and open the Tab Suspender submenu: suspend or restore the tab, back up now, show backups. The first entry always reflects the active tab. Chromium does not let extensions add entries to the tab strip menu, which is why the toolbar icon is used.

## Automatic suspension

Turn it on in the popup under Settings and pick how long a tab has to be idle: 15 minutes, 30 minutes, 1 hour or 2 hours. The extension checks once a minute. A tab is skipped if it is:

- the active tab of any window (every window keeps its own active tab safe),
- pinned,
- playing audio,
- private,
- already suspended or discarded,
- not an `http` or `https` page.

The idle clock starts when you switch away from a tab, so a tab you used for hours is not suspended the moment you leave it.

## Backups

The extension keeps snapshots of everything you have open, so a crash or an accidental window close does not cost you your tabs.

- A snapshot is taken every 5 minutes by default. The interval can be set from 1 to 180 minutes. The newest 20 snapshots are kept.
- A snapshot lists each tab's URL, title, whether it was suspended, whether it was pinned and its window. Suspended tabs are recorded with their original address, not the placeholder.
- The popup lists snapshots with the time, the tab count and how many were suspended. Open one to see every tab. From there you can open a single tab, restore the whole snapshot (after a confirmation), export it, or delete it.
- Restoring a snapshot opens every tab as a new background tab. Tabs that were suspended come back suspended.
- "Back Up Now" in the popup and in the right-click menu takes a snapshot immediately.
- **Previous session leftovers.** If a suspended record exists but no open tab uses it any more (for example after a crash), the extension turns it into a snapshot marked as a leftover and removes the record. This runs a minute after browser start and with each scheduled backup. Records younger than 10 minutes are ignored, because a tab that is still navigating can look orphaned.

## Export

From the popup you can export all open tabs, or a single snapshot, as:

- **TXT:** a short header with the date, tab count and suspended count, then one URL per line. Suspended tabs get a `[SUSPENDED]` label in front and their title in parentheses after the URL.
- **JSON:** a list of tabs with `url`, `title`, `suspended` and `pinned`.

Suspended tabs are always exported with their real address.

## Other behavior worth knowing

- **Closing the active tab** activates the tab that takes its position, which is the one to its right, or the last tab if it was the rightmost. This replaces the browser's own choice of tab.
- **The popup stats** (total, active, suspended) are counted from the real open tabs in every window, not from stored records.
- **Language.** The interface follows the browser language. English and Turkish are included, English is the fallback.

## Install

### From source

```
git clone https://github.com/aykq/extensions
cd extensions/tab-suspender
npm run build
```

Open `chrome://extensions` (or `brave://extensions`), turn on Developer mode, choose **Load unpacked** and select `tab-suspender/dist/chrome`. After changing code, run the build again and press Reload on the extension card.

**Do not move the folder after loading it.** For an unpacked extension the browser derives the extension ID from the folder path. The placeholder tabs live at `chrome-extension://<id>/...`, so if the ID changes every suspended tab points at an address that no longer exists and cannot be restored. Restore all suspended tabs (the popup warns about this) before moving, reinstalling or removing the extension. Store installs have a stable ID.

## Permissions

| Permission | Why |
|---|---|
| `tabs` | Read each tab's URL, title, pinned, audible and private state, and to suspend, restore and activate tabs. |
| `storage` | Keeps suspended-tab records, backups and settings on this device. A short-lived in-memory area holds the idle timers. |
| `alarms` | Scheduled backups and the once-a-minute idle check. A service worker cannot rely on timers. |
| `contextMenus` | The right-click submenu. |
| `favicon` | Reads the browser's own favicon cache to draw the grayscale icon and the icons in the backup list. This avoids contacting the sites again. |

No content scripts, no host permissions. See [PRIVACY.md](PRIVACY.md).

## Known limits

- The grayscale tab icon depends on the browser's favicon cache. If the favicon is not cached, the extension falls back to its own pause icon.
- If the browser refuses to open the popup from the right-click menu ("Show backups"), the popup opens in a normal tab instead.
- Chromium may replace a tab with a new tab ID (prerender swap, discard). The extension re-keys its state when that happens, and scheduled cleanup removes anything left behind.
- The service worker is stopped by the browser when idle. All state that has to survive that lives in `storage.session` or `storage.local`, and `npm test` includes a restart test for it. A real worker restart is only reproducible in the browser, see below.

## Development

```
npm test
```

Runs two files with plain Node, no packages:

- `sw-restart.test.js`: the background script against fake browser APIs, including a service worker restart that keeps the same storage. This is the case that silently breaks automatic suspension if state lives in memory.
- `i18n.test.js`: every translation key used by the code exists in every locale, placeholders match, no personal paths ship.

Layout:

```
src/        extension source, loadable as is
scripts/    build.js copies src to dist/chrome
tests/      test files
```

To verify a real service worker restart by hand: open the extension's service worker from `chrome://extensions`, enable automatic suspension with 15 minutes, click Terminate in DevTools, switch tabs, wait for the idle time and check that the tab gets suspended and the popup still shows statistics.

## License

MIT, see [LICENSE](../LICENSE).

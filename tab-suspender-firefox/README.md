# Tab Suspender for Firefox and Zen

Frees memory by replacing inactive tabs with a lightweight placeholder page and discarding the real page. Suspend a tab by hand, with a shortcut, or let the extension do it after a period of inactivity. Click the placeholder to bring the original page back.

This is the Firefox build (Firefox 115 or newer, Zen). It is a separate code base from the Chromium version in [tab-suspender](../tab-suspender) because the two browsers differ in how background code, storage, favicons and menus work. The features are the same unless noted below.

**Status.** The code has automated tests against fake browser APIs. It has not been used day to day in a real Firefox or Zen yet, so treat it as a preview and read [Known limits](#known-limits).

[Türkçe](README.tr.md)

## How suspending works

1. The tab navigates to a page inside the extension. The address of that page carries the original URL, the title and the time, so the tab can always be restored from its own address even if the extension's storage is lost.
2. The extension tries to draw a grayscale copy of the site's favicon with a small pause badge and use it as the tab icon. The favicon is downloaded from the address the tab reports, and many sites refuse such a request from an extension. When that happens the tab keeps the extension's own pause icon.
3. Once the tab is not the one you are looking at, the extension discards it. That is the step that actually releases the memory. Firefox refuses to discard the tab you are looking at, so the extension retries as soon as you switch away. If you restore a tab, it is protected from discarding for 15 seconds while it loads.
4. The placeholder page shows the favicon, the title, the original URL as a link, when the tab was suspended, how long ago that was (refreshed every 10 seconds) and a Restore button.

Restoring navigates the same tab back to the original URL and deletes the stored record. If the record is missing, the address stored in the placeholder's own URL is used, so you do not end up on a blank page.

## What can and cannot be suspended

- Only `http` and `https` pages are suspended. `about:`, `moz-extension:`, `file:`, `data:`, `view-source:` and similar are refused.
- Private tabs are never suspended, because the URL and title would be written to disk. They are also left out of backups and exports.
- Pinned tabs can be suspended by hand. Automatic suspension skips them.

## Ways to suspend and restore

**Shortcut: Alt+Shift+S.** Toggles the active tab. It can be changed under Manage Extension Shortcuts in `about:addons`.

With several tabs selected (Ctrl or Shift click in the tab strip), the shortcut acts on all of them:

| Selection | Result |
|---|---|
| All are suspended | All are restored |
| None is suspended | All are suspended |
| Mixed | The open ones are suspended, suspended ones are left alone |

For a mixed selection the extension deliberately chooses to suspend, so that a habit of "suspend everything" works and nobody restores dozens of tabs at once by accident. Restoring a large selection loads every page at the same time, which costs memory and bandwidth.

**Toolbar popup.** Buttons for suspending the active tab and for restoring every suspended tab in all windows.

**Right-click menu.** Right-click on a page or on a tab in the tab strip and open the Tab Suspender submenu: suspend or restore the tab, back up now, show backups. The first entry is refreshed each time the menu opens, so it matches the tab you clicked.

## Automatic suspension

Turn it on in the popup under Settings and pick how long a tab has to be idle: 15 minutes, 30 minutes, 1 hour or 2 hours. The extension checks once a minute. A tab is skipped if it is:

- the active tab of any window,
- pinned,
- playing audio,
- private,
- already suspended or discarded,
- not an `http` or `https` page.

The idle clock starts when you switch away from a tab, so a tab you used for hours is not suspended the moment you leave it.

## Backups

The extension keeps snapshots of everything you have open, so a crash or an accidental window close does not cost you your tabs.

- A snapshot is taken every 5 minutes by default. The interval can be set from 1 to 180 minutes. The newest 20 snapshots are kept.
- A snapshot lists each tab's URL, title, favicon address, whether it was suspended, whether it was pinned and its window. Suspended tabs are recorded with their original address, not the placeholder.
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

- **Closing the active tab** activates the tab that takes its position, which is the one to its right, or the last tab if it was the rightmost.
- **The popup stats** (total, active, suspended) are counted from the real open tabs in every window.
- **Language.** The interface follows the browser language. English and Turkish are included, English is the fallback.

## Install

### From source

```
git clone https://github.com/aykq/extensions
cd extensions/tab-suspender-firefox
npm run build
```

Open `about:debugging`, choose This Firefox, then Load Temporary Add-on and select `tab-suspender-firefox/dist/firefox/manifest.json`. A temporary add-on is removed when the browser closes.

For a permanent install, zip the contents of `dist/firefox` (with `manifest.json` at the top of the archive) and either have it signed on addons.mozilla.org or use a browser build that accepts unsigned add-ons. The add-on ID is `tab-suspender@aykq.github.io`.

Before you uninstall or reinstall, restore all suspended tabs. The placeholder tabs live at `moz-extension://<id>/...`, and a reinstall gives the extension a new internal ID, so old placeholder tabs would point at an address that no longer exists.

## Permissions

| Permission | Why |
|---|---|
| `tabs` | Read each tab's URL, title, pinned, audible and private state, and to suspend, restore, discard and activate tabs. |
| `storage` | Keeps suspended-tab records, backups and settings on this device. |
| `alarms` | Scheduled backups and the once-a-minute idle check. |
| `menus` | The right-click submenu. |

No content scripts, no host permissions. The manifest also marks the placeholder page as web accessible, which lets Firefox reopen placeholder tabs when it restores a session. See [PRIVACY.md](PRIVACY.md).

## Known limits

- **State is kept in memory.** Tab idle times and tab positions live in the background script's memory. Firefox may unload an idle background script, which would reset them. If that happens, automatic suspension counts idle time from the moment the script restarts, and the "activate the next tab" behavior can pick the wrong tab. The Chromium version stores this in `storage.session` for exactly that reason. Porting it is the main open item for this build.
- **Grayscale icons are unreliable** because the favicon request is subject to the site's cross-origin rules. A plain pause icon is used when it fails.
- The popup stores the favicon address with each tab in a snapshot, and shows it in the list by loading that address.
- Not yet tested in a real browser, see the status note at the top.

## Development

```
npm test
```

Runs two files with plain Node, no packages:

- `blob-race.test.js`: the background script against fake browser APIs. It covers lost updates during bulk suspend, restoring when a record is missing, bulk restore from a multi-selection, discard rules, and automatic suspension rules.
- `i18n.test.js`: every translation key used by the code exists in every locale, placeholders match, no personal paths ship.

Layout:

```
src/        extension source
scripts/    build.js copies src to dist/firefox
tests/      test files
```

## License

MIT, see [LICENSE](../LICENSE).

# Mouse Gestures

Hold the right mouse button, drag in a direction, release. The browser goes back, forward, closes the tab, opens a new one or reloads. A faint blue line follows the cursor while you draw.

Works in Chrome, Brave, Edge and other Chromium browsers (Manifest V3). A Firefox build is produced from the same source, see [Firefox](#firefox).

[Türkçe](README.tr.md)

## Gestures

| Gesture | Action |
|---|---|
| Drag left | Go back in the page history |
| Drag right | Go forward in the page history |
| Drag down | Close the tab |
| Drag up | Open a new tab |
| Drag right, then back left | Reload the page |

Details that decide how a stroke is read:

- **Minimum length.** A stroke counts only if its end point is at least 60 px from its start point. The value is adjustable from 20 to 400 px in the options page.
- **Direction.** The stroke is judged by the straight line from start to end. The longer axis must be at least 1.5 times the shorter one, which allows roughly 34 degrees of slant. A stroke that ends close to a diagonal does nothing. This keeps a sloppy left swipe from closing the tab.
- **Reload.** You have to travel at least the minimum length to the right and then at least the minimum length back to the left, and the stroke has to stay mostly flat (its vertical range must be under 45% of the horizontal travel). Circles do not trigger it. The return can be as fast or slow as you like.
- **Closing a tab.** The tab to the right of the closed one becomes active. If you close the last tab in the window, the one to its left becomes active. Pinned tabs close too. Closing the only tab in a window closes the window.
- **New tab.** The tab opens directly to the right of the current one, in the same window.
- **Reload keeps the cache.** It behaves like pressing F5, not Ctrl+Shift+R.

## The right-click menu still works

A plain right click, without moving the mouse, opens the normal context menu. Once the cursor moves more than 2 px with the button held, the menu is suppressed for that stroke so it does not pop up under your gesture.

## Canceling a stroke

While the right button is still held:

- Press **Escape**, or
- Press the **left mouse button**. The click is swallowed so it cannot activate a link under the cursor.

In both cases nothing happens and the context menu stays closed when you release the right button. A stroke is also canceled automatically if the window loses focus, the tab is hidden, or the right button is released somewhere the page cannot see.

## Options

Open the extension's options page (`chrome://extensions`, then Details, then Extension options).

- **Minimum stroke length** in pixels, 20 to 400, default 60.
- **Sites where gestures are disabled**, one domain per line. A subdomain match is included, so `example.com` also covers `maps.example.com`. Pasting a full URL is fine, the host is extracted and `www.` is dropped. Use this for pages that already use right-drag, such as map viewers, drawing tools, games and remote desktop clients.

Settings are stored with `storage.sync`, so they follow your browser profile if sync is on.

## Install

### From source (Chromium browsers)

```
git clone https://github.com/aykq/extensions
cd extensions/mouse-gestures
npm run build
```

Open `chrome://extensions` (or `brave://extensions`), turn on Developer mode, choose **Load unpacked** and select `mouse-gestures/dist/chrome`. You can also load `mouse-gestures/src` directly, the two are identical for Chromium.

Do not move or delete the folder afterwards, the browser reads the extension from there. After pressing Reload on the extension card, press Reload on your open tabs too, see [Known limits](#known-limits).

Node.js is only needed for the build script, which copies files and writes the Firefox manifest. There are no runtime dependencies.

### Firefox

`npm run build` also writes `dist/firefox`. Load it through `about:debugging`, This Firefox, Load Temporary Add-on, and pick `dist/firefox/manifest.json`. A temporary add-on disappears when the browser closes. A permanent install needs a signed package from addons.mozilla.org. The Firefox build uses the add-on ID `mouse-gestures@aykq.github.io` and requires Firefox 115 or newer. Firefox treats site access as optional for Manifest V3 add-ons, so if gestures do nothing, open the add-on's permissions in `about:addons` and allow access to all sites.


## Permissions

| Permission | Why |
|---|---|
| `storage` | Saves the two options. |
| Content script on all sites | Gestures have to be read on every page. Chromium lists this as "read and change your data on all websites", which is the wording it uses for any extension that runs a script on every page. The script reads mouse events and draws the trail. It does not read page content. |

The extension makes no network requests and collects nothing. See [PRIVACY.md](PRIVACY.md).

## Known limits

- **Pages the browser does not allow extensions on:** `chrome://` and `brave://` pages, the new tab page, the Chrome Web Store, and the built-in PDF viewer. Gestures do nothing there. Local `file://` pages work only if you enable "Allow access to file URLs" for the extension.
- **Iframes.** Gestures start only on the top-level page. A stroke that begins on top of an embedded iframe is not seen.
- **After installing or updating**, tabs that were already open keep an old copy of the script (or none). Reload those tabs. An old copy stops on its own the first time it tries to talk to the replaced extension, and until then it only does back and forward.
- **Pixel distance is in CSS pixels**, so zooming the page in makes the physical distance you need to drag longer.
- **Full screen and top-layer elements** (some video players, `<dialog>`, popovers) can cover the trail line. The gesture itself still works.
- **Linux and macOS.** Chromium there may open the context menu on mouse down instead of mouse up, which can get in the way of a stroke. Developed and tested on Windows.
- **Closing a tab discards unsaved form data** in the same way the close button does. The page may still show a "leave site?" prompt, which the extension does not bypass.

## Development

```
npm test
```

Builds the extension and runs three suites with plain Node, no packages: static checks of the manifests, the gesture state machine against a fake DOM, and the background logic against a fake tabs API.

Layout:

```
src/         extension source (loadable as is in Chromium)
scripts/     build.js (writes dist/chrome and dist/firefox), make_icons.py
tests/       manifest, content script and background tests
```

To create the store archive, zip the contents of `dist/chrome` so that `manifest.json` sits at the top level of the archive.

`scripts/make_icons.py` redraws the PNG icons to match `src/icons/icon.svg` (needs Pillow). If you change the SVG, update the script too.

## License

MIT, see [LICENSE](../LICENSE).

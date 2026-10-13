// Builds dist/chrome (the src folder as is) and dist/firefox (manifest adapted for Gecko).
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');

const GECKO_ID = 'mouse-gestures@aykq.github.io';

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, entry.name), b = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(a, b);
    else if (entry.name !== 'icon.svg') fs.copyFileSync(a, b);
  }
}

fs.rmSync(DIST, { recursive: true, force: true });

const chromeDir = path.join(DIST, 'chrome');
copyDir(SRC, chromeDir);

const firefoxDir = path.join(DIST, 'firefox');
copyDir(SRC, firefoxDir);

const manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));
delete manifest.minimum_chrome_version;
manifest.background = { scripts: ['background.js'] };
// Firefox does not grant content script hosts at install time unless they are listed here too.
manifest.host_permissions = ['<all_urls>'];
manifest.browser_specific_settings = { gecko: { id: GECKO_ID, strict_min_version: '115.0' } };
fs.writeFileSync(path.join(firefoxDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

console.log('built dist/chrome and dist/firefox');

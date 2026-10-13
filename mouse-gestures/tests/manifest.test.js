// Static checks of the source manifest and of both built manifests (run `npm run build` first).
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (...p) => JSON.parse(fs.readFileSync(path.join(ROOT, ...p), 'utf8'));
const pkg = read('package.json');
const src = read('src', 'manifest.json');
const ff = read('dist', 'firefox', 'manifest.json');
const cr = read('dist', 'chrome', 'manifest.json');

const results = [];
const t = (name, fn) => { try { const r = fn(); results.push([r === true, name, r === true ? '' : String(r)]); }
                          catch (e) { results.push([false, name, 'THREW ' + e.message]); } };
const exists = (base, f) => fs.existsSync(path.join(ROOT, base, f));

t('manifest_version 3 everywhere', () => [src, ff, cr].every((m) => m.manifest_version === 3) || 'not 3');
t('manifest version matches package.json', () => src.version === pkg.version || `${src.version} vs ${pkg.version}`);
t('permissions are only storage (no tabs, no host permissions in chrome)', () =>
  (JSON.stringify(src.permissions) === '["storage"]' && !src.host_permissions) || JSON.stringify(src.permissions));
t('chrome build uses a service worker, no MV2 keys', () =>
  (cr.background.service_worker === 'background.js' && !cr.background.scripts && cr.background.persistent === undefined) || 'bad background');
t('firefox build uses background.scripts and a gecko id', () =>
  (JSON.stringify(ff.background) === '{"scripts":["background.js"]}' && /@/.test(ff.browser_specific_settings.gecko.id)) || 'bad firefox block');
t('firefox build lists host_permissions and drops minimum_chrome_version', () =>
  (JSON.stringify(ff.host_permissions) === '["<all_urls>"]' && ff.minimum_chrome_version === undefined) || 'bad firefox hosts');
t('chrome build has no gecko block', () => !cr.browser_specific_settings || 'gecko block leaked');
t('name and description use locale keys that exist in every locale', () => {
  const keys = [...src.name.matchAll(/__MSG_(\w+)__/g), ...src.description.matchAll(/__MSG_(\w+)__/g)].map((m) => m[1]);
  if (keys.length !== 2) return 'name or description not localized';
  for (const loc of fs.readdirSync(path.join(ROOT, 'src', '_locales'))) {
    const msgs = read('src', '_locales', loc, 'messages.json');
    for (const k of keys) if (!msgs[k]) return `${loc} lacks ${k}`;
  }
  return exists('src/_locales', src.default_locale) || 'default locale folder missing';
});
t('all locales define the same keys', () => {
  const sets = fs.readdirSync(path.join(ROOT, 'src', '_locales')).map((l) => Object.keys(read('src', '_locales', l, 'messages.json')).sort().join());
  return new Set(sets).size === 1 || 'locale key mismatch';
});
t('description fits the 132 character store limit in every locale', () => {
  for (const loc of fs.readdirSync(path.join(ROOT, 'src', '_locales'))) {
    const d = read('src', '_locales', loc, 'messages.json').extDescription.message;
    if (d.length > 132) return `${loc}: ${d.length}`;
  }
  return true;
});
t('icons are PNG files with the right dimensions', () => {
  for (const [size, file] of Object.entries(src.icons)) {
    if (!file.endsWith('.png')) return `${file} is not PNG`;
    const p = path.join(ROOT, 'src', file);
    if (!fs.existsSync(p)) return `${file} missing`;
    const buf = fs.readFileSync(p);
    if (buf.slice(0, 8).toString('hex') !== '89504e470d0a1a0a') return `${file} is not a valid PNG`;
    if (buf.readUInt32BE(16) !== +size || buf.readUInt32BE(20) !== +size) return `${file} wrong size`;
  }
  return true;
});
t('every referenced file exists in both builds', () => {
  for (const [base, m] of [['dist/chrome', cr], ['dist/firefox', ff]]) {
    const files = [...m.content_scripts.flatMap((c) => c.js), m.options_ui.page, ...Object.values(m.icons),
      m.background.service_worker, ...(m.background.scripts || [])].filter(Boolean);
    for (const f of files) if (!exists(base, f)) return `${base}/${f} missing`;
  }
  return true;
});
t('options page has no inline script (MV3 CSP)', () => !/<script(?![^>]*src=)[^>]*>/i.test(fs.readFileSync(path.join(ROOT, 'src', 'options.html'), 'utf8')) || 'inline script found');
t('source files contain no personal paths', () => {
  for (const f of ['content.js', 'background.js', 'options.js', 'options.html', 'manifest.json']) {
    const s = fs.readFileSync(path.join(ROOT, 'src', f), 'utf8');
    if (/C:\\Users|AykQ\\|local\.dev/.test(s)) return `${f} leaks a local path or id`;
  }
  return true;
});

let fail = 0;
for (const [ok, name, msg] of results) { if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${msg ? '  -- ' + msg : ''}`); }
console.log(`\n${results.length - fail}/${results.length} passed`);
process.exit(fail ? 1 : 0);

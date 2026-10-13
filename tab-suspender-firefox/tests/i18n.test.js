// Checks that every translation key used by the code exists in every locale, that the locales
// agree with each other, and that the manifest is consistent. Plain Node, no packages.
const fs = require('fs'), path = require('path');
const SRC = path.join(__dirname, '..', 'src');
const read = (...p) => fs.readFileSync(path.join(SRC, ...p), 'utf8');
const manifest = JSON.parse(read('manifest.json'));
const locales = fs.readdirSync(path.join(SRC, '_locales'));
const messages = Object.fromEntries(locales.map((l) => [l, JSON.parse(read('_locales', l, 'messages.json'))]));

const results = [];
const t = (name, fn) => { try { const r = fn(); results.push([r === true, name, r === true ? '' : String(r)]); }
                          catch (e) { results.push([false, name, 'THREW ' + e.message]); } };

const files = ['background.js', 'popup/popup.js', 'popup/popup.html', 'suspend/suspend.js', 'suspend/suspend.html'];
const used = new Set();
for (const f of files) {
  const s = read(...f.split('/'));
  for (const m of s.matchAll(/\bmsg\("(\w+)"/g)) used.add(m[1]);
  for (const m of s.matchAll(/data-i18n(?:-title)?="(\w+)"/g)) used.add(m[1]);
}
for (const m of JSON.stringify(manifest).matchAll(/__MSG_(\w+)__/g)) used.add(m[1]);

t('every used key exists in every locale', () => {
  for (const l of locales) for (const k of used) if (!messages[l][k]) return `${l} lacks ${k}`;
  return true;
});
t('locales define exactly the same keys', () => {
  const sets = locales.map((l) => Object.keys(messages[l]).sort().join());
  return new Set(sets).size === 1 || 'key mismatch between locales';
});
t('no unused keys', () => {
  const unused = Object.keys(messages.en).filter((k) => !used.has(k));
  return unused.length === 0 || `unused: ${unused.join(', ')}`;
});
t('placeholders used in each message are defined', () => {
  for (const l of locales) for (const [k, v] of Object.entries(messages[l])) {
    const names = [...v.message.matchAll(/\$(\w+)\$/g)].map((m) => m[1].toLowerCase());
    for (const n of names) if (!v.placeholders || !v.placeholders[n]) return `${l}.${k} lacks placeholder ${n}`;
  }
  return true;
});
t('both locales use the same number of placeholders per key', () => {
  for (const k of Object.keys(messages.en)) {
    const count = (l) => Object.keys(messages[l][k].placeholders || {}).length;
    if (new Set(locales.map(count)).size !== 1) return `${k} placeholder count differs`;
  }
  return true;
});
t('description fits the 132 character store limit in every locale', () => {
  for (const l of locales) if (messages[l].extDescription.message.length > 132) return l;
  return true;
});
t('manifest is MV3 with a default locale that exists', () =>
  (manifest.manifest_version === 3 && locales.includes(manifest.default_locale)) || 'bad manifest');
t('every file the manifest and pages reference exists', () => {
  const refs = [manifest.action.default_popup, ...Object.values(manifest.icons), manifest.background.service_worker,
    ...(manifest.background.scripts || [])].filter(Boolean);
  for (const f of refs) if (!fs.existsSync(path.join(SRC, f))) return `${f} missing`;
  for (const [page, scripts] of [['popup/popup.html', ['../i18n.js', 'popup.js']], ['suspend/suspend.html', ['../i18n.js', 'suspend.js']]]) {
    const html = read(...page.split('/'));
    for (const s of scripts) if (!html.includes(`src="${s}"`)) return `${page} does not load ${s}`;
  }
  return true;
});
t('no personal paths or local ids in shipped files', () => {
  for (const f of [...files, 'manifest.json', 'i18n.js']) {
    if (/C:\\Users|AppData|@local\b|local\.dev/.test(read(...f.split('/')))) return `${f} leaks a local path or id`;
  }
  return true;
});
t('shipped code and pages contain no leftover Turkish UI text', () => {
  const re = /(?:"[^"\n]*|'[^'\n]*|>[^<\n]*)[çğıöşüÇĞİÖŞÜ][^"'<\n]*(?:"|'|<)/;
  for (const f of files) {
    const bad = read(...f.split('/')).split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*|<!--)/.test(l)).filter((l) => re.test(l) && !/\/\/.*[çğıöşüÇĞİÖŞÜ]/.test(l.replace(/(["'`]).*?\1/g, '')));
    if (bad.length) return `${f}: ${bad[0].trim().slice(0, 80)}`;
  }
  return true;
});

let fail = 0;
for (const [ok, name, msg] of results) { if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${msg ? '  -- ' + msg : ''}`); }
console.log(`\n${results.length - fail}/${results.length} passed`);
process.exit(fail ? 1 : 0);

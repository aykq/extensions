// Copies src into dist/firefox, the folder to load in the browser or to zip for a store.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'dist', 'firefox');

fs.rmSync(path.join(ROOT, 'dist'), { recursive: true, force: true });
fs.cpSync(path.join(ROOT, 'src'), OUT, { recursive: true });
console.log('built dist/firefox');

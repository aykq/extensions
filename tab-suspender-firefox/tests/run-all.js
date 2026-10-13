// Runs every test file:  node tests/run-all.js
const { execFileSync } = require('child_process'), path = require('path'), fs = require('fs');
let fail = 0;
const files = fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.js')).sort();
for (const f of files) {
  console.log(`\n===== ${f} =====`);
  try { console.log(execFileSync(process.execPath, [path.join(__dirname, f)], { encoding: 'utf8' })); }
  catch (e) { fail++; console.log(e.stdout || '', e.stderr || ''); }
}
console.log(fail ? `\n${fail} file(s) FAILED` : '\nALL TESTS PASSED');
process.exit(fail ? 1 : 0);

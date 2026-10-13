// Builds, then runs every test file:  node tests/run-all.js
const { execFileSync } = require('child_process'), path = require('path');
let fail = 0;
execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'build.js')], { stdio: 'inherit' });
for (const f of ['manifest.test.js', 'content.test.js', 'background.test.js']) {
  console.log(`\n===== ${f} =====`);
  try { console.log(execFileSync(process.execPath, [path.join(__dirname, f)], { encoding: 'utf8' })); }
  catch (e) { fail++; console.log(e.stdout || '', e.stderr || ''); }
}
console.log(fail ? `\n${fail} file(s) FAILED` : '\nALL TESTS PASSED');
process.exit(fail ? 1 : 0);

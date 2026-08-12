// Keep the test count in the README honest.
//
// The README quotes the size of the suite in three places, and it went stale
// almost immediately: it claimed 133 tests while the suite was at 201, because
// three numbers in a long document are three chances to forget one. This runs
// the suite, reads the real number, and writes it back.
//
//   node scripts/sync-test-count.mjs           fix the README
//   node scripts/sync-test-count.mjs --check    fail if it is stale (CI)
//
// The three sites are matched by explicit patterns rather than a blanket
// replace of "<n> tests", because the README says things like "199 tests" in
// prose about earlier revisions and those must not be rewritten. If a pattern
// stops matching - someone rephrased that line - the script fails loudly
// instead of quietly updating two places out of three.

import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const README = fileURLToPath(new URL('../README.md', import.meta.url));
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const VITEST = fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url));
const check = process.argv.includes('--check');

/** Run the suite and ask it how many tests there were. */
function countTests() {
  const out = join(tmpdir(), `vitest-count-${process.pid}.json`);
  try {
    // Vitest's own entry, run with this Node - not `npx`. Going through the
    // shim needs either `shell: true`, which Node deprecates for unescaped
    // argument concatenation, or spawning `npx.cmd` directly, which Node 25
    // refuses outright with EINVAL. Calling the .mjs sidesteps both and is one
    // process shorter.
    execFileSync(process.execPath, [VITEST, 'run', '--reporter=json', `--outputFile=${out}`], {
      cwd: ROOT, stdio: 'pipe',
    });
  } catch (e) {
    // A failing suite still writes the report; a missing one is a real error.
    if (!e.stdout && !e.stderr) throw e;
  }
  const report = JSON.parse(readFileSync(out, 'utf8'));
  rmSync(out, { force: true });
  if (report.numFailedTests > 0) {
    throw new Error(`${report.numFailedTests} tests are failing - fix those first`);
  }
  return report.numTotalTests;
}

// [description, pattern with the number as group 1, how to rebuild the line]
const SITES = [
  ['the quick-start block',
    /(npm test\s+# )(\d+)( tests:)/,
    (n, m) => `${m[1]}${n}${m[3]}`],
  ['the validation heading',
    /(`npm test` — )(\d+)( tests\.)/,
    (n, m) => `${m[1]}${n}${m[3]}`],
  ['the layout tree',
    /^(tests\/\s+)(\d+)( tests)$/m,
    (n, m) => `${m[1]}${n}${m[3]}`],
];

const n = countTests();
let src = readFileSync(README, 'utf8');
const stale = [];
let missing = 0;

for (const [what, re, rebuild] of SITES) {
  const m = src.match(re);
  if (!m) {
    console.error(`  ! could not find ${what} - has that line been rephrased?`);
    missing++;
    continue;
  }
  if (Number(m[2]) !== n) {
    stale.push(`${what}: says ${m[2]}`);
    src = src.replace(re, rebuild(n, m));
  }
}

if (missing) {
  console.error(`\n${missing} of ${SITES.length} sites not found. Not writing anything.`);
  process.exit(2);
}

if (!stale.length) {
  console.log(`README already says ${n} tests in all ${SITES.length} places.`);
  process.exit(0);
}

if (check) {
  console.error(`README is stale - the suite has ${n} tests but:`);
  for (const s of stale) console.error(`  - ${s}`);
  console.error('\nRun: npm run sync:tests');
  process.exit(1);
}

writeFileSync(README, src);
console.log(`Updated ${stale.length} place(s) to ${n} tests:`);
for (const s of stale) console.log(`  - ${s}`);
console.log('\nThe repo description on GitHub quotes the count too, and this '
  + 'does not touch it:\n  gh repo edit --description "... , ' + n + ' tests."');

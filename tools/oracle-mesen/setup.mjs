#!/usr/bin/env node
// One-time (idempotent) setup of Mesen2 for headless runs; see lib/mesen.mjs and docs/ORACLE.md.
//   node tools/oracle-mesen/setup.mjs [--check]
import { setupMesen, setupProblems, MESEN_DIR } from './lib/mesen.mjs';

if (process.argv.includes('--check')) {
  const p = setupProblems();
  console.log(p.length ? `not ready: ${p.join('; ')}` : `ready (${MESEN_DIR})`);
  process.exitCode = p.length ? 1 : 0;
} else {
  try {
    const done = setupMesen({ log: (m) => console.log(m) });
    if (!done.length) console.log('nothing to do');
    const p = setupProblems();
    console.log(p.length ? `still not ready: ${p.join('; ')}` : `ready (${MESEN_DIR})`);
    process.exitCode = p.length ? 1 : 0;
  } catch (e) {
    console.error(`error: ${e.message}`);
    process.exitCode = 3;
  }
}

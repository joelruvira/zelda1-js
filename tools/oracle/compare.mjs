#!/usr/bin/env node
// One-shot check: oracle trace + port trace (same inputs) + diff.
//
// Usage: node tools/oracle/compare.mjs <movie|idle:N> [--png sel] [--port module] [diff options]
// Writes out/oracle/<name>/, out/port/<name>/ and out/diff/<name>/ (diff images).
import { join } from 'node:path';
import { REPO_ROOT } from './lib/rom-file.mjs';
import { parseArgs, resolveMovie, runCli } from './lib/cli.mjs';
import { main as runOracle } from './run-oracle.mjs';
import { main as runPort } from './run-port.mjs';
import { main as diff } from './diff.mjs';

const DIFF_FLAGS = ['ignore-temps', 'strict', 'no-sram', 'no-fb', 'ignore-left8', 'verbose', 'json'];

export async function main(argv) {
  const args = parseArgs(argv, { flags: [...DIFF_FLAGS, 'quiet'] });
  const spec = args._[0];
  if (!spec) {
    console.error('usage: compare.mjs <movie|idle:N> [--png sel] [--port module] [diff options]');
    return 2;
  }
  const name = resolveMovie(spec).name;
  const dirs = ['oracle', 'port', 'diff'].map((d) => join(REPO_ROOT, 'out', d, name));
  const common = [...(args.rom ? ['--rom', args.rom] : [])];
  let code = await runOracle([spec, '--out', dirs[0], '--png', args.png ?? 'last', '--quiet', ...common]);
  if (code) return code;
  code = await runPort([
    '--inputs-from', join(dirs[0], 'trace.ztrace'), '--out', dirs[1], ...common,
    ...(args.port ? ['--port', args.port] : []),
  ]);
  if (code) return code;
  const diffArgs = [join(dirs[0], 'trace.ztrace'), join(dirs[1], 'trace.ztrace'), '--png-dir', dirs[2]];
  for (const f of DIFF_FLAGS) if (args[f]) diffArgs.push(`--${f}`);
  for (const r of [].concat(args.ignore ?? [])) diffArgs.push('--ignore', r);
  return diff(diffArgs);
}

if (import.meta.main) runCli(main);

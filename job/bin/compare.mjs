#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runCompare } from '../src/service/run-compare.mjs';

const outFlag = process.argv.indexOf('--out');
const outDir = outFlag === -1 ? null : process.argv[outFlag + 1];
if (!outDir) {
  process.stderr.write('usage: node bin/compare.mjs --out <caller-owned-dir>\n');
  process.exit(2);
}
const report = await runCompare();
mkdirSync(outDir, { recursive: true });
const target = resolve(outDir, 'comparison.json');
writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ ok: report.ok, schema: report.schema, wrote: target, failures: report.failures }, null, 2)}\n`);
process.exit(report.ok ? 0 : 1);

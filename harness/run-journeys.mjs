#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loopbackGhostUrl, runInstalledJourneys } from './installed.mjs';
import { runStubJourneys } from './journeys.mjs';

const planeFlag = process.argv.indexOf('--plane');
const plane = planeFlag === -1 ? 'stub' : process.argv[planeFlag + 1];
const outFlag = process.argv.indexOf('--out');
const outDir = outFlag === -1 ? null : process.argv[outFlag + 1];

if (plane === 'installed') {
  const admitted = process.env.GHOST_CONTINUITY_STAGE === 'installed' && process.env.GHOST_CONTINUITY_ADMIT === '1';
  const ready = admitted
    && process.env.GHOST_BASE_URL
    && process.env.GHOST_STAFF_EMAIL
    && process.env.GHOST_STAFF_PASSWORD
    && process.env.GHOST_WEBHOOK_SECRET;
  if (!ready || !loopbackGhostUrl(process.env.GHOST_BASE_URL)) {
    const refusal = {
      schema: 'ghost-continuity.installed-refusal.v1',
      ok: false,
      plane: 'installed',
      installed_execution: false,
      reason: ready
        ? 'installed runner refuses a non-loopback Ghost URL. This process does not start Ghost.'
        : 'installed journey needs GHOST_CONTINUITY_STAGE=installed, GHOST_CONTINUITY_ADMIT=1, GHOST_BASE_URL, GHOST_STAFF_EMAIL, GHOST_STAFF_PASSWORD, and GHOST_WEBHOOK_SECRET. This process does not start Ghost.',
    };
    process.stdout.write(`${JSON.stringify(refusal, null, 2)}\n`);
    process.exit(3);
  }
  const report = await runInstalledJourneys({
    baseUrl: process.env.GHOST_BASE_URL,
    email: process.env.GHOST_STAFF_EMAIL,
    password: process.env.GHOST_STAFF_PASSWORD,
    webhookSecret: process.env.GHOST_WEBHOOK_SECRET,
  });
  if (outDir) {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(resolve(outDir, 'installed-journey.json'), `${JSON.stringify(report, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify({
    ok: report.ok,
    schema: report.schema,
    plane: report.plane,
    installed_execution: report.installed_execution,
    ghost_version: report.ghost_version,
    failures: report.failures,
  }, null, 2)}\n`);
  process.exit(report.ok ? 0 : 1);
}

if (plane !== 'stub') {
  process.stderr.write('usage: node run-journeys.mjs --plane stub|installed [--out dir]\n');
  process.exit(2);
}

const report = await runStubJourneys();
if (outDir) {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(resolve(outDir, 'http-journey.json'), `${JSON.stringify(report, null, 2)}\n`);
}
process.stdout.write(`${JSON.stringify({
  ok: report.ok,
  schema: report.schema,
  plane: report.plane,
  installed_execution: report.installed_execution,
  failures: report.failures,
}, null, 2)}\n`);
process.exit(report.ok ? 0 : 1);

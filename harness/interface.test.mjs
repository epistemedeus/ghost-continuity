import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createDestination } from '../job/src/destination.mjs';
import { runStubJourneys } from './journeys.mjs';
import { createStore } from './store.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const job = join(here, '..', 'job');
const install = join(here, '..', 'install', 'clean-install.sh');
const nativeInstall = join(here, '..', 'install', 'native-install.sh');

function isolatedEnv() {
  const env = { ...process.env };
  delete env.NODE_CHANNEL_FD;
  delete env.NODE_TEST_CONTEXT;
  delete env.FORCE_COLOR;
  delete env.GHOST_CONTINUITY_STAGE;
  delete env.GHOST_CONTINUITY_ADMIT;
  delete env.GHOST_BASE_URL;
  delete env.GHOST_STAFF_EMAIL;
  delete env.GHOST_STAFF_PASSWORD;
  delete env.GHOST_WEBHOOK_SECRET;
  return env;
}

test('restart store matches the preserved destination on commit and replay', () => {
  const record = {
    ghost_id: '64313ccc0000000000000001',
    updated_at: '2026-10-29T12:00:00.000Z',
    status: 'published',
    title: 'Store parity',
    slug: 'store-parity',
    html: '<p>Same commit.</p>',
    url: 'http://127.0.0.1/store-parity/',
    published_at: '2026-10-29T12:00:00.000Z',
    content_sha256: 'abc',
  };
  const effect = 'effect-1';
  for (const make of [createDestination, createStore]) {
    const destination = make();
    assert.equal(destination.put(record, effect).applied, true);
    assert.equal(destination.put(record, effect).duplicate, true);
    assert.equal(destination.stats().writeCount, 1);
    assert.equal(destination.stats().rows, 1);
  }
  const restarted = createStore();
  const original = createStore();
  original.put(record, effect);
  restarted.load(original.snapshot());
  assert.equal(restarted.put(record, effect).duplicate, true);
  assert.equal(restarted.stats().writeCount, 1);
  assert.deepEqual(restarted.list(), original.list());
});

test('protocol stub completes the catalog journeys over HTTP', { timeout: 30000 }, async () => {
  const report = await runStubJourneys();
  assert.equal(report.ok, true, report.failures.join('; '));
  assert.equal(report.plane, 'protocol-stub');
  assert.equal(report.installed_execution, false);
  assert.equal(report.ghost_process_started, false);
  assert.equal(report.duplicate_ids.length, 0);
  assert.ok(report.logs.webhook_inbound.length > 0);
  assert.ok(report.logs.api_inbound.length > 0);
  assert.ok(report.logs.webhook_outbound.some((entry) => entry.outcome === 'missed'));
  assert.ok(report.logs.webhook_outbound.some((entry) => entry.outcome === 'failed'));
  assert.equal(report.cases.withdrawal.clocks_equal, false);
  assert.equal(report.cases.duplicate.rows_for_id, 1);
  assert.equal(report.cases.restart.rows_for_id, 1);
});

test('preserved seven tests and thirteen demo cases still pass', { timeout: 60000 }, () => {
  const tests = spawnSync(process.execPath, ['--test', 'test/behavior.test.mjs', 'test/effect-id.test.mjs'], {
    cwd: job,
    encoding: 'utf8',
    env: isolatedEnv(),
  });
  assert.equal(tests.status, 0, tests.stderr || tests.stdout);
  assert.match(tests.stdout, /# tests 7/);
  assert.match(tests.stdout, /# fail 0/);
  const demo = spawnSync(process.execPath, ['bin/demo.mjs'], { cwd: job, encoding: 'utf8', env: isolatedEnv() });
  assert.equal(demo.status, 0, demo.stderr || demo.stdout);
  assert.match(demo.stdout, /acceptance pass \(13 cases, 8 deployment steps\)/);
  assert.match(demo.stdout, /native win: missed_webhook/);
  const accept = spawnSync(process.execPath, ['bin/accept.mjs'], { cwd: job, encoding: 'utf8', env: isolatedEnv() });
  assert.equal(accept.status, 0, accept.stderr || accept.stdout);
  const missing = spawnSync(process.execPath, ['bin/compare.mjs'], { cwd: job, encoding: 'utf8', env: isolatedEnv() });
  assert.equal(missing.status, 2);
});

test('installed plane and clean-install refuse without the later admission', () => {
  const env = isolatedEnv();
  const installed = spawnSync(process.execPath, ['run-journeys.mjs', '--plane', 'installed'], {
    cwd: here,
    encoding: 'utf8',
    env,
  });
  assert.equal(installed.status, 3, installed.stdout || installed.stderr);
  assert.match(installed.stdout, /installed_execution": false/);
  const script = spawnSync('bash', [install], { encoding: 'utf8', env });
  assert.equal(script.status, 3, script.stdout || script.stderr);
  assert.match(script.stdout, /sha256:3656324ad804308b9ef39571b15b41465cdee64f6a78d1807719b5ea379688fd/);
  assert.match(script.stdout, /ghost-continuity-sample/);
  assert.doesNotMatch(script.stdout, /docker run -d[\s\S]*Started/);
  const native = spawnSync('bash', [nativeInstall], { encoding: 'utf8', env });
  assert.equal(native.status, 3, native.stdout || native.stderr);
  assert.match(native.stdout, /ghost-cli local development/);
  assert.match(native.stdout, /sqlite3/);
  assert.match(native.stdout, /does not start Ghost/);
});

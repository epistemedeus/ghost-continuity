import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { ADMIN_KEY, CONTENT_KEY, HARBOR_ID, MEMBERS_ID, SLIP_ID, WEBHOOK_SECRET, harbor, membersOnly, slip } from '../fixtures/posts.mjs';
import { createDestination } from '../src/destination.mjs';
import { createJournal as directJournal, syncFromContentApi as directHttp, syncPublishedPosts as directSync } from '../src/direct/sync.mjs';
import { startGhostFixture, signedWebhook } from '../src/ghost-fixture.mjs';
import { signWebhook } from '../src/signature.mjs';
import { createJournal as packageJournal, handleWebhook, syncPublishedPosts as packageSync } from '../src/package/sync.mjs';
import { adminToken } from '../src/token.mjs';
import { runAcceptance } from '../src/service/run-acceptance.mjs';
import { runCompare } from '../src/service/run-compare.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

async function publish(event, current, destination, journal, previous = {}) {
  const signed = signedWebhook({
    event,
    current,
    previous,
    secret: WEBHOOK_SECRET,
    timestampMs: 1761746400000,
  });
  return handleWebhook({
    rawBody: signed.rawBody,
    signatureHeader: signed.signatureHeader,
    secret: WEBHOOK_SECRET,
    destination,
    journal,
  });
}

test('acceptance and comparison pass without proving a customer preference', async () => {
  const acceptance = await runAcceptance();
  const comparison = await runCompare();
  assert.equal(acceptance.ok, true, acceptance.failures.join('; '));
  assert.equal(acceptance.schema, 'ghost-continuity.acceptance.v1');
  assert.equal(acceptance.checklist.length, 8);
  assert.equal(comparison.ok, true, comparison.failures.join('; '));
  assert.equal(comparison.schema, 'ghost-continuity.comparison.v1');
  assert.equal(comparison.native_win.case_id, 'missed_webhook');
  assert.ok(comparison.not_proved.includes('customer_preference'));
  assert.ok(comparison.not_proved.includes('earned_revenue'));
  assert.equal(comparison.roles.publisher.id, 'publisher-synthetic-field-notes');
  assert.equal(comparison.roles.payer_agency.id, 'agency-evaluator');
  assert.equal(comparison.roles.beneficiary.id, 'beneficiary-northwind-catalog');
  const ids = acceptance.cases.map((item) => item.id);
  for (const id of ['first_delivery', 'no_change', 'corrected_source', 'repeated_event', 'lost_response', 'interrupted_before_commit', 'stale_event', 'conflict_event']) {
    assert.ok(ids.includes(id), id);
  }
});

test('direct poll and package webhook share first delivery, no-change, correction, replay, stale, and conflict', async () => {
  const directDestination = createDestination();
  const directLog = directJournal();
  const packageDestination = createDestination();
  const packageLog = packageJournal();

  const firstDirect = await directSync([harbor.v1], directDestination, directLog);
  const firstPackage = await publish('post.published', harbor.v1, packageDestination, packageLog);
  assert.equal(firstDirect[0].decision, 'applied');
  assert.equal(firstPackage.decision, 'applied');

  const againDirect = await directSync([harbor.v1], directDestination, directLog);
  const againPackage = await publish('post.published', harbor.v1, packageDestination, packageLog);
  assert.equal(againDirect[0].decision, 'unchanged');
  assert.equal(againPackage.decision, 'unchanged');
  assert.equal(directDestination.stats().writeCount, 1);
  assert.equal(packageDestination.stats().writeCount, 1);

  const correctedDirect = await directSync([harbor.v2], directDestination, directLog);
  const correctedPackage = await publish('post.published.edited', harbor.v2, packageDestination, packageLog, {
    html: harbor.v1.html,
    updated_at: harbor.v1.updated_at,
  });
  assert.equal(correctedDirect[0].decision, 'applied');
  assert.equal(correctedPackage.decision, 'applied');
  assert.equal(directDestination.get(HARBOR_ID).title, 'Harbor light, corrected');
  assert.equal(packageDestination.get(HARBOR_ID).title, 'Harbor light, corrected');
  assert.equal(directDestination.stats().rows, 1);
  assert.equal(packageDestination.stats().rows, 1);

  const replayDirect = await directSync([harbor.v2], directDestination, directLog);
  const replayPackage = await publish('post.published.edited', harbor.v2, packageDestination, packageLog);
  assert.equal(replayDirect[0].decision, 'unchanged');
  assert.equal(replayPackage.decision, 'unchanged');
  assert.equal(directDestination.stats().writeCount, 2);
  assert.equal(packageDestination.stats().writeCount, 2);

  const staleDirect = await directSync([harbor.v1], directDestination, directLog);
  const stalePackage = await publish('post.published', harbor.v1, packageDestination, packageLog);
  assert.equal(staleDirect.at(-1).decision, 'stale');
  assert.equal(stalePackage.decision, 'stale');
  assert.equal(directDestination.get(HARBOR_ID).updated_at, harbor.v2.updated_at);
  assert.equal(packageDestination.get(HARBOR_ID).html, harbor.v2.html);

  const conflictDirect = await directSync([harbor.conflict], directDestination, directLog);
  const conflictPackage = await publish('post.published.edited', harbor.conflict, packageDestination, packageLog);
  assert.equal(conflictDirect[0].decision, 'conflict');
  assert.equal(conflictPackage.decision, 'conflict');
  assert.equal(directDestination.stats().writeCount, 2);
  assert.equal(packageDestination.stats().writeCount, 2);
  assert.equal(directDestination.get(HARBOR_ID).html, harbor.v2.html);
  assert.equal(packageDestination.get(HARBOR_ID).html, harbor.v2.html);
});

test('lost response and interrupted commit recover without a second catalog row', async () => {
  for (const sync of [directSync, packageSync]) {
    const lost = createDestination();
    lost.armLostResponse();
    const lostLog = directJournal();
    const lostResult = await sync([harbor.v1], lost, lostLog);
    assert.equal(lostResult[0].decision, 'recovered');
    assert.equal(lost.stats().writeCount, 1);
    assert.equal(lost.stats().putCount, 1);
    assert.equal(lost.stats().rows, 1);

    const interrupted = createDestination({ idempotent: false });
    interrupted.armFailBeforeCommit();
    const interruptedResult = await sync([harbor.v1], interrupted, directJournal());
    assert.equal(interruptedResult[0].decision, 'applied');
    assert.equal(interrupted.stats().writeCount, 1);
    assert.equal(interrupted.stats().putCount, 2);
    assert.equal(interrupted.stats().rows, 1);
  }
});

test('a bad signature and an out-of-scope event do not write', async () => {
  const destination = createDestination();
  const journal = packageJournal();
  const signed = signedWebhook({
    event: 'post.published',
    current: harbor.v1,
    secret: WEBHOOK_SECRET,
    timestampMs: 1761746400000,
  });
  const rejected = await handleWebhook({
    rawBody: `${signed.rawBody.slice(0, -1)} `,
    signatureHeader: signed.signatureHeader,
    secret: WEBHOOK_SECRET,
    destination,
    journal,
  });
  assert.equal(rejected.status, 401);
  assert.equal(rejected.decision, 'rejected_signature');
  const member = await publish('member.added', {
    id: 'member-synthetic',
    updated_at: '2026-10-29T12:00:00.000Z',
  }, destination, journal);
  assert.equal(member.status, 200);
  assert.equal(member.decision, 'ignored_event');
  assert.notEqual(member.status, 410);
  const membersPost = await publish('post.published', membersOnly, destination, journal);
  assert.equal(membersPost.decision, 'ignored');
  const malformedBody = '{';
  const malformed = await handleWebhook({
    rawBody: malformedBody,
    signatureHeader: signWebhook(malformedBody, WEBHOOK_SECRET, 1761746400000),
    secret: WEBHOOK_SECRET,
    destination,
    journal,
  });
  assert.equal(malformed.status, 400);
  const unknown = await publish('post.unpublished', harbor.unpublished, destination, journal);
  assert.equal(unknown.decision, 'ignored');
  assert.equal(unknown.status, 200);
  assert.equal(destination.stats().writeCount, 0);
  assert.equal(destination.stats().rows, 0);
});

test('content API pagination hides members-only posts and the admin token is a separate contract', async () => {
  const now = 1761746400;
  const fixture = await startGhostFixture({
    posts: [harbor.v1, slip, membersOnly],
    contentKey: CONTENT_KEY,
    adminKey: ADMIN_KEY,
    nowSeconds: () => now,
  });
  try {
    const missingVersion = await fetch(`${fixture.baseUrl}/ghost/api/content/posts/?key=${CONTENT_KEY}`);
    assert.equal(missingVersion.status, 406);
    const destination = createDestination();
    await directHttp({
      baseUrl: fixture.baseUrl,
      contentKey: CONTENT_KEY,
      destination,
      journal: directJournal(),
      pageSize: 1,
    });
    assert.deepEqual(destination.list().map((row) => row.ghost_id), [HARBOR_ID, SLIP_ID]);
    assert.equal(destination.list().some((row) => row.ghost_id === MEMBERS_ID), false);
    const token = adminToken({ key: ADMIN_KEY, nowSeconds: now });
    const admin = await fetch(`${fixture.baseUrl}/ghost/api/admin/posts/?filter=status:published&limit=15`, {
      headers: { 'Accept-Version': 'v6.0', Authorization: `Ghost ${token}` },
    });
    assert.equal(admin.status, 200);
    assert.equal(admin.headers.get('content-version'), 'v6.73');
    const adminBody = await admin.json();
    assert.equal(adminBody.posts.length, 3);
    const denied = await fetch(`${fixture.baseUrl}/ghost/api/admin/posts/`, {
      headers: { 'Accept-Version': 'v6.0' },
    });
    assert.equal(denied.status, 401);
  } finally {
    await fixture.close();
  }
});

test('compare writes only into the caller directory', () => {
  const out = mkdtempSync(join(tmpdir(), 'gc-sample-compare-'));
  const result = spawnSync(process.execPath, ['bin/compare.mjs', '--out', out], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(readFileSync(join(out, 'comparison.json'), 'utf8'));
  assert.equal(report.schema, 'ghost-continuity.comparison.v1');
  assert.equal(report.ok, true);
  assert.equal(existsSync(join(root, 'comparison.json')), false);
  const missing = spawnSync(process.execPath, ['bin/compare.mjs'], { cwd: root, encoding: 'utf8' });
  assert.equal(missing.status, 2);
});

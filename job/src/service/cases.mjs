import { readFileSync } from 'node:fs';
import { createDestination } from '../destination.mjs';
import { createJournal as directJournal, syncFromContentApi as directHttp, syncPublishedPosts as directSync } from '../direct/sync.mjs';
import { startGhostFixture, signedWebhook } from '../ghost-fixture.mjs';
import { createJournal as packageJournal, handleWebhook, syncFromContentApi as packageHttp, syncPublishedPosts as packageSync } from '../package/sync.mjs';
import { ADMIN_KEY, CONTENT_KEY, HARBOR_ID, MEMBERS_ID, SLIP_ID, WEBHOOK_SECRET, harbor, membersOnly, slip } from '../../fixtures/posts.mjs';
import { CHECKLIST } from './checklist.mjs';

function publicRow(row) {
  const copy = { ...row };
  delete copy.effect_id;
  return copy;
}

function snapshot(destination) {
  return {
    stats: destination.stats(),
    rows: destination.list().map(publicRow),
  };
}

async function packageEvent(destination, journal, event, current, previous = {}) {
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

function arm(destination, journal, result) {
  return {
    decision: result.decision ?? result.at(-1)?.decision,
    status: result.status,
    snapshot: snapshot(destination),
    journal: journal.entries().map((entry) => entry.decision),
  };
}

export async function runSharedCases() {
  const cases = [];

  {
    const directDestination = createDestination();
    const directLog = directJournal();
    const packageDestination = createDestination();
    const packageLog = packageJournal();
    const directResult = await directSync([harbor.v1], directDestination, directLog);
    const packageResult = await packageEvent(packageDestination, packageLog, 'post.published', harbor.v1);
    cases.push({
      id: 'first_delivery',
      required: true,
      direct: arm(directDestination, directLog, directResult),
      package: arm(packageDestination, packageLog, packageResult),
    });
  }

  {
    const directDestination = createDestination();
    const directLog = directJournal();
    const packageDestination = createDestination();
    const packageLog = packageJournal();
    await directSync([harbor.v1], directDestination, directLog);
    const directResult = await directSync([harbor.v1], directDestination, directLog);
    await packageEvent(packageDestination, packageLog, 'post.published', harbor.v1);
    const packageResult = await packageEvent(packageDestination, packageLog, 'post.published', harbor.v1);
    cases.push({
      id: 'no_change',
      required: true,
      direct: arm(directDestination, directLog, directResult),
      package: arm(packageDestination, packageLog, packageResult),
    });
  }

  {
    const directDestination = createDestination();
    const directLog = directJournal();
    const packageDestination = createDestination();
    const packageLog = packageJournal();
    await directSync([harbor.v1], directDestination, directLog);
    const directResult = await directSync([harbor.v2], directDestination, directLog);
    await packageEvent(packageDestination, packageLog, 'post.published', harbor.v1);
    const packageResult = await packageEvent(packageDestination, packageLog, 'post.published.edited', harbor.v2, {
      title: harbor.v1.title,
      html: harbor.v1.html,
      updated_at: harbor.v1.updated_at,
    });
    cases.push({
      id: 'corrected_source',
      required: true,
      direct: arm(directDestination, directLog, directResult),
      package: arm(packageDestination, packageLog, packageResult),
    });
  }

  {
    const directDestination = createDestination();
    const directLog = directJournal();
    const packageDestination = createDestination();
    const packageLog = packageJournal();
    await directSync([harbor.v2], directDestination, directLog);
    const directResult = await directSync([harbor.v2], directDestination, directLog);
    await packageEvent(packageDestination, packageLog, 'post.published.edited', harbor.v2);
    const packageResult = await packageEvent(packageDestination, packageLog, 'post.published.edited', harbor.v2);
    cases.push({
      id: 'repeated_event',
      required: true,
      direct: arm(directDestination, directLog, directResult),
      package: arm(packageDestination, packageLog, packageResult),
    });
  }

  {
    const directDestination = createDestination();
    const directLog = directJournal();
    const packageDestination = createDestination();
    const packageLog = packageJournal();
    directDestination.armLostResponse();
    packageDestination.armLostResponse();
    const directResult = await directSync([harbor.v1], directDestination, directLog);
    const packageResult = await packageEvent(packageDestination, packageLog, 'post.published', harbor.v1);
    cases.push({
      id: 'lost_response',
      required: true,
      direct: arm(directDestination, directLog, directResult),
      package: arm(packageDestination, packageLog, packageResult),
    });
  }

  {
    const directDestination = createDestination({ idempotent: false });
    const directLog = directJournal();
    const packageDestination = createDestination({ idempotent: false });
    const packageLog = packageJournal();
    directDestination.armFailBeforeCommit();
    packageDestination.armFailBeforeCommit();
    const directResult = await directSync([harbor.v1], directDestination, directLog);
    const packageResult = await packageEvent(packageDestination, packageLog, 'post.published', harbor.v1);
    cases.push({
      id: 'interrupted_before_commit',
      required: true,
      direct: arm(directDestination, directLog, directResult),
      package: arm(packageDestination, packageLog, packageResult),
    });
  }

  {
    const directDestination = createDestination();
    const directLog = directJournal();
    const packageDestination = createDestination();
    const packageLog = packageJournal();
    await directSync([harbor.v2], directDestination, directLog);
    const directResult = await directSync([harbor.v1], directDestination, directLog);
    await packageEvent(packageDestination, packageLog, 'post.published.edited', harbor.v2);
    const packageResult = await packageEvent(packageDestination, packageLog, 'post.published', harbor.v1);
    cases.push({
      id: 'stale_event',
      required: true,
      direct: arm(directDestination, directLog, directResult),
      package: arm(packageDestination, packageLog, packageResult),
    });
  }

  {
    const directDestination = createDestination();
    const directLog = directJournal();
    const packageDestination = createDestination();
    const packageLog = packageJournal();
    await directSync([harbor.v2], directDestination, directLog);
    const directResult = await directSync([harbor.conflict], directDestination, directLog);
    await packageEvent(packageDestination, packageLog, 'post.published.edited', harbor.v2);
    const packageResult = await packageEvent(packageDestination, packageLog, 'post.published.edited', harbor.conflict);
    cases.push({
      id: 'conflict_event',
      required: true,
      direct: arm(directDestination, directLog, directResult),
      package: arm(packageDestination, packageLog, packageResult),
    });
  }

  {
    const directDestination = createDestination();
    const directLog = directJournal();
    const packageDestination = createDestination();
    const packageLog = packageJournal();
    await directSync([harbor.v2, slip], directDestination, directLog);
    const directGone = await directSync([slip], directDestination, directLog);
    const directRepeat = await directSync([slip], directDestination, directLog);
    await packageEvent(packageDestination, packageLog, 'post.published', harbor.v2);
    await packageEvent(packageDestination, packageLog, 'post.published', slip);
    const packageGone = await packageEvent(packageDestination, packageLog, 'post.unpublished', harbor.unpublished, {
      status: 'published',
      updated_at: harbor.v2.updated_at,
    });
    const packageRepeat = await packageEvent(packageDestination, packageLog, 'post.unpublished', harbor.unpublished);
    cases.push({
      id: 'unpublish',
      required: true,
      transport_clock: {
        direct_updated_at: '2026-10-29T13:00:00.000Z',
        package_updated_at: '2026-10-29T14:00:00.000Z',
        reason: 'The poll cannot see the unpublished resource, so rule 6 keeps the last public updated_at. The webhook carries a later post.current.updated_at, so rule 4 replaces the clock.',
      },
      direct: {
        decision: directGone.find((item) => item.ghost_id === HARBOR_ID)?.decision,
        repeat: directRepeat.find((item) => item.ghost_id === HARBOR_ID)?.decision ?? 'unchanged',
        snapshot: snapshot(directDestination),
      },
      package: {
        decision: packageGone.decision,
        repeat: packageRepeat.decision,
        snapshot: snapshot(packageDestination),
      },
    });
  }

  {
    const directDestination = createDestination();
    const directLog = directJournal();
    const packageDestination = createDestination();
    const packageLog = packageJournal();
    const directResult = await directSync([harbor.v1, membersOnly], directDestination, directLog);
    const packageResult = await packageEvent(packageDestination, packageLog, 'post.published', membersOnly);
    const memberEvent = await packageEvent(packageDestination, packageLog, 'member.added', {
      id: 'member-synthetic',
      updated_at: '2026-10-29T12:00:00.000Z',
    });
    cases.push({
      id: 'out_of_scope_events',
      required: true,
      direct: arm(directDestination, directLog, directResult.filter((item) => item.ghost_id === HARBOR_ID)),
      package: {
        members_post: packageResult.decision,
        member_event: memberEvent.decision,
        member_status: memberEvent.status,
        snapshot: snapshot(packageDestination),
      },
    });
  }

  {
    const directDestination = createDestination();
    const directLog = directJournal();
    await directSync([harbor.v2], directDestination, directLog);
    const directOnly = snapshot(directDestination);
    const idleDestination = createDestination();
    const idleLog = packageJournal();
    const idle = snapshot(idleDestination);
    const reconciledDestination = createDestination();
    const reconciledLog = packageJournal();
    await packageSync([harbor.v2], reconciledDestination, reconciledLog);
    cases.push({
      id: 'missed_webhook',
      required: true,
      native_sufficient: true,
      direct: { snapshot: directOnly, journal: directLog.entries().map((entry) => entry.decision) },
      package_webhook_only: { snapshot: idle, journal: idleLog.entries().map((entry) => entry.decision) },
      package_reconcile: {
        snapshot: snapshot(reconciledDestination),
        journal: reconciledLog.entries().map((entry) => entry.decision),
      },
    });
  }

  const fixture = await startGhostFixture({
    posts: [harbor.v1, slip, membersOnly],
    contentKey: CONTENT_KEY,
    adminKey: ADMIN_KEY,
  });
  try {
    const directDestination = createDestination();
    const directLog = directJournal();
    const packageDestination = createDestination();
    const packageLog = packageJournal();
    await directHttp({
      baseUrl: fixture.baseUrl,
      contentKey: CONTENT_KEY,
      destination: directDestination,
      journal: directLog,
      pageSize: 1,
    });
    await packageHttp({
      baseUrl: fixture.baseUrl,
      contentKey: CONTENT_KEY,
      destination: packageDestination,
      journal: packageLog,
      pageSize: 1,
    });
    const contentResponse = await fetch(new URL(`/ghost/api/content/posts/?key=${CONTENT_KEY}&limit=all`, fixture.baseUrl), {
      headers: { 'Accept-Version': 'v6.0' },
    });
    const contentBody = await contentResponse.json();
    cases.push({
      id: 'content_api_pagination',
      required: true,
      content_version: contentResponse.headers.get('content-version'),
      content_ids: contentBody.posts.map((post) => post.id),
      direct: { snapshot: snapshot(directDestination) },
      package: { snapshot: snapshot(packageDestination) },
    });
  } finally {
    await fixture.close();
  }

  const signed = signedWebhook({
    event: 'post.published',
    current: harbor.v1,
    secret: WEBHOOK_SECRET,
    timestampMs: 1761746400000,
  });
  const badDestination = createDestination();
  const badLog = packageJournal();
  const bad = await handleWebhook({
    rawBody: `${signed.rawBody.slice(0, -1)} `,
    signatureHeader: signed.signatureHeader,
    secret: WEBHOOK_SECRET,
    destination: badDestination,
    journal: badLog,
  });
  cases.push({
    id: 'rejected_signature',
    required: true,
    package: {
      decision: bad.decision,
      status: bad.status,
      snapshot: snapshot(badDestination),
    },
  });

  return {
    cases,
    ids: { harbor: HARBOR_ID, slip: SLIP_ID, members: MEMBERS_ID },
    checklist: CHECKLIST,
  };
}

export function measureSources() {
  const root = new URL('../', import.meta.url);
  const files = [
    'direct/sync.mjs',
    'package/sync.mjs',
    'signature.mjs',
    'token.mjs',
    'destination.mjs',
    'ghost-fixture.mjs',
  ];
  const measured = {};
  for (const file of files) {
    const bytes = readFileSync(new URL(file, root));
    measured[file] = { bytes: bytes.length, lines: bytes.toString('utf8').split('\n').length };
  }
  return measured;
}

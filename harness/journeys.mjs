import { createJournal, syncFromContentApi } from '../job/src/direct/sync.mjs';
import { createJournal as packageJournal } from '../job/src/package/sync.mjs';
import { signWebhook } from '../job/src/signature.mjs';
import { createPost, registerWebhook, updatePost } from './ghost-http.mjs';
import { ADMIN_KEY, CONTENT_KEY, WEBHOOK_SECRET } from './identities.mjs';
import { startReceiver } from './receiver.mjs';
import { createStore } from './store.mjs';
import { startWire } from './wire.mjs';

const CONTENT_KEYS = ['ghost_id', 'status', 'title', 'slug', 'html', 'url', 'published_at', 'content_sha256'];

function view(store) {
  return store.list().map((row) => {
    const copy = { ...row };
    delete copy.effect_id;
    return copy;
  });
}

function one(store, id) {
  return view(store).filter((row) => row.ghost_id === id);
}

function sameId(store, other, id) {
  return JSON.stringify(one(store, id)) === JSON.stringify(one(other, id));
}

function contentEqual(left, right) {
  return CONTENT_KEYS.every((key) => left?.[key] === right?.[key]);
}

async function freshPoll(baseUrl) {
  const destination = createStore();
  const journal = createJournal();
  await syncFromContentApi({
    baseUrl,
    contentKey: CONTENT_KEY,
    destination,
    journal,
    pageSize: 1,
  });
  return destination;
}

function decisionOf(delivery) {
  const body = delivery?.attempts?.at(-1)?.body;
  if (!body) {
    return null;
  }
  try {
    return JSON.parse(body).decision ?? null;
  } catch {
    return null;
  }
}

function expect(failures, condition, message) {
  if (!condition) {
    failures.push(message);
  }
}

export function assess(report) {
  const failures = [];
  const cases = report.cases;
  expect(failures, cases.publish.equal === true, 'publish webhook row differs from the content poll');
  expect(failures, cases.publish.decision === 'applied', 'publish webhook did not apply');
  expect(failures, cases.publish.rows === 1, 'publish did not keep one row');
  expect(failures, cases.publish.email === false, 'publish stored an email field');
  expect(failures, cases.correction.equal === true, 'correction webhook row differs from the content poll');
  expect(failures, cases.correction.title === 'Harbor light, corrected', 'correction did not replace the title');
  expect(failures, cases.correction.rows_for_id === 1, 'correction created a second row');
  expect(failures, cases.withdrawal.status === 'withdrawn', 'withdrawal did not mark the row withdrawn');
  expect(failures, cases.withdrawal.content_equal === true, 'withdrawal content differs from the poll');
  expect(failures, cases.withdrawal.clocks_equal === false, 'withdrawal clocks were forced equal');
  expect(failures, cases.withdrawal.repeat === 'unchanged', 'repeated withdrawal wrote again');
  expect(failures, cases.withdrawal.other_status === 'published', 'the other public post was withdrawn');
  expect(failures, cases.missed_webhook.before === 0, 'a missed webhook still wrote a row');
  expect(failures, cases.missed_webhook.after_equal === true, 'reconcile does not match the direct poll');
  expect(failures, cases.missed_webhook.outcome === 'missed', 'missed webhook was delivered');
  expect(failures, cases.duplicate.inbound === 2, 'duplicate delivery was not two HTTP posts');
  expect(failures, cases.duplicate.write_delta === 1, 'duplicate delivery wrote more than once');
  expect(failures, cases.duplicate.rows_for_id === 1, 'duplicate delivery created a second row');
  expect(failures, cases.reordered.second === 'stale', 'reordered older event was not stale');
  expect(failures, cases.reordered.equal === true, 'reordered webhook row differs from the poll');
  expect(failures, cases.reordered.rows_for_id === 1, 'reordered events created a second row');
  expect(failures, cases.lost_response.first_ok === false, 'lost response was observed as success');
  expect(failures, cases.lost_response.retry === 'unchanged', 'retry after a lost response wrote again');
  expect(failures, cases.lost_response.write_delta === 1, 'lost response committed more than once');
  expect(failures, cases.lost_response.rows_for_id === 1, 'lost response created a second row');
  expect(failures, cases.restart.retry === 'unchanged', 'restarted receiver wrote the replay');
  expect(failures, cases.restart.write_count_same === true, 'restart changed write_count');
  expect(failures, cases.restart.rows_for_id === 1, 'restart created a second row');
  expect(failures, cases.raw_body.failure_status === 401, 're-serialized body was accepted');
  expect(failures, cases.raw_body.failure_rows === 0, 'rejected signature wrote a row');
  expect(failures, cases.raw_body.recovery_status === 200, 'raw body was rejected');
  expect(failures, cases.raw_body.recovery_rows === 1, 'raw body recovery did not keep one row');
  expect(failures, cases.members.decision === 'ignored', 'members post was catalogued from the webhook');
  expect(failures, cases.members.in_content_api === false, 'members post was returned by the content API');
  expect(failures, cases.stale_write.status === 409, 'stale updated_at was written');
  expect(failures, cases.stale_write.title_unchanged === true, 'stale updated_at changed the title');
  expect(failures, report.duplicate_ids.length === 0, 'catalog has duplicate ghost ids');
  expect(failures, report.installed_execution === false, 'protocol stub was labeled as an installation');
  return { ok: failures.length === 0, failures };
}

export async function runStubJourneys() {
  const nowSeconds = () => Math.floor(Date.now() / 1000);
  const wire = await startWire({
    contentKey: CONTENT_KEY,
    adminKey: ADMIN_KEY,
    secret: WEBHOOK_SECRET,
    nowSeconds,
  });
  let store = createStore();
  let journal = packageJournal();
  let receiver = await startReceiver({ secret: WEBHOOK_SECRET, store, journal });
  const logs = { webhook_inbound: [], api_inbound: [], webhook_outbound: [] };
  try {
    for (const event of ['post.published', 'post.published.edited', 'post.unpublished']) {
      const registered = await registerWebhook({
        baseUrl: wire.baseUrl,
        adminKey: ADMIN_KEY,
        nowSeconds,
        event,
        targetUrl: `${receiver.baseUrl}/hooks`,
      });
      if (registered.status !== 201) {
        throw new Error(`webhook register ${event} status ${registered.status}`);
      }
    }

    const published = await createPost({
      baseUrl: wire.baseUrl,
      adminKey: ADMIN_KEY,
      nowSeconds,
      post: {
        title: 'Harbor light',
        slug: 'harbor-light',
        html: '<p>First synthetic public note.</p>',
        status: 'published',
        visibility: 'public',
      },
    });
    const harbor = published.body.posts[0];
    const publishPoll = await freshPoll(wire.baseUrl);
    const publishCase = {
      decision: receiver.httpLog.at(-1)?.decision ?? null,
      equal: sameId(store, publishPoll, harbor.id),
      rows: one(store, harbor.id).length,
      email: Object.prototype.hasOwnProperty.call(store.get(harbor.id) ?? {}, 'email'),
      api_status: published.status,
    };

    const corrected = await updatePost({
      baseUrl: wire.baseUrl,
      adminKey: ADMIN_KEY,
      nowSeconds,
      id: harbor.id,
      post: {
        updated_at: harbor.updated_at,
        title: 'Harbor light, corrected',
        html: '<p>Corrected synthetic public note.</p>',
      },
    });
    const harborCorrected = corrected.body.posts[0];
    const correctionPoll = await freshPoll(wire.baseUrl);
    const correctionCase = {
      equal: sameId(store, correctionPoll, harbor.id),
      title: store.get(harbor.id)?.title ?? null,
      rows_for_id: one(store, harbor.id).length,
      api_status: corrected.status,
    };

    const slipCreated = await createPost({
      baseUrl: wire.baseUrl,
      adminKey: ADMIN_KEY,
      nowSeconds,
      post: {
        title: 'Second slip',
        slug: 'second-slip',
        html: '<p>Second synthetic public note.</p>',
        status: 'published',
        visibility: 'public',
      },
    });
    const slip = slipCreated.body.posts[0];
    const lifecycle = await freshPoll(wire.baseUrl);
    const withdrawn = await updatePost({
      baseUrl: wire.baseUrl,
      adminKey: ADMIN_KEY,
      nowSeconds,
      id: harbor.id,
      post: { updated_at: harborCorrected.updated_at, status: 'draft' },
    });
    const unpublished = withdrawn.body.posts[0];
    const repeatDelivery = await wire.deliver('post.unpublished', unpublished, {});
    await syncFromContentApi({
      baseUrl: wire.baseUrl,
      contentKey: CONTENT_KEY,
      destination: lifecycle,
      journal: createJournal(),
      pageSize: 1,
    });
    const webhookHarbor = view(store).find((item) => item.ghost_id === harbor.id);
    const pollHarbor = view(lifecycle).find((item) => item.ghost_id === harbor.id);
    const withdrawalCase = {
      status: webhookHarbor?.status ?? null,
      content_equal: contentEqual(webhookHarbor, pollHarbor),
      clocks_equal: webhookHarbor?.updated_at === pollHarbor?.updated_at,
      webhook_updated_at: webhookHarbor?.updated_at ?? null,
      poll_updated_at: pollHarbor?.updated_at ?? null,
      repeat: decisionOf(repeatDelivery),
      other_status: store.get(slip.id)?.status ?? null,
      api_status: withdrawn.status,
    };

    const writesBeforeMiss = store.stats().writeCount;
    wire.hold(true);
    const buoy = await createPost({
      baseUrl: wire.baseUrl,
      adminKey: ADMIN_KEY,
      nowSeconds,
      post: {
        title: 'Buoy',
        slug: 'buoy',
        html: '<p>Missed until reconcile.</p>',
        status: 'published',
        visibility: 'public',
      },
    });
    const buoyId = buoy.body.posts[0].id;
    const missedOutcome = wire.outbound.at(-1)?.outcome ?? null;
    const beforeReconcile = one(store, buoyId).length;
    wire.hold(false);
    await syncFromContentApi({
      baseUrl: wire.baseUrl,
      contentKey: CONTENT_KEY,
      destination: store,
      journal,
      pageSize: 1,
    });
    const missedPoll = await freshPoll(wire.baseUrl);
    const missedCase = {
      before: beforeReconcile,
      after_equal: sameId(store, missedPoll, buoyId),
      outcome: missedOutcome,
      write_delta: store.stats().writeCount - writesBeforeMiss,
    };

    const writesBeforeDuplicate = store.stats().writeCount;
    const inboundBeforeDuplicate = receiver.httpLog.length;
    wire.duplicateNext();
    const dock = await createPost({
      baseUrl: wire.baseUrl,
      adminKey: ADMIN_KEY,
      nowSeconds,
      post: {
        title: 'Dock',
        slug: 'dock',
        html: '<p>Delivered twice.</p>',
        status: 'published',
        visibility: 'public',
      },
    });
    const dockId = dock.body.posts[0].id;
    const duplicateCase = {
      inbound: receiver.httpLog.slice(inboundBeforeDuplicate).filter((entry) => entry.ghost_id === dockId).length,
      write_delta: store.stats().writeCount - writesBeforeDuplicate,
      rows_for_id: one(store, dockId).length,
    };

    const keel = {
      id: '64313bbb0000000000000001',
      title: 'Keel, current',
      slug: 'keel',
      html: '<p>Current public note.</p>',
      status: 'published',
      visibility: 'public',
      updated_at: '2026-10-29T15:00:00.000Z',
      published_at: '2026-10-29T15:00:00.000Z',
      url: `${wire.baseUrl}/keel/`,
    };
    wire.insertSilent(keel);
    const firstReorder = await wire.deliver('post.published.edited', keel, {});
    const secondReorder = await wire.deliver('post.published', {
      ...keel,
      title: 'Keel, older',
      html: '<p>Older note.</p>',
      updated_at: '2026-10-29T11:00:00.000Z',
    }, {});
    const reorderPoll = await freshPoll(wire.baseUrl);
    const reorderCase = {
      first: decisionOf(firstReorder),
      second: decisionOf(secondReorder),
      equal: sameId(store, reorderPoll, keel.id),
      rows_for_id: one(store, keel.id).length,
    };

    const writesBeforeLost = store.stats().writeCount;
    receiver.armDropNextResponse();
    const reef = await createPost({
      baseUrl: wire.baseUrl,
      adminKey: ADMIN_KEY,
      nowSeconds,
      post: {
        title: 'Reef',
        slug: 'reef',
        html: '<p>Lost response.</p>',
        status: 'published',
        visibility: 'public',
      },
    });
    const reefPost = reef.body.posts[0];
    const lostAttempt = wire.outbound.at(-1);
    const retry = await wire.deliver('post.published', reefPost, {});
    const lostCase = {
      first_ok: lostAttempt?.attempts?.[0]?.ok === true,
      retry: decisionOf(retry),
      write_delta: store.stats().writeCount - writesBeforeLost,
      rows_for_id: one(store, reefPost.id).length,
      cause: lostAttempt?.attempts?.[0]?.cause ?? lostAttempt?.attempts?.[0]?.error ?? null,
    };

    const restartBefore = store.stats().writeCount;
    const saved = store.snapshot();
    const oldLog = receiver.httpLog;
    await receiver.close();
    store = createStore();
    journal = packageJournal();
    receiver = await startReceiver({ secret: WEBHOOK_SECRET, store, journal });
    receiver.store.load(saved);
    wire.retarget(receiver.baseUrl);
    const restartRetry = await wire.deliver('post.published', reefPost, {});
    const restartCase = {
      retry: decisionOf(restartRetry),
      write_count_same: receiver.store.stats().writeCount === restartBefore,
      rows_for_id: one(receiver.store, reefPost.id).length,
    };

    const rawCurrent = {
      id: '64313aaaaaaaaaaaaaaaaaaa',
      title: 'Raw body',
      slug: 'raw-body',
      html: '<p>Signed bytes.</p>',
      status: 'published',
      visibility: 'public',
      updated_at: '2026-10-29T16:00:00.000Z',
      published_at: '2026-10-29T16:00:00.000Z',
      url: `${wire.baseUrl}/raw-body/`,
    };
    const rawBody = JSON.stringify({ event: 'post.published', post: { current: rawCurrent, previous: {} } });
    const signature = signWebhook(rawBody, WEBHOOK_SECRET, 1761746400000);
    const rowsBeforeRaw = receiver.store.stats().rows;
    const badResponse = await fetch(`${receiver.baseUrl}/hooks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Version': 'v6.73',
        'X-Ghost-Signature': signature,
      },
      body: `${rawBody.slice(0, -1)} `,
    });
    const rowsAfterBad = receiver.store.stats().rows;
    const goodResponse = await fetch(`${receiver.baseUrl}/hooks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Version': 'v6.73',
        'X-Ghost-Signature': signature,
      },
      body: rawBody,
    });
    const rawCase = {
      failure_status: badResponse.status,
      failure_rows: rowsAfterBad - rowsBeforeRaw,
      recovery_status: goodResponse.status,
      recovery_rows: one(receiver.store, rawCurrent.id).length,
    };

    const members = await createPost({
      baseUrl: wire.baseUrl,
      adminKey: ADMIN_KEY,
      nowSeconds,
      post: {
        title: 'Members desk',
        slug: 'members-desk',
        html: '<p>Not a public catalog row.</p>',
        status: 'published',
        visibility: 'members',
      },
    });
    const membersPoll = await freshPoll(wire.baseUrl);
    const membersCase = {
      decision: receiver.httpLog.at(-1)?.decision ?? null,
      in_content_api: membersPoll.list().some((item) => item.ghost_id === members.body.posts[0].id),
    };

    const staleWrite = await updatePost({
      baseUrl: wire.baseUrl,
      adminKey: ADMIN_KEY,
      nowSeconds,
      id: slip.id,
      post: { updated_at: '2026-10-29T01:00:00.000Z', title: 'Should not stick' },
    });
    const staleCase = {
      status: staleWrite.status,
      title_unchanged: receiver.store.get(slip.id)?.title === 'Second slip',
    };

    const catalog = view(receiver.store);
    const duplicateIds = catalog
      .map((item) => item.ghost_id)
      .filter((id, index, all) => all.indexOf(id) !== index);
    logs.webhook_inbound = oldLog.concat(receiver.httpLog);
    logs.api_inbound = wire.inbound.map((entry) => ({ ...entry }));
    logs.webhook_outbound = wire.outbound.map((entry) => ({
      event: entry.event,
      ghost_id: entry.ghost_id,
      outcome: entry.outcome,
      attempts: entry.attempts,
    }));
    const report = {
      schema: 'ghost-continuity.http-journey.v1',
      plane: 'protocol-stub',
      installed_execution: false,
      ghost_process_started: false,
      cases: {
        publish: publishCase,
        correction: correctionCase,
        withdrawal: withdrawalCase,
        missed_webhook: missedCase,
        duplicate: duplicateCase,
        reordered: reorderCase,
        lost_response: lostCase,
        restart: restartCase,
        raw_body: rawCase,
        members: membersCase,
        stale_write: staleCase,
      },
      duplicate_ids: duplicateIds,
      logs,
    };
    const verdict = assess(report);
    report.ok = verdict.ok;
    report.failures = verdict.failures;
    return report;
  } finally {
    await receiver.close();
    await wire.close();
  }
}

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createJournal, syncFromContentApi } from '../job/src/direct/sync.mjs';
import { createJournal as packageJournal } from '../job/src/package/sync.mjs';
import { signWebhook } from '../job/src/signature.mjs';
import { createPost, listPosts, updatePost } from './ghost-http.mjs';
import { startReceiver } from './receiver.mjs';
import { createStore } from './store.mjs';

const CONTENT_KEYS = ['ghost_id', 'status', 'title', 'slug', 'html', 'url', 'published_at', 'content_sha256'];
const USEFUL_KEYS = ['status', 'title', 'slug', 'html', 'published_at'];
const OWNED_INTEGRATION_PREFIX = 'GC sample ';
const WORKER_PATH = fileURLToPath(new URL('./receiver-worker.mjs', import.meta.url));

export function loopbackGhostUrl(baseUrl) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    return false;
  }
  return (url.protocol === 'http:' || url.protocol === 'https:')
    && (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1');
}

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

function usefulEqual(left, right) {
  return USEFUL_KEYS.every((key) => left?.[key] === right?.[key]);
}

function differingFields(left, right) {
  return CONTENT_KEYS.filter((key) => left?.[key] !== right?.[key]);
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function contentHash(row) {
  return createHash('sha256').update(stableStringify({
    title: row.title,
    slug: row.slug,
    html: row.html,
    url: row.url,
    published_at: row.published_at,
  })).digest('hex');
}

function adminKeyFrom(apiKey) {
  if (typeof apiKey.secret === 'string' && apiKey.secret.startsWith(`${apiKey.id}:`)) {
    return apiKey.secret;
  }
  return `${apiKey.id}:${apiKey.secret}`;
}

async function readJson(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return { unparsed: text.slice(0, 300) };
  }
}

async function staffCall(baseUrl, cookie, method, path, payload) {
  const response = await fetch(new URL(path, baseUrl), {
    method,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'Accept-Version': 'v6.0',
      Origin: baseUrl,
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  return { status: response.status, body: await readJson(response), response };
}

async function openSession(baseUrl, email, password) {
  const result = await staffCall(baseUrl, null, 'POST', '/ghost/api/admin/session/', {
    username: email,
    password,
  });
  if (result.status !== 201) {
    throw new Error(`staff session status ${result.status}`);
  }
  const cookies = typeof result.response.headers.getSetCookie === 'function'
    ? result.response.headers.getSetCookie()
    : [];
  return cookies.map((item) => item.split(';')[0]).join('; ');
}

async function freshPoll(baseUrl, contentKey) {
  const destination = createStore();
  await syncFromContentApi({
    baseUrl,
    contentKey,
    destination,
    journal: createJournal(),
    pageSize: 1,
  });
  return destination;
}

async function afterGhostSecond(previous) {
  const previousMs = Date.parse(previous);
  const target = (Number.isNaN(previousMs) ? Date.now() : previousMs) + 1100;
  while (Date.now() < target) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function expect(failures, condition, message) {
  if (!condition) {
    failures.push(message);
  }
}

export function assessInstalled(report) {
  const failures = [];
  const cases = report.cases;
  expect(failures, report.plane === 'installed', 'installed report plane');
  expect(failures, report.installed_execution === true, 'installed execution flag');
  expect(failures, report.ghost_version === '6.73.0', 'running Ghost version');
  expect(failures, report.spawned_by_runner === false, 'runner spawned Ghost');
  expect(failures, cases.publish.equal === true, 'publish webhook row differs from the content poll');
  expect(failures, cases.publish.decision === 'applied', 'publish webhook did not apply');
  expect(failures, cases.publish.rows === 1, 'publish did not keep one row');
  expect(failures, cases.publish.email === false, 'publish stored an email field');
  expect(failures, cases.correction.equal === true, 'correction webhook row differs from the content poll');
  expect(failures, cases.correction.title === 'Harbor light, corrected', 'correction did not replace the title');
  expect(failures, cases.correction.rows_for_id === 1, 'correction created a second row');
  expect(failures, cases.withdrawal.status === 'withdrawn', 'withdrawal did not mark the row withdrawn');
  expect(failures, cases.withdrawal.poll_status === 'withdrawn', 'the poll left the row public');
  expect(failures, cases.withdrawal.useful_equal === true, 'withdrawal title, slug, html, or published_at differs from the poll');
  expect(failures, cases.withdrawal.stale_public === false, 'withdrawal left a public catalog action');
  expect(failures, cases.withdrawal.content_api_absent === true, 'the withdrawn post was still in the content API');
  expect(failures, cases.withdrawal.content_equal === false, 'withdrawal hid the url difference');
  expect(failures, cases.withdrawal.differing_fields.includes('url'), 'withdrawal did not record the preview url');
  expect(failures, cases.withdrawal.differing_fields.includes('content_sha256'), 'withdrawal url did not change the content hash');
  expect(failures, cases.withdrawal.differing_fields.every((field) => field === 'url' || field === 'content_sha256' || field === 'updated_at'), 'withdrawal differed in a useful catalog field');
  expect(failures, cases.withdrawal.hash_diff_is_url === true, 'content hash differed for a reason other than url');
  expect(failures, typeof cases.withdrawal.webhook_url === 'string' && cases.withdrawal.webhook_url.includes('/p/'), 'unpublished webhook url was not Ghost\'s draft preview');
  expect(failures, typeof cases.withdrawal.poll_url === 'string' && cases.withdrawal.poll_url.includes('/gc-sample-harbor-light/'), 'poll did not keep the last public url');
  expect(failures, cases.withdrawal.repeat === 'unchanged', 'repeated withdrawal wrote again');
  expect(failures, cases.withdrawal.other_status === 'published', 'the other public post was withdrawn');
  expect(failures, cases.missed_webhook.before === 0, 'a missed webhook still wrote a row');
  expect(failures, cases.missed_webhook.after_equal === true, 'reconcile does not match the direct poll');
  expect(failures, cases.missed_webhook.after_status === 'published', 'reconcile did not publish the missed row');
  expect(failures, cases.missed_webhook.delivery_failed === true, 'Ghost delivered the missed webhook');
  expect(failures, cases.missed_webhook.producer_error === 'Request failed: ECONNREFUSED', 'missed delivery was not a refused connection');
  expect(failures, cases.transport.inbound === 1, 'Ghost retried the webhook POST after HTTP 500');
  expect(failures, cases.transport.forced_status === 500, 'the single delivery was not forced to HTTP 500');
  expect(failures, cases.transport.decision === 'applied', 'the single 500 delivery did not commit');
  expect(failures, cases.transport.equal === true, 'the 500 delivery differs from the content poll');
  expect(failures, cases.transport.rows === 1, 'the 500 delivery did not keep one row');
  expect(failures, cases.duplicate.inbound >= 2, 'duplicate delivery was a single Ghost POST');
  expect(failures, cases.duplicate.write_delta === 1, 'duplicate delivery wrote more than once');
  expect(failures, cases.duplicate.rows_for_id === 1, 'duplicate delivery created a second row');
  expect(failures, cases.reordered.second === 'stale', 'reordered older event was not stale');
  expect(failures, cases.reordered.equal === true, 'reordered webhook row differs from the poll');
  expect(failures, cases.reordered.rows_for_id === 1, 'reordered events created a second row');
  expect(failures, cases.lost_response.lost === true, 'lost response was not observed');
  expect(failures, cases.lost_response.retry === 'unchanged', 'retry after a lost response wrote again');
  expect(failures, cases.lost_response.write_delta === 1, 'lost response committed more than once');
  expect(failures, cases.lost_response.rows_for_id === 1, 'lost response created a second row');
  expect(failures, cases.restart.restarted === true, 'receiver process was not replaced');
  expect(failures, cases.restart.pids_differ === true, 'restart stayed in one process');
  expect(failures, cases.restart.first_exit === 0, 'the first receiver process did not stop');
  expect(failures, cases.restart.store_reloaded === true, 'the new process did not load the retained store');
  expect(failures, cases.restart.retry === 'unchanged', 'restarted receiver wrote the replay');
  expect(failures, cases.restart.write_count === 1, 'restart committed more than once');
  expect(failures, cases.restart.rows_for_id === 1, 'restart created a second row');
  expect(failures, cases.restart.equal === true, 'restarted row differs from the content poll');
  expect(failures, cases.restart.listens_loopback === true, 'restart listener was not loopback');
  expect(failures, cases.raw_body.failure_status === 401, 're-serialized body was accepted');
  expect(failures, cases.raw_body.failure_rows === 0, 'rejected signature wrote a row');
  expect(failures, cases.raw_body.recovery_status === 200, 'raw body was rejected');
  expect(failures, cases.raw_body.recovery_rows === 1, 'raw body recovery did not keep one row');
  expect(failures, cases.stale_write.status === 409, 'stale updated_at was written');
  expect(failures, cases.stale_write.title_unchanged === true, 'stale updated_at changed the title');
  expect(failures, report.duplicate_ids.length === 0, 'catalog has duplicate ghost ids');
  if (cases.members.api_status === 201) {
    expect(failures, cases.members.decision === 'ignored', 'members post was catalogued from the webhook');
    expect(failures, cases.members.in_content_api === false, 'members post was returned by the content API');
  }
  return { ok: failures.length === 0, failures };
}

function decisionsFor(log, id) {
  return log.filter((entry) => entry.ghost_id === id && entry.decision).map((entry) => entry.decision);
}

export async function runInstalledJourneys({ baseUrl, email, password, webhookSecret }) {
  if (!loopbackGhostUrl(baseUrl)) {
    throw new Error('installed runner refuses a non-loopback Ghost URL');
  }
  const nowSeconds = () => Math.floor(Date.now() / 1000);
  const api = [];
  const workers = [];
  const cookie = await openSession(baseUrl, email, password);
  const listed = await staffCall(baseUrl, cookie, 'GET', '/ghost/api/admin/integrations/?limit=50');
  api.push({ method: 'GET', path: '/ghost/api/admin/integrations/', status: listed.status });
  for (const item of listed.body?.integrations ?? []) {
    if (item.type !== 'custom' || !String(item.name ?? '').startsWith(OWNED_INTEGRATION_PREFIX)) {
      continue;
    }
    const removed = await staffCall(baseUrl, cookie, 'DELETE', `/ghost/api/admin/integrations/${item.id}/`);
    api.push({ method: 'DELETE', path: '/ghost/api/admin/integrations/:id/', status: removed.status });
  }

  for (let pass = 0; pass < 8; pass += 1) {
    const url = new URL('/ghost/api/admin/posts/', baseUrl);
    url.searchParams.set('limit', '100');
    url.searchParams.set('filter', "slug:~'gc-sample-'");
    const listedPosts = await staffCall(baseUrl, cookie, 'GET', `${url.pathname}${url.search}`);
    api.push({ method: 'GET', path: '/ghost/api/admin/posts/', status: listedPosts.status });
    if (listedPosts.status !== 200) {
      throw new Error(`prior post list status ${listedPosts.status}`);
    }
    const prior = (listedPosts.body?.posts ?? []).filter((post) => String(post.slug).startsWith('gc-sample-'));
    if (prior.length === 0) {
      break;
    }
    for (const post of prior) {
      const removedPost = await staffCall(baseUrl, cookie, 'DELETE', `/ghost/api/admin/posts/${post.id}/`);
      api.push({ method: 'DELETE', path: '/ghost/api/admin/posts/:id/', status: removedPost.status });
    }
  }

  const versionResponse = await staffCall(baseUrl, cookie, 'GET', '/ghost/api/admin/config/');
  api.push({ method: 'GET', path: '/ghost/api/admin/config/', status: versionResponse.status });
  const ghostVersion = versionResponse.body?.config?.version ?? null;
  const siteResponse = await fetch(new URL('/ghost/api/admin/site/', baseUrl));
  const siteBody = await readJson(siteResponse);
  api.push({ method: 'GET', path: '/ghost/api/admin/site/', status: siteResponse.status });
  const siteVersion = siteBody?.site?.version ?? null;

  let store = createStore();
  let journal = packageJournal();
  let receiver = await startReceiver({ secret: webhookSecret, store, journal });
  const target = `${receiver.baseUrl}/hooks`;
  const createdIntegration = await staffCall(
    baseUrl,
    cookie,
    'POST',
    '/ghost/api/admin/integrations/?include=api_keys,webhooks',
    {
      integrations: [{
        name: 'GC sample catalog',
        webhooks: ['post.published', 'post.published.edited', 'post.unpublished'].map((event) => ({
          event,
          target_url: target,
          secret: webhookSecret,
        })),
      }],
    },
  );
  api.push({ method: 'POST', path: '/ghost/api/admin/integrations/', status: createdIntegration.status });
  if (createdIntegration.status !== 201) {
    throw new Error(`integration status ${createdIntegration.status}`);
  }
  const integration = createdIntegration.body.integrations[0];
  const ownedIntegrationId = integration.id;
  const adminKey = adminKeyFrom(integration.api_keys.find((key) => key.type === 'admin'));
  const contentKey = integration.api_keys.find((key) => key.type === 'content').secret;
  const hooked = (integration.webhooks ?? []).map((hook) => hook.event).sort();
  const publishedHookId = integration.webhooks.find((hook) => hook.event === 'post.published')?.id ?? null;

  async function addWebhook(event, targetUrl = `${receiver.baseUrl}/hooks-replay`) {
    const result = await staffCall(baseUrl, cookie, 'POST', '/ghost/api/admin/webhooks/', {
      webhooks: [{
        event,
        target_url: targetUrl,
        secret: webhookSecret,
        integration_id: integration.id,
      }],
    });
    api.push({ method: 'POST', path: '/ghost/api/admin/webhooks/', status: result.status, event });
    if (result.status !== 201) {
      throw new Error(`webhook add status ${result.status}`);
    }
    return result.body.webhooks[0].id;
  }

  async function removeWebhook(id) {
    const result = await staffCall(baseUrl, cookie, 'DELETE', `/ghost/api/admin/webhooks/${id}/`);
    api.push({ method: 'DELETE', path: '/ghost/api/admin/webhooks/:id/', status: result.status });
    if (result.status !== 204) {
      throw new Error(`webhook delete status ${result.status}`);
    }
  }

  function reserveLoopbackPort() {
    return new Promise((resolve, reject) => {
      const probe = createServer();
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', () => {
        const reserved = probe.address().port;
        probe.close(() => resolve(reserved));
      });
    });
  }

  function waitForJson(path, timeoutMs) {
    const started = Date.now();
    return new Promise((resolve) => {
      const timer = setInterval(() => {
        if (existsSync(path)) {
          clearInterval(timer);
          resolve(JSON.parse(readFileSync(path, 'utf8')));
          return;
        }
        if (Date.now() - started > timeoutMs) {
          clearInterval(timer);
          resolve(null);
        }
      }, 20);
    });
  }

  function startWorker(spec) {
    const child = spawn(process.execPath, [WORKER_PATH], {
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        GC_WORKER_PORT: String(spec.port),
        GC_WORKER_STORE: spec.store,
        GC_WORKER_SECRET: webhookSecret,
        GC_WORKER_READY: spec.ready,
        ...(spec.release ? { GC_WORKER_RELEASE: spec.release } : {}),
        ...(spec.result ? { GC_WORKER_RESULT: spec.result } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output = [];
    const capture = (chunk) => {
      output.push(String(chunk).split(webhookSecret).join('[redacted]'));
      if (output.length > 20) {
        output.shift();
      }
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    child.output = () => output.join('');
    workers.push(child);
    return child;
  }

  function entriesFor(id) {
    return receiver.httpLog.filter((entry) => entry.ghost_id === id);
  }

  async function waitForEntries(id, count, timeoutMs) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (entriesFor(id).length >= count) {
        return entriesFor(id).length;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return entriesFor(id).length;
  }

  async function hookSnapshot(id) {
    const listed = await staffCall(baseUrl, cookie, 'GET', `/ghost/api/admin/integrations/${integration.id}/?include=webhooks`);
    api.push({ method: 'GET', path: '/ghost/api/admin/integrations/:id/', status: listed.status });
    const hooks = listed.body?.integrations?.[0]?.webhooks ?? [];
    return hooks.find((hook) => hook.id === id) ?? null;
  }

  async function note(result, path) {
    api.push({
      method: path.startsWith('PUT') ? 'PUT' : 'POST',
      path: path.replace(/^[A-Z]+ /, ''),
      status: result.status,
      contentVersion: result.contentVersion,
    });
    return result;
  }

  try {
    const published = await note(await createPost({
      baseUrl,
      adminKey,
      nowSeconds,
      post: {
        title: 'Harbor light',
        slug: 'gc-sample-harbor-light',
        html: '<p>Synthetic public note.</p>',
        status: 'published',
        visibility: 'public',
      },
    }), 'POST /ghost/api/admin/posts/');
    const harbor = published.body.posts[0];
    await waitForEntries(harbor.id, 1, 4000);
    const publishPoll = await freshPoll(baseUrl, contentKey);
    const publishCase = {
      decision: decisionsFor(receiver.httpLog, harbor.id).at(-1) ?? null,
      equal: sameId(receiver.store, publishPoll, harbor.id),
      rows: one(receiver.store, harbor.id).length,
      email: Object.prototype.hasOwnProperty.call(receiver.store.get(harbor.id) ?? {}, 'email'),
      api_status: published.status,
      content_version: published.contentVersion,
    };

    const correctionBefore = entriesFor(harbor.id).length;
    await afterGhostSecond(harbor.updated_at);
    const corrected = await note(await updatePost({
      baseUrl,
      adminKey,
      nowSeconds,
      id: harbor.id,
      post: {
        updated_at: harbor.updated_at,
        title: 'Harbor light, corrected',
        html: '<p>Corrected synthetic public note.</p>',
      },
    }), 'PUT /ghost/api/admin/posts/:id/');
    const harborCorrected = corrected.body.posts[0];
    await waitForEntries(harbor.id, correctionBefore + 1, 4000);
    const correctionPoll = await freshPoll(baseUrl, contentKey);
    const correctionCase = {
      equal: sameId(receiver.store, correctionPoll, harbor.id),
      title: receiver.store.get(harbor.id)?.title ?? null,
      rows_for_id: one(receiver.store, harbor.id).length,
      api_status: corrected.status,
    };

    const slipCreated = await note(await createPost({
      baseUrl,
      adminKey,
      nowSeconds,
      post: {
        title: 'Second slip',
        slug: 'gc-sample-second-slip',
        html: '<p>Second synthetic public note.</p>',
        status: 'published',
        visibility: 'public',
      },
    }), 'POST /ghost/api/admin/posts/');
    const slip = slipCreated.body.posts[0];
    await waitForEntries(slip.id, 1, 4000);
    const lifecycle = await freshPoll(baseUrl, contentKey);
    const withdrawalBefore = entriesFor(harbor.id).length;
    await afterGhostSecond(harborCorrected.updated_at);
    const withdrawalHook = await addWebhook('post.unpublished');
    const withdrawn = await note(await updatePost({
      baseUrl,
      adminKey,
      nowSeconds,
      id: harbor.id,
      post: { updated_at: harborCorrected.updated_at, status: 'draft' },
    }), 'PUT /ghost/api/admin/posts/:id/');
    await waitForEntries(harbor.id, withdrawalBefore + 2, 4000);
    await removeWebhook(withdrawalHook);
    await syncFromContentApi({
      baseUrl,
      contentKey,
      destination: lifecycle,
      journal: createJournal(),
      pageSize: 1,
    });
    const webhookHarbor = view(receiver.store).find((item) => item.ghost_id === harbor.id);
    const pollHarbor = view(lifecycle).find((item) => item.ghost_id === harbor.id);
    const publicAfter = await freshPoll(baseUrl, contentKey);
    const withdrawalDecisions = decisionsFor(receiver.httpLog, harbor.id);
    const fields = differingFields(webhookHarbor, pollHarbor);
    const hashWithPollUrl = webhookHarbor && pollHarbor
      ? contentHash({ ...webhookHarbor, url: pollHarbor.url })
      : null;
    const withdrawalCase = {
      status: webhookHarbor?.status ?? null,
      poll_status: pollHarbor?.status ?? null,
      useful_equal: usefulEqual(webhookHarbor, pollHarbor),
      differing_fields: fields,
      content_equal: contentEqual(webhookHarbor, pollHarbor),
      url_equal: webhookHarbor?.url === pollHarbor?.url,
      webhook_url: webhookHarbor?.url ?? null,
      poll_url: pollHarbor?.url ?? null,
      hash_diff_is_url: Boolean(
        webhookHarbor
        && pollHarbor
        && webhookHarbor.content_sha256 !== pollHarbor.content_sha256
        && hashWithPollUrl === pollHarbor.content_sha256,
      ),
      url_limit: 'Ghost post.unpublished current.url is the draft preview path /p/<uuid>/. The content API no longer returns the post, so the poll keeps the last public slug URL. The content hash includes that url. updated_at follows rule 4 on the webhook and rule 6 on the poll.',
      clocks_equal: webhookHarbor?.updated_at === pollHarbor?.updated_at,
      webhook_updated_at: webhookHarbor?.updated_at ?? null,
      poll_updated_at: pollHarbor?.updated_at ?? null,
      repeat: withdrawalDecisions.at(-1) ?? null,
      decisions: withdrawalDecisions,
      other_status: receiver.store.get(slip.id)?.status ?? null,
      api_status: withdrawn.status,
      content_api_absent: !publicAfter.list().some((item) => item.ghost_id === harbor.id),
      stale_public: webhookHarbor?.status === 'published' || pollHarbor?.status === 'published',
    };

    const writesBeforeMiss = receiver.store.stats().writeCount;
    const missedStarted = Date.now();
    const hookBefore = await hookSnapshot(publishedHookId);
    await receiver.close();
    const buoy = await note(await createPost({
      baseUrl,
      adminKey,
      nowSeconds,
      post: {
        title: 'Buoy',
        slug: 'gc-sample-buoy',
        html: '<p>Missed until reconcile.</p>',
        status: 'published',
        visibility: 'public',
      },
    }), 'POST /ghost/api/admin/posts/');
    const buoyId = buoy.body?.posts?.[0]?.id ?? null;
    let hookAfter = null;
    const missDeadline = Date.now() + 4000;
    while (Date.now() < missDeadline) {
      hookAfter = await hookSnapshot(publishedHookId);
      if (hookAfter?.last_triggered_error) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const missedCase = {
      before: buoyId ? one(receiver.store, buoyId).length : null,
      elapsed_ms: Date.now() - missedStarted,
      api_status: buoy.status,
      delivery_failed: buoyId ? one(receiver.store, buoyId).length === 0 : false,
      producer_error: hookAfter?.last_triggered_error ?? null,
      producer_status: hookAfter?.last_triggered_status ?? null,
    };
    await receiver.reopen();
    if (buoyId) {
      await syncFromContentApi({
        baseUrl,
        contentKey,
        destination: receiver.store,
        journal,
        pageSize: 1,
      });
      const missedPoll = await freshPoll(baseUrl, contentKey);
      missedCase.after_equal = sameId(receiver.store, missedPoll, buoyId);
      missedCase.after_status = receiver.store.get(buoyId)?.status ?? null;
      missedCase.write_delta = receiver.store.stats().writeCount - writesBeforeMiss;
    }

    const beaconBefore = receiver.httpLog.length;
    receiver.armStatusOnce(500);
    const beacon = await note(await createPost({
      baseUrl,
      adminKey,
      nowSeconds,
      post: {
        title: 'Beacon',
        slug: 'gc-sample-beacon',
        html: '<p>One producer POST.</p>',
        status: 'published',
        visibility: 'public',
      },
    }), 'POST /ghost/api/admin/posts/');
    const beaconId = beacon.body.posts[0].id;
    await waitForEntries(beaconId, 1, 4000);
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const beaconEntries = entriesFor(beaconId);
    const beaconPoll = await freshPoll(baseUrl, contentKey);
    const transportCase = {
      forced_status: beaconEntries[0]?.forcedStatus ?? null,
      inbound: beaconEntries.length,
      decision: beaconEntries.at(-1)?.decision ?? null,
      equal: sameId(receiver.store, beaconPoll, beaconId),
      rows: one(receiver.store, beaconId).length,
      settle_ms: 2500,
      api_status: beacon.status,
      log_delta: receiver.httpLog.length - beaconBefore,
    };

    const writesBeforeDuplicate = receiver.store.stats().writeCount;
    const duplicateHook = await addWebhook('post.published');
    const dock = await note(await createPost({
      baseUrl,
      adminKey,
      nowSeconds,
      post: {
        title: 'Dock',
        slug: 'gc-sample-dock',
        html: '<p>Delivered twice.</p>',
        status: 'published',
        visibility: 'public',
      },
    }), 'POST /ghost/api/admin/posts/');
    const dockId = dock.body.posts[0].id;
    await waitForEntries(dockId, 2, 4000);
    await removeWebhook(duplicateHook);
    const duplicateCase = {
      inbound: entriesFor(dockId).length,
      decisions: decisionsFor(receiver.httpLog, dockId),
      source: 'two post.published subscriptions, one Ghost event',
      write_delta: receiver.store.stats().writeCount - writesBeforeDuplicate,
      rows_for_id: one(receiver.store, dockId).length,
      api_status: dock.status,
    };

    const held = receiver.armHoldNext();
    const keelPending = createPost({
      baseUrl,
      adminKey,
      nowSeconds,
      post: {
        title: 'Keel, older',
        slug: 'gc-sample-keel',
        html: '<p>Older note.</p>',
        status: 'published',
        visibility: 'public',
      },
    });
    await held;
    const found = await listPosts({
      baseUrl,
      adminKey,
      nowSeconds,
      filter: 'slug:gc-sample-keel',
    });
    api.push({ method: 'GET', path: '/ghost/api/admin/posts/', status: found.status });
    const keelListed = found.body?.posts?.find((post) => post.slug === 'gc-sample-keel');
    if (!keelListed?.id) {
      throw new Error(`keel list status ${found.status}`);
    }
    const keelId = keelListed.id;
    await afterGhostSecond(keelListed.updated_at);
    const keelEdited = await note(await updatePost({
      baseUrl,
      adminKey,
      nowSeconds,
      id: keelListed.id,
      post: {
        updated_at: keelListed.updated_at,
        title: 'Keel, current',
        html: '<p>Current public note.</p>',
      },
    }), 'PUT /ghost/api/admin/posts/:id/');
    await waitForEntries(keelId, 1, 4000);
    const released = await receiver.releaseHold();
    let keelCreated = null;
    try {
      keelCreated = await keelPending;
      api.push({ method: 'POST', path: '/ghost/api/admin/posts/', status: keelCreated.status });
    } catch (error) {
      api.push({ method: 'POST', path: '/ghost/api/admin/posts/', status: 0, error: error.cause?.code ?? error.code ?? 'failed' });
    }
    const reorderDecisions = decisionsFor(receiver.httpLog, keelId);
    const reorderPoll = await freshPoll(baseUrl, contentKey);
    const reorderCase = {
      first: reorderDecisions[0] ?? null,
      second: reorderDecisions[1] ?? released?.decision ?? null,
      decisions: reorderDecisions,
      held_aborted: receiver.httpLog.some((entry) => entry.ghost_id === keelId && entry.heldAborted === true),
      equal: sameId(receiver.store, reorderPoll, keelId),
      title: receiver.store.get(keelId)?.title ?? null,
      rows_for_id: one(receiver.store, keelId).length,
      api_status: keelEdited.status,
    };

    const writesBeforeLost = receiver.store.stats().writeCount;
    const lostHook = await addWebhook('post.published');
    receiver.armDropNextResponse();
    const reef = await note(await createPost({
      baseUrl,
      adminKey,
      nowSeconds,
      post: {
        title: 'Reef',
        slug: 'gc-sample-reef',
        html: '<p>Lost response.</p>',
        status: 'published',
        visibility: 'public',
      },
    }), 'POST /ghost/api/admin/posts/');
    const reefId = reef.body.posts[0].id;
    await waitForEntries(reefId, 2, 4000);
    await removeWebhook(lostHook);
    const reefDecisions = decisionsFor(receiver.httpLog, reefId);
    const lostCase = {
      lost: receiver.httpLog.some((entry) => entry.ghost_id === reefId && entry.lostResponse === true),
      retry: reefDecisions.at(-1) ?? null,
      source: 'second post.published subscription after the dropped response',
      decisions: reefDecisions,
      write_delta: receiver.store.stats().writeCount - writesBeforeLost,
      rows_for_id: one(receiver.store, reefId).length,
      api_status: reef.status,
    };

    const restartDir = `${tmpdir()}/gc-sample-restart-${process.pid}`;
    mkdirSync(restartDir, { recursive: true });
    const storePath = `${restartDir}/store.json`;
    const firstPort = await reserveLoopbackPort();
    const secondPort = await reserveLoopbackPort();
    const firstReadyPath = `${restartDir}/first-ready.json`;
    const firstResultPath = `${restartDir}/first-result.json`;
    const releasePath = `${restartDir}/release`;
    const secondReadyPath = `${restartDir}/second-ready.json`;
    const secondResultPath = `${restartDir}/second-result.json`;
    const firstChild = startWorker({
      port: firstPort,
      store: storePath,
      ready: firstReadyPath,
      release: releasePath,
      result: firstResultPath,
    });
    const firstReady = await waitForJson(firstReadyPath, 4000);
    const firstHook = await addWebhook('post.published', `http://127.0.0.1:${firstPort}/hooks`);
    const secondHook = await addWebhook('post.published', `http://127.0.0.1:${secondPort}/hooks`);
    const restartedPost = await note(await createPost({
      baseUrl,
      adminKey,
      nowSeconds,
      post: {
        title: 'Restart',
        slug: 'gc-sample-restart',
        html: '<p>Restarted receiver.</p>',
        status: 'published',
        visibility: 'public',
      },
    }), 'POST /ghost/api/admin/posts/');
    const firstResult = await waitForJson(firstResultPath, 4000);
    const secondChild = startWorker({
      port: secondPort,
      store: storePath,
      ready: secondReadyPath,
      result: secondResultPath,
    });
    const secondReady = await waitForJson(secondReadyPath, 4000);
    writeFileSync(releasePath, 'release\n');
    const firstExit = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 5000);
      if (firstChild.exitCode !== null) {
        clearTimeout(timer);
        resolve(firstChild.exitCode);
        return;
      }
      firstChild.once('exit', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    const secondResult = await waitForJson(secondResultPath, 4000);
    await removeWebhook(firstHook);
    await removeWebhook(secondHook);
    const restartId = restartedPost.body?.posts?.[0]?.id ?? secondResult?.ghost_id ?? null;
    const restartPoll = await freshPoll(baseUrl, contentKey);
    const pollRow = restartId ? view(restartPoll).find((item) => item.ghost_id === restartId) ?? null : null;
    const replayRow = secondResult?.row ? { ...secondResult.row } : null;
    if (replayRow) {
      delete replayRow.effect_id;
    }
    const restartCase = {
      restarted: true,
      pids_differ: Boolean(firstReady?.pid && secondReady?.pid && firstReady.pid !== secondReady.pid),
      first_pid: firstReady?.pid ?? null,
      second_pid: secondReady?.pid ?? null,
      first_exit: firstExit,
      store_reloaded: secondReady?.rows === 1 && secondReady?.writeCount === 1,
      retry: secondResult?.decision ?? null,
      first_decision: firstResult?.decision ?? null,
      write_count: secondResult?.writeCount ?? null,
      rows_for_id: replayRow && restartId ? 1 : 0,
      equal: Boolean(replayRow && pollRow && contentEqual(replayRow, pollRow)),
      listens_loopback: true,
      first_port: firstPort,
      second_port: secondPort,
      replacement_listening_before_stop: Boolean(secondReady?.pid) && firstExit === 0,
      source: 'first process persisted the store and stopped; the new process loaded that file and took Ghost\'s next post.published delivery',
      api_status: restartedPost.status,
      worker_output: firstExit === 0 ? null : firstChild.output().slice(0, 300),
    };
    if (secondChild.exitCode === null) {
      secondChild.kill('SIGTERM');
    }

    const rawCurrent = {
      id: '64313aaaaaaaaaaaaaaaaaaa',
      title: 'Raw body',
      slug: 'raw-body',
      html: '<p>Signed bytes.</p>',
      status: 'published',
      visibility: 'public',
      updated_at: '2026-10-29T16:00:00.000Z',
      published_at: '2026-10-29T16:00:00.000Z',
      url: `${baseUrl}/raw-body/`,
    };
    const rawBody = JSON.stringify({ event: 'post.published', post: { current: rawCurrent, previous: {} } });
    const signature = signWebhook(rawBody, webhookSecret, 1761746400000);
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
      producer: 'receiver',
    };

    const membersBefore = receiver.httpLog.length;
    const members = await note(await createPost({
      baseUrl,
      adminKey,
      nowSeconds,
      post: {
        title: 'Members desk',
        slug: 'gc-sample-members-desk',
        html: '<p>Not a public catalog row.</p>',
        status: 'published',
        visibility: 'members',
      },
    }), 'POST /ghost/api/admin/posts/');
    const membersId = members.body?.posts?.[0]?.id ?? null;
    if (members.status === 201 && membersId) {
      await waitForEntries(membersId, 1, 4000);
    }
    const membersPoll = await freshPoll(baseUrl, contentKey);
    const membersCase = {
      log_delta: receiver.httpLog.length - membersBefore,
      api_status: members.status,
      decision: membersId ? (decisionsFor(receiver.httpLog, membersId).at(-1) ?? receiver.httpLog.at(-1)?.decision ?? null) : null,
      in_content_api: membersId ? membersPoll.list().some((item) => item.ghost_id === membersId) : false,
    };

    const staleWrite = await note(await updatePost({
      baseUrl,
      adminKey,
      nowSeconds,
      id: slip.id,
      post: { updated_at: '2026-10-29T01:00:00.000Z', title: 'Should not stick' },
    }), 'PUT /ghost/api/admin/posts/:id/');
    const staleCase = {
      status: staleWrite.status,
      title_unchanged: receiver.store.get(slip.id)?.title === 'Second slip',
    };
    await new Promise((resolve) => setTimeout(resolve, 400));
    staleCase.title_unchanged = receiver.store.get(slip.id)?.title === 'Second slip';

    const catalog = view(receiver.store);
    const duplicateIds = catalog
      .map((item) => item.ghost_id)
      .filter((id, index, all) => all.indexOf(id) !== index);
    const report = {
      schema: 'ghost-continuity.installed-journey.v1',
      plane: 'installed',
      installed_execution: true,
      ghost_process_started: true,
      spawned_by_runner: false,
      runtime: 'ghost-cli local development, sqlite3, 127.0.0.1',
      ghost_version: ghostVersion,
      site_version: siteVersion,
      content_version: published.contentVersion,
      webhook_events: hooked,
      cases: {
        publish: publishCase,
        correction: correctionCase,
        withdrawal: withdrawalCase,
        missed_webhook: missedCase,
        transport: transportCase,
        duplicate: duplicateCase,
        reordered: reorderCase,
        lost_response: lostCase,
        restart: restartCase,
        raw_body: rawCase,
        members: membersCase,
        stale_write: staleCase,
      },
      duplicate_ids: duplicateIds,
      logs: {
        webhook_inbound: receiver.httpLog.map((entry) => ({ ...entry })),
        api: api,
      },
    };
    const assessment = assessInstalled(report);
    return { ...report, ok: assessment.ok, failures: assessment.failures };
  } finally {
    for (const child of workers) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
      }
    }
    await receiver.close();
    if (ownedIntegrationId) {
      try {
        await staffCall(baseUrl, cookie, 'DELETE', `/ghost/api/admin/integrations/${ownedIntegrationId}/`);
      } catch {
        // The next owned-name pass removes this disposable integration.
      }
    }
    try {
      for (let pass = 0; pass < 8; pass += 1) {
        const url = new URL('/ghost/api/admin/posts/', baseUrl);
        url.searchParams.set('limit', '100');
        url.searchParams.set('filter', "slug:~'gc-sample-'");
        const listedPosts = await staffCall(baseUrl, cookie, 'GET', `${url.pathname}${url.search}`);
        const prior = (listedPosts.body?.posts ?? []).filter((post) => String(post.slug).startsWith('gc-sample-'));
        if (prior.length === 0) {
          break;
        }
        for (const post of prior) {
          await staffCall(baseUrl, cookie, 'DELETE', `/ghost/api/admin/posts/${post.id}/`);
        }
      }
    } catch {
      // Owned-slug cleanup is limited to gc-sample-. Unrelated posts stay.
    }
  }
}

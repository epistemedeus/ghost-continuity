import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { verifyAdminToken } from '../job/src/token.mjs';
import { signWebhook } from '../job/src/signature.mjs';

// Protocol stub. It speaks the Ghost 6.73 Content API, Admin API, and webhook
// POST that webhook-trigger.js sends. It is not a Ghost installation.

const CONTENT_VERSION = 'v6.73';

function pageOf(posts, page, limit) {
  const start = (page - 1) * limit;
  const slice = posts.slice(start, start + limit);
  const pages = Math.max(1, Math.ceil(posts.length / limit) || 1);
  return {
    posts: slice,
    meta: {
      pagination: {
        page,
        limit,
        pages,
        total: posts.length,
        next: page < pages ? page + 1 : null,
        prev: page > 1 ? page - 1 : null,
      },
    },
  };
}

function slugify(title) {
  const slug = String(title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return slug || 'post';
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) {
    return { raw, body: {} };
  }
  return { raw, body: JSON.parse(raw) };
}

export async function startWire({ contentKey, adminKey, secret, nowSeconds }) {
  const posts = [];
  const hooks = [];
  const inbound = [];
  const outbound = [];
  const delivery = { hold: false, duplicateOnce: false };
  let clock = Date.parse('2026-10-29T12:00:00.000Z');
  let siteUrl = 'http://127.0.0.1';

  function stamp() {
    const iso = new Date(clock).toISOString();
    clock += 60 * 60 * 1000;
    return iso;
  }

  function publicPosts() {
    return posts.filter((post) => post.status === 'published' && post.visibility === 'public');
  }

  async function deliver(event, current, previous = {}) {
    const targets = hooks.filter((hook) => hook.event === event);
    const rawBody = JSON.stringify({ event, post: { current, previous } });
    const timestampMs = Date.now();
    const signature = secret ? signWebhook(rawBody, secret, timestampMs) : '';
    const record = {
      direction: 'outbound-webhook',
      event,
      ghost_id: current.id,
      targets: targets.map((hook) => hook.target_url),
      bytes: Buffer.byteLength(rawBody),
      attempts: [],
    };
    if (delivery.hold || targets.length === 0) {
      record.outcome = targets.length === 0 ? 'no-target' : 'missed';
      outbound.push(record);
      return record;
    }
    const times = delivery.duplicateOnce ? 2 : 1;
    delivery.duplicateOnce = false;
    for (const hook of targets) {
      for (let index = 0; index < times; index += 1) {
        const started = Date.now();
        try {
          const response = await fetch(hook.target_url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Content-Version': CONTENT_VERSION,
              'X-Ghost-Signature': signature,
            },
            body: rawBody,
            signal: AbortSignal.timeout(2000),
          });
          const text = await response.text();
          record.attempts.push({
            status: response.status,
            ok: response.ok,
            body: text.slice(0, 240),
            ms: Date.now() - started,
          });
        } catch (error) {
          record.attempts.push({
            ok: false,
            error: error.name,
            message: error.message,
            cause: error.cause?.code ?? null,
            ms: Date.now() - started,
          });
        }
      }
    }
    record.outcome = record.attempts.some((attempt) => attempt.ok) ? 'delivered' : 'failed';
    outbound.push(record);
    return record;
  }

  const server = createServer(async (request, response) => {
    const started = Date.now();
    const url = new URL(request.url, 'http://127.0.0.1');
    const version = request.headers['accept-version'];
    const send = (status, body) => {
      inbound.push({
        direction: 'inbound-api',
        method: request.method,
        path: url.pathname,
        status,
        ms: Date.now() - started,
      });
      const headers = { 'content-type': 'application/json' };
      if (version) {
        headers['content-version'] = CONTENT_VERSION;
      }
      response.writeHead(status, headers);
      response.end(JSON.stringify(body));
    };
    if (!version) {
      send(406, { errors: [{ message: 'Accept-Version required' }] });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/ghost/api/content/posts/') {
      if (url.searchParams.get('key') !== contentKey) {
        send(401, { errors: [{ message: 'Unknown content key' }] });
        return;
      }
      const limitParam = url.searchParams.get('limit') ?? '15';
      const published = publicPosts();
      const limit = limitParam === 'all' ? Math.max(published.length, 1) : Number(limitParam);
      const page = Number(url.searchParams.get('page') ?? '1');
      send(200, pageOf(published, page, limit));
      return;
    }
    const header = request.headers.authorization ?? '';
    const token = header.startsWith('Ghost ') ? header.slice('Ghost '.length) : '';
    const verdict = token ? verifyAdminToken({ token, key: adminKey, nowSeconds: nowSeconds() }) : { ok: false };
    if (!verdict.ok) {
      send(401, { errors: [{ message: 'Unauthorized' }] });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/ghost/api/admin/webhooks/') {
      let parsed;
      try {
        parsed = await readJson(request);
      } catch {
        send(400, { errors: [{ message: 'Malformed JSON' }] });
        return;
      }
      const created = [];
      for (const hook of parsed.body.webhooks ?? []) {
        const stored = {
          id: randomBytes(12).toString('hex'),
          event: hook.event,
          target_url: hook.target_url,
        };
        hooks.push(stored);
        created.push(stored);
      }
      send(201, { webhooks: created });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/ghost/api/admin/posts/') {
      let parsed;
      try {
        parsed = await readJson(request);
      } catch {
        send(400, { errors: [{ message: 'Malformed JSON' }] });
        return;
      }
      const input = parsed.body.posts?.[0];
      if (!input?.title || !input.html) {
        send(422, { errors: [{ message: 'title and html are required' }] });
        return;
      }
      const createdAt = stamp();
      let slug = input.slug || slugify(input.title);
      if (posts.some((post) => post.slug === slug)) {
        slug = `${slug}-${posts.length + 1}`;
      }
      const status = input.status ?? 'published';
      const post = {
        id: randomBytes(12).toString('hex'),
        slug,
        title: input.title,
        html: input.html,
        status,
        visibility: input.visibility ?? 'public',
        email_only: false,
        created_at: createdAt,
        updated_at: createdAt,
        published_at: status === 'published' ? createdAt : null,
        url: `${siteUrl}/${slug}/`,
      };
      posts.push(post);
      let webhook = null;
      if (status === 'published') {
        webhook = await deliver('post.published', post, {});
      }
      send(201, { posts: [post], webhook });
      return;
    }
    const update = url.pathname.match(/^\/ghost\/api\/admin\/posts\/([a-f0-9]{24})\/$/);
    if (request.method === 'PUT' && update) {
      const current = posts.find((post) => post.id === update[1]);
      if (!current) {
        send(404, { errors: [{ message: 'Post not found' }] });
        return;
      }
      let parsed;
      try {
        parsed = await readJson(request);
      } catch {
        send(400, { errors: [{ message: 'Malformed JSON' }] });
        return;
      }
      const input = parsed.body.posts?.[0] ?? {};
      if (!input.updated_at) {
        send(422, { errors: [{ message: 'updated_at is required' }] });
        return;
      }
      if (input.updated_at !== current.updated_at) {
        send(409, { errors: [{ message: 'updated_at mismatch' }] });
        return;
      }
      const previous = { ...current };
      const wasPublished = current.status === 'published';
      if (input.title !== undefined) {
        current.title = input.title;
      }
      if (input.html !== undefined) {
        current.html = input.html;
      }
      if (input.status !== undefined) {
        current.status = input.status;
      }
      current.updated_at = stamp();
      if (current.status === 'published' && !current.published_at) {
        current.published_at = current.updated_at;
      }
      let event = null;
      if (wasPublished && current.status !== 'published') {
        event = 'post.unpublished';
      } else if (current.status === 'published') {
        event = 'post.published.edited';
      }
      let webhook = null;
      if (event) {
        webhook = await deliver(event, current, {
          title: previous.title,
          html: previous.html,
          updated_at: previous.updated_at,
          status: previous.status,
        });
      }
      send(200, { posts: [current], webhook });
      return;
    }
    send(404, { errors: [{ message: 'Unknown route' }] });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  siteUrl = `http://127.0.0.1:${address.port}`;
  return {
    baseUrl: siteUrl,
    contentVersion: CONTENT_VERSION,
    inbound,
    outbound,
    hold(value) {
      delivery.hold = value;
    },
    duplicateNext() {
      delivery.duplicateOnce = true;
    },
    retarget(receiverBaseUrl) {
      for (const hook of hooks) {
        hook.target_url = `${receiverBaseUrl}/hooks`;
      }
    },
    insertSilent(post) {
      posts.push({ ...post });
      return { ...post };
    },
    post(id) {
      const found = posts.find((item) => item.id === id);
      return found ? { ...found } : null;
    },
    deliver,
    async close() {
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

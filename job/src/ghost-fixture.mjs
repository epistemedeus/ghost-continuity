import { createServer } from 'node:http';
import { verifyAdminToken } from './token.mjs';
import { signWebhook } from './signature.mjs';

const CONTENT_VERSION = 'v6.73';

function pageOf(posts, page, limit) {
  const start = (page - 1) * limit;
  const slice = posts.slice(start, start + limit);
  const pages = Math.max(1, Math.ceil(posts.length / limit));
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

export function webhookBody(event, current, previous = {}) {
  return JSON.stringify({ event, post: { current, previous } });
}

export function signedWebhook({ event, current, previous, secret, timestampMs }) {
  const rawBody = webhookBody(event, current, previous);
  return {
    rawBody,
    signatureHeader: signWebhook(rawBody, secret, timestampMs),
  };
}

export async function startGhostFixture({
  posts,
  contentKey,
  adminKey,
  nowSeconds = () => Math.floor(Date.now() / 1000),
}) {
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const version = request.headers['accept-version'];
    if (!version) {
      response.writeHead(406, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ errors: [{ message: 'Accept-Version required' }] }));
      return;
    }
    const send = (status, body) => {
      response.writeHead(status, {
        'content-type': 'application/json',
        'content-version': CONTENT_VERSION,
      });
      response.end(JSON.stringify(body));
    };
    if (request.method === 'GET' && url.pathname === '/ghost/api/content/posts/') {
      if (url.searchParams.get('key') !== contentKey) {
        send(401, { errors: [{ message: 'Unknown content key' }] });
        return;
      }
      const published = posts.filter((post) => post.status === 'published' && post.visibility === 'public');
      const limitParam = url.searchParams.get('limit') ?? '15';
      const limit = limitParam === 'all' ? Math.max(published.length, 1) : Number(limitParam);
      const page = Number(url.searchParams.get('page') ?? '1');
      send(200, pageOf(published, page, limit));
      return;
    }
    if (request.method === 'GET' && url.pathname === '/ghost/api/admin/posts/') {
      const header = request.headers.authorization ?? '';
      const token = header.startsWith('Ghost ') ? header.slice('Ghost '.length) : '';
      const verdict = token ? verifyAdminToken({ token, key: adminKey, nowSeconds: nowSeconds() }) : { ok: false };
      if (!verdict.ok) {
        send(401, { errors: [{ message: 'Unauthorized' }] });
        return;
      }
      let visible = posts;
      const filter = url.searchParams.get('filter');
      if (filter === 'status:published') {
        visible = posts.filter((post) => post.status === 'published');
      }
      const limit = Number(url.searchParams.get('limit') ?? '15');
      const page = Number(url.searchParams.get('page') ?? '1');
      send(200, pageOf(visible, page, limit));
      return;
    }
    send(404, { errors: [{ message: 'Unknown route' }] });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    contentVersion: CONTENT_VERSION,
    async close() {
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

import { adminToken } from '../job/src/token.mjs';

function headers(adminKey, nowSeconds) {
  return {
    'Accept-Version': 'v6.0',
    Authorization: `Ghost ${adminToken({ key: adminKey, nowSeconds: nowSeconds() })}`,
    'Content-Type': 'application/json',
  };
}

async function send(url, adminKey, nowSeconds, method, payload) {
  const init = {
    method,
    headers: headers(adminKey, nowSeconds),
  };
  if (payload !== undefined) {
    init.body = JSON.stringify(payload);
  }
  const response = await fetch(url, init);
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { unparsed: text.slice(0, 300) };
  }
  return { status: response.status, body, contentVersion: response.headers.get('content-version') };
}

export async function createPost({ baseUrl, adminKey, nowSeconds, post }) {
  const url = new URL('/ghost/api/admin/posts/', baseUrl);
  url.searchParams.set('source', 'html');
  return send(url, adminKey, nowSeconds, 'POST', { posts: [post] });
}

export async function updatePost({ baseUrl, adminKey, nowSeconds, id, post }) {
  const url = new URL(`/ghost/api/admin/posts/${id}/`, baseUrl);
  url.searchParams.set('source', 'html');
  return send(url, adminKey, nowSeconds, 'PUT', { posts: [post] });
}

export async function listPosts({ baseUrl, adminKey, nowSeconds, filter }) {
  const url = new URL('/ghost/api/admin/posts/', baseUrl);
  url.searchParams.set('limit', '15');
  if (filter) {
    url.searchParams.set('filter', filter);
  }
  return send(url, adminKey, nowSeconds, 'GET');
}

export async function registerWebhook({ baseUrl, adminKey, nowSeconds, event, targetUrl }) {
  const url = new URL('/ghost/api/admin/webhooks/', baseUrl);
  return send(url, adminKey, nowSeconds, 'POST', {
    webhooks: [{ event, target_url: targetUrl }],
  });
}

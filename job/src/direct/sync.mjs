import { createHash } from 'node:crypto';

// Frozen rule from SEMANTICS.md. This arm does not import the package.

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

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function canonicalTimestamp(value) {
  if (typeof value !== 'string' || value.length === 0) {
    return value ?? null;
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return value;
  }
  return new Date(parsed).toISOString();
}

function withContentHash(record) {
  return {
    ...record,
    content_sha256: sha256(stableStringify({
      title: record.title,
      slug: record.slug,
      html: record.html,
      url: record.url,
      published_at: record.published_at,
    })),
  };
}

function projectPublished(post) {
  return withContentHash({
    ghost_id: post.id,
    updated_at: canonicalTimestamp(post.updated_at),
    status: 'published',
    title: post.title,
    slug: post.slug,
    html: post.html ?? '',
    url: post.url,
    published_at: canonicalTimestamp(post.published_at),
  });
}

function projectWithdrawnFromRow(row) {
  return {
    ghost_id: row.ghost_id,
    updated_at: row.updated_at,
    status: 'withdrawn',
    title: row.title,
    slug: row.slug,
    html: row.html,
    url: row.url,
    published_at: row.published_at,
    content_sha256: row.content_sha256,
  };
}

function effectId(record) {
  return sha256(stableStringify({
    ghost_id: record.ghost_id,
    updated_at: record.updated_at,
    status: record.status,
    title: record.title,
    slug: record.slug,
    html: record.html,
    url: record.url,
    published_at: record.published_at,
    content_sha256: record.content_sha256,
  }));
}

function sameProjection(row, desired) {
  return row.status === desired.status
    && row.updated_at === desired.updated_at
    && row.content_sha256 === desired.content_sha256
    && row.title === desired.title
    && row.slug === desired.slug
    && row.html === desired.html
    && row.url === desired.url
    && row.published_at === desired.published_at;
}

function decide(current, desired) {
  if (!current && desired.status === 'published') {
    return 'apply';
  }
  if (!current) {
    return 'ignored';
  }
  const currentMs = Date.parse(current.updated_at);
  const desiredMs = Date.parse(desired.updated_at);
  if (desiredMs < currentMs) {
    return 'stale';
  }
  if (desiredMs > currentMs) {
    return 'apply';
  }
  const sameContent = current.content_sha256 === desired.content_sha256
    && current.title === desired.title
    && current.slug === desired.slug
    && current.html === desired.html
    && current.url === desired.url
    && current.published_at === desired.published_at;
  if (current.status === desired.status && sameContent) {
    return 'unchanged';
  }
  if (desired.status === 'withdrawn' && current.status === 'published' && sameContent) {
    return 'apply';
  }
  return 'conflict';
}

export function createJournal() {
  const entries = [];
  return {
    record(entry) {
      entries.push({ ...entry });
    },
    entries() {
      return entries.map((entry) => ({ ...entry }));
    },
  };
}

async function putOnce(destination, record, id) {
  try {
    return { ok: true, response: destination.put(record, id) };
  } catch (error) {
    if (error.code === 'NO_COMMIT' || error.code === 'LOST_RESPONSE') {
      return { ok: false, error };
    }
    throw error;
  }
}

export async function deliver(destination, journal, desired) {
  const id = effectId(desired);
  const current = destination.get(desired.ghost_id);
  const decision = decide(current, desired);
  if (decision !== 'apply') {
    journal.record({ effect_id: id, decision, ghost_id: desired.ghost_id });
    return { decision, effect_id: id, ghost_id: desired.ghost_id };
  }
  let attempt = await putOnce(destination, desired, id);
  if (!attempt.ok && attempt.error.code === 'NO_COMMIT') {
    attempt = await putOnce(destination, desired, id);
  }
  if (!attempt.ok && attempt.error.code === 'LOST_RESPONSE') {
    const after = destination.get(desired.ghost_id);
    if (after && after.effect_id === id && sameProjection(after, desired)) {
      journal.record({ effect_id: id, decision: 'recovered', ghost_id: desired.ghost_id });
      return { decision: 'recovered', effect_id: id, ghost_id: desired.ghost_id };
    }
    throw attempt.error;
  }
  if (!attempt.ok) {
    throw attempt.error;
  }
  if (attempt.response.duplicate) {
    journal.record({ effect_id: id, decision: 'recovered', ghost_id: desired.ghost_id });
    return { decision: 'recovered', effect_id: id, ghost_id: desired.ghost_id };
  }
  journal.record({ effect_id: id, decision: 'applied', ghost_id: desired.ghost_id });
  return { decision: 'applied', effect_id: id, ghost_id: desired.ghost_id };
}

export async function syncPublishedPosts(posts, destination, journal) {
  const results = [];
  const seen = new Set();
  for (const post of posts) {
    if (post.status !== 'published' || post.visibility !== 'public') {
      results.push({ decision: 'ignored', ghost_id: post.id });
      continue;
    }
    seen.add(post.id);
    results.push(await deliver(destination, journal, projectPublished(post)));
  }
  for (const row of destination.list()) {
    if (row.status === 'published' && !seen.has(row.ghost_id)) {
      results.push(await deliver(destination, journal, projectWithdrawnFromRow(row)));
    }
  }
  return results;
}

export async function syncFromContentApi({ baseUrl, contentKey, destination, journal, pageSize = 15 }) {
  const posts = [];
  let page = 1;
  for (;;) {
    const url = new URL('/ghost/api/content/posts/', baseUrl);
    url.searchParams.set('key', contentKey);
    url.searchParams.set('formats', 'html');
    url.searchParams.set('limit', String(pageSize));
    url.searchParams.set('page', String(page));
    const response = await fetch(url, { headers: { 'Accept-Version': 'v6.0' } });
    if (!response.ok) {
      throw new Error(`content api status ${response.status}`);
    }
    const body = await response.json();
    posts.push(...body.posts.map((post) => ({ ...post, status: post.status ?? 'published' })));
    const next = body.meta?.pagination?.next;
    if (next == null) {
      break;
    }
    page = next;
  }
  return syncPublishedPosts(posts, destination, journal);
}

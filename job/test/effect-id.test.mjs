import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { harbor } from '../fixtures/posts.mjs';
import { createDestination } from '../src/destination.mjs';
import { createJournal as directJournal, syncPublishedPosts as directSync } from '../src/direct/sync.mjs';
import { createJournal as packageJournal, handleWebhook } from '../src/package/sync.mjs';
import { signedWebhook } from '../src/ghost-fixture.mjs';
import { WEBHOOK_SECRET } from '../fixtures/posts.mjs';

// Independent of both sync modules. SEMANTICS.md defines the bytes.

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

function expectedPublished(post) {
  const content_sha256 = sha256(stableStringify({
    title: post.title,
    slug: post.slug,
    html: post.html,
    url: post.url,
    published_at: post.published_at,
  }));
  const record = {
    ghost_id: post.id,
    updated_at: post.updated_at,
    status: 'published',
    title: post.title,
    slug: post.slug,
    html: post.html,
    url: post.url,
    published_at: post.published_at,
    content_sha256,
  };
  return { record, effect_id: sha256(stableStringify(record)) };
}

test('both arms store the effect id defined in SEMANTICS.md', async () => {
  const expected = expectedPublished(harbor.v1);
  const directDestination = createDestination();
  await directSync([harbor.v1], directDestination, directJournal());
  const packageDestination = createDestination();
  const signed = signedWebhook({
    event: 'post.published',
    current: harbor.v1,
    secret: WEBHOOK_SECRET,
    timestampMs: 1761746400000,
  });
  const response = await handleWebhook({
    rawBody: signed.rawBody,
    signatureHeader: signed.signatureHeader,
    secret: WEBHOOK_SECRET,
    destination: packageDestination,
    journal: packageJournal(),
  });
  assert.equal(response.decision, 'applied');
  assert.equal(response.status, 200);
  const directRow = directDestination.get(harbor.v1.id);
  const packageRow = packageDestination.get(harbor.v1.id);
  assert.equal(directRow.effect_id, expected.effect_id);
  assert.equal(packageRow.effect_id, expected.effect_id);
  assert.equal(directRow.content_sha256, expected.record.content_sha256);
  assert.equal(directDestination.stats().writeCount, 1);
  assert.equal(packageDestination.stats().writeCount, 1);
});

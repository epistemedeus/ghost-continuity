# Frozen output and correction semantics

frozen_at: 2026-10-29T15:05:00Z
status: frozen before implementation
amendments:
- 2026-10-29T15:13:00Z: Acceptance compares a withdrawal on status and content fields, one row, and a repeat that does not write. `updated_at` may differ. Rule 6 keeps the last public clock when a poll no longer sees the post. Rule 4 writes `post.current.updated_at` when that clock is later. No decision rule changed.
- 2026-10-29T20:40:00Z: Useful withdrawal agreement is status, title, slug, html, and published_at. It is not byte equality. Ghost's `post.unpublished` `current.url` is the draft preview `/p/<uuid>/`. The poll keeps the last public URL, and `content_sha256` includes `url`. Installed Ghost 6.73.0 sends webhooks with got 16. That sender did not retry a POST. Duplicate, reorder, and lost-response evidence uses a second target URL, because Ghost rejects the same event and target URL twice. No decision rule changed.

This file is the acceptance contract for this example. Implementation follows it. A later change to a rule below is an amendment with a timestamp, not a silent edit.

## Job

Keep one catalog row per public Ghost post.

- Publisher: the Ghost publication. It owns the post.
- Payer/agency: the party that deploys and accepts the procedure. This laboratory run charges no fee.
- Beneficiary: the catalog that receives the row. The beneficiary is not the publisher.

The row is a public catalog projection. It is not a member, subscriber, newsletter, or payment record.

Ghost's migration service and the built-in importers move content into Ghost. They are a different job. Ghost states that it does not build or maintain third-party integrations. No integration listed on ghost.org/integrations was executed here, and none is treated as having completed this acceptance contract.

## Source of a projection

A published projection is emitted only when `status` is `published` and `visibility` is `public`.

Drafts, email-only posts, `members` visibility, and `paid` visibility do not create a catalog row.

`post.unpublished` projects `status: withdrawn` from `post.current`. The row is kept. A second row is not created. Withdrawal of an id that was never catalogued does not create a row.

`post.previous` is not an input to the write. The current object is the candidate.

Events other than `post.published`, `post.published.edited`, and `post.unpublished` are ignored. The handler returns HTTP 200 so Ghost's retry policy is not fed by an event this job does not accept. The handler never returns HTTP 410. Ghost destroys a webhook on 410.

Malformed JSON returns HTTP 400 and writes nothing. A deployment that sends a bad secret gets HTTP 401 and writes nothing. Ghost may retry those. That retry is Ghost's delivery behavior, not a second catalog row.

## Catalog record

Fields: `ghost_id`, `updated_at`, `status`, `title`, `slug`, `html`, `url`, `published_at`, `content_sha256`.

No author, email, member, or stripe field is stored.

`content_sha256` is the hex SHA-256 of the stable JSON of `{title, slug, html, url, published_at}`. Status is not part of the content hash.

The effect id is the hex SHA-256 of the stable JSON of `{ghost_id, updated_at, status, title, slug, html, url, published_at, content_sha256}`. The transport name (`post.published`, a poll, a retry) is not part of the effect id. The same desired record from a webhook and from a poll is one effect.

Stable JSON sorts object keys and preserves array order.

Timestamps are UTC ISO-8601. Ordering uses `Date.parse`, so the fixtures use a zero-offset `Z` form.

## Decisions

Let `current` be the stored row, or null. Let `desired` be the candidate projection.

1. `current` is null and `desired.status` is `published`: `applied`. One new row. `write_count` increases by one.
2. `current` is null and `desired.status` is `withdrawn`: `ignored`. No row.
3. `desired.updated_at` is earlier than `current.updated_at`: `stale`. No write.
4. `desired.updated_at` is later than `current.updated_at`: `applied`. The same row is replaced. `write_count` increases by one.
5. Timestamps are equal and `status`, `content_sha256`, `title`, `slug`, `html`, `url`, and `published_at` are equal: `unchanged`. No write.
6. Timestamps are equal, `desired.status` is `withdrawn`, `current.status` is `published`, and the content fields are equal: `applied`. This is how a content-API poll records disappearance. The public read does not return the unpublished post, so the poll cannot invent a newer `updated_at`.
7. Timestamps are equal and the projection differs in any other way: `conflict`. No write.

`write_count` counts committed row changes. A repeated effect id does not increase it when the destination honors idempotency. Rows are counted by `ghost_id`. One post keeps one row across publish, correction, and withdrawal.

## Recovery

Interrupted before commit: the destination has not stored the row and the caller sees a transport error. The caller retries the same effect once. The result is `applied` and `write_count` is one.

Lost response after commit: the destination stored the row and the caller did not see success. The caller reads the row. If the effect id and the projection match, the decision is `recovered` and `write_count` does not increase. The caller does not PUT again.

A second delivery of the same desired record is `unchanged` when the row already matches. It is `recovered` when the destination reports that the effect id was already committed and the local decision had still been `apply`.

## Webhook authentication

Ghost v6.73 signs the raw body when the integration secret is non-empty:

`X-Ghost-Signature: sha256=<hex>, t=<milliseconds>`

The HMAC-SHA256 key is the secret string. The message is the raw body bytes concatenated with the decimal millisecond timestamp, with no separator. Verification uses those raw bytes. The receiver does not re-serialize JSON before checking the MAC.

This procedure requires a secret. A missing or invalid signature is `rejected_signature` and HTTP 401.

Ghost put `t` in the hash so a receiver can reject old timestamps. This procedure does not add a clock window. The acceptance cases include a later recovery of a delivery that already happened. Duplicate and stale protection are the effect id and `updated_at`. A deployment that adds a short skew window is adaptation, and that window can drop a legitimate Ghost retry.

## What each arm is responsible for

Direct arm: read published public posts from the Content API, follow `meta.pagination.next` as a page number, apply the rules above, and withdraw stored public rows whose ids are absent. It does not verify a webhook signature because it does not consume webhooks.

Package arm: the same rules, plus a signed webhook ingress for the three post events, plus the same reconcile used when a webhook never arrived.

Service arm: the package, the deployment manifest, and one acceptance command. It is not a third synchronizer and it is not a support subscription.

A missed webhook leaves the package idle until reconcile runs. The direct poll still converges. That is a native win on this case. The service procedure includes reconcile because of that case. The procedure does not claim the customer prefers push, and the fixtures do not prove willingness to pay.

Withdrawal is not byte-identical across transports. A poll that no longer sees a public post applies rule 6 and keeps the stored `updated_at`. A `post.unpublished` event applies rule 4 when `post.current.updated_at` is later. Acceptance checks status, content fields, one row, and a repeated event that does not write. It does not require the two clocks to be equal.

## Deployment-specific adaptation

These stay outside the frozen rule: Ghost content URL, admin URL, content key, webhook secret, customer endpoint URL, TLS, allowlists, and an optional extra tag filter. Renaming catalog fields, adding author names, or syncing members would be a different effect definition.

## Money

No price, credit, or bank balance is an input to these rules.

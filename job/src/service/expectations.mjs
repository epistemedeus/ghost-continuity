import { HARBOR_ID, SLIP_ID } from '../../fixtures/posts.mjs';

function row(snapshot, id) {
  return snapshot.rows.find((item) => item.ghost_id === id) ?? null;
}

function writes(arm) {
  return arm.snapshot.stats.writeCount;
}

export function evaluate(report) {
  const byId = Object.fromEntries(report.cases.map((item) => [item.id, item]));
  const failures = [];
  const expect = (condition, message) => {
    if (!condition) {
      failures.push(message);
    }
  };

  const first = byId.first_delivery;
  expect(first.direct.decision === 'applied' && first.package.decision === 'applied', 'first delivery applies once on both arms');
  expect(writes(first.direct) === 1 && writes(first.package) === 1, 'first delivery writes once');
  expect(first.direct.snapshot.rows.length === 1 && first.package.snapshot.rows.length === 1, 'first delivery keeps one row');
  expect(row(first.direct.snapshot, HARBOR_ID).html === '<p>First synthetic public note.</p>', 'direct stores the public html');
  expect(JSON.stringify(first.direct.snapshot.rows) === JSON.stringify(first.package.snapshot.rows), 'first delivery rows match');
  expect(!('email' in row(first.direct.snapshot, HARBOR_ID)), 'catalog row has no email field');

  const same = byId.no_change;
  expect(same.direct.decision === 'unchanged' && same.package.decision === 'unchanged', 'no-change does not apply');
  expect(writes(same.direct) === 1 && writes(same.package) === 1, 'no-change keeps the original write');

  const corrected = byId.corrected_source;
  expect(corrected.direct.decision === 'applied' && corrected.package.decision === 'applied', 'correction applies');
  expect(writes(corrected.direct) === 2 && writes(corrected.package) === 2, 'correction is a second write on the same row');
  expect(corrected.direct.snapshot.rows.length === 1 && corrected.package.snapshot.rows.length === 1, 'correction does not add a row');
  expect(row(corrected.direct.snapshot, HARBOR_ID).title === 'Harbor light, corrected', 'correction replaces the title');
  expect(JSON.stringify(corrected.direct.snapshot.rows) === JSON.stringify(corrected.package.snapshot.rows), 'correction rows match');

  const repeated = byId.repeated_event;
  expect(repeated.direct.decision === 'unchanged' && repeated.package.decision === 'unchanged', 'repeated event does not apply');
  expect(writes(repeated.direct) === 1 && writes(repeated.package) === 1, 'repeated event keeps one write');
  expect(repeated.direct.snapshot.rows.length === 1 && repeated.package.snapshot.rows.length === 1, 'repeated event keeps one row');

  const lost = byId.lost_response;
  expect(lost.direct.decision === 'recovered' && lost.package.decision === 'recovered', 'lost response recovers from the committed row');
  expect(writes(lost.direct) === 1 && writes(lost.package) === 1, 'lost response does not write twice');
  expect(lost.direct.snapshot.stats.putCount === 1 && lost.package.snapshot.stats.putCount === 1, 'lost response does not PUT again');

  const interrupted = byId.interrupted_before_commit;
  expect(interrupted.direct.decision === 'applied' && interrupted.package.decision === 'applied', 'retry after a pre-commit failure applies');
  expect(writes(interrupted.direct) === 1 && writes(interrupted.package) === 1, 'pre-commit retry writes once');
  expect(interrupted.direct.snapshot.stats.putCount === 2 && interrupted.package.snapshot.stats.putCount === 2, 'pre-commit failure is one failed attempt and one commit');

  const stale = byId.stale_event;
  expect(stale.direct.decision === 'stale' && stale.package.decision === 'stale', 'older event is stale');
  expect(writes(stale.direct) === 1 && writes(stale.package) === 1, 'stale event does not write');
  expect(row(stale.direct.snapshot, HARBOR_ID).updated_at === '2026-10-29T13:00:00.000Z', 'stale event leaves the newer row');
  expect(JSON.stringify(stale.direct.snapshot.rows) === JSON.stringify(stale.package.snapshot.rows), 'stale rows match');

  const conflict = byId.conflict_event;
  expect(conflict.direct.decision === 'conflict' && conflict.package.decision === 'conflict', 'same clock and different html conflicts');
  expect(writes(conflict.direct) === 1 && writes(conflict.package) === 1, 'conflict does not write');
  expect(row(conflict.direct.snapshot, HARBOR_ID).html === '<p>Corrected synthetic public note.</p>', 'conflict leaves the stored html');

  const withdrawn = byId.unpublish;
  expect(withdrawn.direct.decision === 'applied' && withdrawn.package.decision === 'applied', 'unpublish updates the existing row');
  expect(withdrawn.direct.repeat === 'unchanged' && withdrawn.package.repeat === 'unchanged', 'repeated unpublish does not write');
  expect(withdrawn.direct.snapshot.rows.length === 2 && withdrawn.package.snapshot.rows.length === 2, 'unpublish keeps one row per post');
  expect(row(withdrawn.direct.snapshot, HARBOR_ID).status === 'withdrawn', 'harbor is withdrawn');
  expect(row(withdrawn.direct.snapshot, SLIP_ID).status === 'published', 'the other post stays published');
  expect(withdrawn.direct.snapshot.stats.writeCount === 3 && withdrawn.package.snapshot.stats.writeCount === 3, 'two publishes and one withdrawal');
  const harborDirect = row(withdrawn.direct.snapshot, HARBOR_ID);
  const harborPackage = row(withdrawn.package.snapshot, HARBOR_ID);
  expect(harborDirect.updated_at === '2026-10-29T13:00:00.000Z', 'poll withdrawal keeps the last public clock');
  expect(harborPackage.updated_at === '2026-10-29T14:00:00.000Z', 'webhook withdrawal writes post.current.updated_at');
  for (const key of ['ghost_id', 'status', 'title', 'slug', 'html', 'url', 'published_at', 'content_sha256']) {
    expect(harborDirect[key] === harborPackage[key], `unpublish ${key} matches`);
  }
  expect(JSON.stringify(row(withdrawn.direct.snapshot, SLIP_ID)) === JSON.stringify(row(withdrawn.package.snapshot, SLIP_ID)), 'the post that stayed published matches');

  const scope = byId.out_of_scope_events;
  expect(scope.direct.snapshot.rows.length === 1, 'members-only post is not in the content projection');
  expect(scope.package.members_post === 'ignored', 'members-only webhook is ignored');
  expect(scope.package.member_event === 'ignored_event' && scope.package.member_status === 200, 'member.added is ignored with HTTP 200');
  expect(scope.package.snapshot.rows.length === 0, 'ignored events create no catalog row');
  expect(scope.package.member_status !== 410, 'the handler does not return 410');

  const missed = byId.missed_webhook;
  expect(missed.direct.snapshot.stats.writeCount === 1, 'direct poll converges without a webhook');
  expect(missed.package_webhook_only.snapshot.stats.writeCount === 0, 'webhook-only package stays idle when no event arrives');
  expect(missed.package_reconcile.snapshot.stats.writeCount === 1, 'package reconcile converges the same way as the poll');
  expect(JSON.stringify(missed.direct.snapshot.rows) === JSON.stringify(missed.package_reconcile.snapshot.rows), 'reconcile matches the direct poll');
  expect(missed.native_sufficient === true, 'missed webhook records the native poll as sufficient');

  const pages = byId.content_api_pagination;
  expect(pages.content_version === 'v6.73', 'fixture answers with Ghost 6.73 content version');
  expect(pages.content_ids.includes(HARBOR_ID) && pages.content_ids.includes(SLIP_ID), 'content API returns both public posts');
  expect(!pages.content_ids.includes('64102aaa0000000000000003'), 'content API hides the members-only post');
  expect(pages.direct.snapshot.rows.length === 2 && pages.package.snapshot.rows.length === 2, 'page size 1 still syncs both public posts');
  expect(JSON.stringify(pages.direct.snapshot.rows) === JSON.stringify(pages.package.snapshot.rows), 'paged sync rows match');

  const signature = byId.rejected_signature;
  expect(signature.package.decision === 'rejected_signature' && signature.package.status === 401, 'bad signature is HTTP 401');
  expect(signature.package.snapshot.stats.writeCount === 0, 'bad signature writes nothing');

  return { ok: failures.length === 0, failures };
}

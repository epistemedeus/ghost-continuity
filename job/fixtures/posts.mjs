export const HARBOR_ID = '64102aaa0000000000000001';
export const SLIP_ID = '64102aaa0000000000000002';
export const MEMBERS_ID = '64102aaa0000000000000003';

export const CONTENT_KEY = 'synthetic-content-key-gc-sample';
export const WEBHOOK_SECRET = 'synthetic-webhook-secret-gc-sample';
export const ADMIN_KEY = `641020000000000000000001:${'ab'.repeat(32)}`;

const harborBase = {
  id: HARBOR_ID,
  uuid: '00000000-0000-4000-8000-000000006410',
  slug: 'harbor-light',
  feature_image: null,
  featured: false,
  custom_excerpt: null,
  email_only: false,
  visibility: 'public',
  created_at: '2026-10-29T12:00:00.000Z',
  published_at: '2026-10-29T12:00:00.000Z',
  url: 'http://synthetic.ghost.local/harbor-light/',
};

export const harbor = {
  v1: {
    ...harborBase,
    title: 'Harbor light',
    html: '<p>First synthetic public note.</p>',
    status: 'published',
    updated_at: '2026-10-29T12:00:00.000Z',
  },
  v2: {
    ...harborBase,
    title: 'Harbor light, corrected',
    html: '<p>Corrected synthetic public note.</p>',
    status: 'published',
    updated_at: '2026-10-29T13:00:00.000Z',
  },
  conflict: {
    ...harborBase,
    title: 'Harbor light, corrected',
    html: '<p>Conflicting body at the same clock.</p>',
    status: 'published',
    updated_at: '2026-10-29T13:00:00.000Z',
  },
  unpublished: {
    ...harborBase,
    title: 'Harbor light, corrected',
    html: '<p>Corrected synthetic public note.</p>',
    status: 'draft',
    updated_at: '2026-10-29T14:00:00.000Z',
  },
};

export const slip = {
  id: SLIP_ID,
  uuid: '00000000-0000-4000-8000-000000006411',
  slug: 'second-slip',
  title: 'Second slip',
  html: '<p>Second synthetic public note.</p>',
  status: 'published',
  visibility: 'public',
  email_only: false,
  featured: false,
  feature_image: null,
  custom_excerpt: null,
  created_at: '2026-10-29T12:05:00.000Z',
  updated_at: '2026-10-29T12:05:00.000Z',
  published_at: '2026-10-29T12:05:00.000Z',
  url: 'http://synthetic.ghost.local/second-slip/',
};

export const membersOnly = {
  id: MEMBERS_ID,
  uuid: '00000000-0000-4000-8000-000000006412',
  slug: 'members-desk',
  title: 'Members desk',
  html: '<p>Not a public catalog row.</p>',
  status: 'published',
  visibility: 'members',
  email_only: false,
  featured: false,
  feature_image: null,
  custom_excerpt: null,
  created_at: '2026-10-29T12:10:00.000Z',
  updated_at: '2026-10-29T12:10:00.000Z',
  published_at: '2026-10-29T12:10:00.000Z',
  url: 'http://synthetic.ghost.local/members-desk/',
};

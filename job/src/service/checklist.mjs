export const CHECKLIST = [
  {
    id: 'secrets',
    text: 'Put the content API key and webhook secret in the client secret store. Do not commit them.',
  },
  {
    id: 'ghost_urls',
    text: 'Point the manifest content and admin URLs at the client staging Ghost.',
  },
  {
    id: 'customer_url',
    text: 'Point customer_record_url at the staging endpoint that stores one row per ghost_id and treats a repeated effect id as a no-op.',
  },
  {
    id: 'webhooks',
    text: 'Register a custom integration webhook for post.published, post.published.edited, and post.unpublished only.',
  },
  {
    id: 'accept',
    text: 'Run node bin/accept.mjs. The six required decisions and the recovery cases must pass.',
  },
  {
    id: 'reconcile',
    text: 'Keep the content-API reconcile in the run. A missed webhook does not update the catalog until reconcile runs.',
  },
  {
    id: 'adapt',
    text: 'Change only manifest ADAPT fields. Do not change the effect id or the stale rule.',
  },
  {
    id: 'stop',
    text: 'Stop when the report passes. Do not publish a post, import members, or open a listing.',
  },
];

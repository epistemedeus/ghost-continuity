# Ghost catalog continuity 0.1.0

One public Ghost post keeps one catalog row. A correction replaces that row. Unpublishing marks the row withdrawn and keeps it. A repeated event does not add a row. An older event does not overwrite a newer row. The same clock with different content does not write.

Reference integration tested with Ghost 6.73.0 synthetic posts. The offline commands below are the acceptance command. They use fixtures and a protocol stub. They do not start Ghost.

Supported versions: Node.js 22, Ghost 6.73.0 (commit `5794cfd8daca61fd60cd8659acd6591ece3b7956`). The decision contract is `job/SEMANTICS.md`. The machine pin is `job/contract/ghost-v6.73.json`.

## Offline acceptance

From this directory:

```bash
node --test job/test/behavior.test.mjs job/test/effect-id.test.mjs
node job/bin/demo.mjs
node job/bin/accept.mjs
node job/bin/compare.mjs --out /tmp/gc-sample-compare
node --test harness/interface.test.mjs
node harness/run-journeys.mjs --plane stub --out /tmp/gc-sample-stub
```

The job tests report 7 tests. `job/bin/demo.mjs` reports 13 cases and 8 deployment steps. `job/bin/compare.mjs` writes `comparison.json` only in the directory you pass, and it exits 2 when `--out` is missing. The stub report schema is `ghost-continuity.http-journey.v1`, plane `protocol-stub`, `installed_execution` false.

`job/bin/compare.mjs` keeps the direct Content API poll beside the signed-webhook package. On a missed webhook the poll still converges and the webhook-only path stays empty until reconcile runs. That is the useful win for direct polling. The package does not replace the poll.

## Configuration

`job/deploy/client-manifest.example.json` lists the fields a deployment changes. Content URL, admin URL, content key, webhook secret, and the catalog endpoint are deployment values. Do not commit them. The fixture keys in `harness/identities.mjs` are synthetic.

Events are `post.published`, `post.published.edited`, and `post.unpublished`. The receiver checks the Ghost HMAC over the raw body concatenated with the decimal millisecond timestamp. It does not return HTTP 410.

Public posts are catalogued only when `status` is `published` and `visibility` is `public`. Members, paid, and email-only posts are ignored.

## Installed loopback

The installed plane talks to a Ghost you already run. It does not install Ghost, start Ghost, or open a public site.

```bash
export GHOST_CONTINUITY_STAGE=installed
export GHOST_CONTINUITY_ADMIT=1
export GHOST_BASE_URL=http://127.0.0.1:2368
export GHOST_STAFF_EMAIL=...
export GHOST_STAFF_PASSWORD=...
export GHOST_WEBHOOK_SECRET=...
node harness/run-journeys.mjs --plane installed --out /tmp/gc-sample-installed
```

`GHOST_BASE_URL` must be loopback `http` or `https` (`127.0.0.1`, `localhost`, or `::1`). Otherwise the process exits 3 before any request. The same exit happens when the admission variables or the staff and webhook values are missing.

The runner creates a custom integration named `GC sample catalog` and posts whose slugs start with `gc-sample-`. It deletes that integration and those slugs at the end. It does not select any other slug prefix.

`bash install/native-install.sh` prints the ghost-cli local development command for directory `/tmp/ghost-continuity-sample` and SQLite `content/data/ghost-dev.db`. It exits 3 without admission, when that directory already exists, or when `GHOST_CONTINUITY_GHOST_BIN` is missing. `bash install/clean-install.sh` prints the pinned `linux/amd64` image `ghost@sha256:3656324ad804308b9ef39571b15b41465cdee64f6a78d1807719b5ea379688fd` and exits 3 without admission. Acceptance of this example does not run either installer.

## What the installed run showed

Useful withdrawal agreement is status, title, slug, HTML, and published time. It is not byte equality. Ghost's `post.unpublished` `current.url` is the draft preview `/p/<uuid>/`. The poll keeps the last public slug URL, and `content_sha256` includes `url`, so the hashes differ. Clocks need not match.

Installed Ghost 6.73.0 sent webhooks with got 16. That sender did not retry a failed POST. Do not treat a retry limit in Ghost's source as observed delivery. Duplicate, reordered, and lost-response cases used a second subscription, because Ghost rejects the same event and target URL twice.

A separate receiver process reloaded the stored row after a lost response and did not write it again.

## Archive

`MANIFEST.json` lists every other file in this archive with its byte length and SHA-256. `COLD-INSTALL.txt` is the short acceptance command. `SOURCE-NOTICE.txt` and `LICENSES.md` are the redistribution notes.

After release, the byte pin is the archive at `/downloads/ghost-continuity/0.1.0/ghost-continuity-0.1.0.tar.gz` and the descriptor at `/machine/ghost-continuity-0.1.0.json`. Those URLs are the public paths. This tree does not claim the files are already hosted.

# Catalog job

This directory is the executable catalog procedure. `SEMANTICS.md` is the decision contract. `contract/ghost-v6.73.json` is the Ghost 6.73.0 pin. `deploy/client-manifest.example.json` is the example configuration. Replace its hosts and supply secrets from the environment. Do not commit a content key, webhook secret, or admin key.

From this directory:

```bash
node --test test/behavior.test.mjs test/effect-id.test.mjs
node bin/demo.mjs
node bin/accept.mjs
node bin/compare.mjs --out /tmp/gc-sample-compare
```

`bin/compare.mjs` runs the same cases through the direct Content API poll and through the signed-webhook package. The poll is the path that still writes when a webhook is missed. The package adds signature checks, the three post events, and reconcile. It does not retire the poll.

The parent `README.md` covers the protocol stub, the loopback installed plane, and the public archive.

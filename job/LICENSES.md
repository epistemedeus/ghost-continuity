# Pinned sources and licences

This specimen vendors no third-party package. Node.js 22.23.4 is the runtime. Its standard library (`node:crypto`, `node:http`, `node:test`, `fetch`) performs the HTTP and HMAC work.

| Source | Pin | Licence | How it is used |
| --- | --- | --- | --- |
| Ghost | tag v6.73.0, commit `5794cfd8daca61fd60cd8659acd6591ece3b7956` | MIT, Copyright (c) 2013-2026 Ghost Foundation | Contract only. Webhook HMAC, payload shape, Content API pagination, and Admin API JWT claims were read from the published docs and that tag. Ghost source is not copied into this tree. |
| `@tryghost/admin-api` | npm 1.14.14, repository `git+https://github.com/TryGhost/SDK.git` | MIT | Considered and not installed. The documented requests are short enough to send directly. |

The synthetic posts, role names, and destination rows in `fixtures/` were written for this laboratory. They are not Ghost's welcome post and they are not a customer record.

`contract/ghost-v6.73.json` is the machine-readable pin.

import { createServer } from 'node:http';
import { createJournal, handleWebhook } from '../job/src/package/sync.mjs';
import { verifyWebhook } from '../job/src/signature.mjs';
import { createStore } from './store.mjs';

async function readRaw(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
}

// HTTP ingress for a Ghost webhook POST. The signature is checked against the
// raw body bytes. Re-serializing JSON before the check is a failed delivery.
export async function startReceiver({ secret, secrets, store, journal, port = 0 }) {
  const httpLog = [];
  const secretList = secrets ?? [secret];
  const state = { store, journal, restarted: false };
  let active = null;
  let dropNextResponse = false;
  let statusOnce = null;
  let holdNext = false;
  let held = null;
  let holdNotify = null;
  let restartNext = false;

  function matchedSecret(rawBody, signatureHeader) {
    for (const candidate of secretList) {
      if (verifyWebhook({ rawBody, signatureHeader, secret: candidate }).ok) {
        return candidate;
      }
    }
    return secretList[0];
  }

  async function accept(rawBody, signatureHeader) {
    return handleWebhook({
      rawBody,
      signatureHeader,
      secret: matchedSecret(rawBody, signatureHeader),
      destination: state.store,
      journal: state.journal,
    });
  }

  async function onRequest(request, response) {
    const started = Date.now();
    const rawBody = await readRaw(request);
    const signatureHeader = request.headers['x-ghost-signature'];
    const entry = {
      direction: 'inbound-webhook',
      method: request.method,
      path: new URL(request.url, 'http://127.0.0.1').pathname,
      contentVersion: request.headers['content-version'] ?? null,
      contentType: request.headers['content-type'] ?? null,
      bytes: Buffer.byteLength(rawBody),
      signaturePresent: Boolean(signatureHeader),
    };
    if (request.method !== 'POST' || (entry.path !== '/hooks' && entry.path !== '/hooks-replay')) {
      entry.status = 404;
      entry.ms = Date.now() - started;
      httpLog.push(entry);
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ errors: [{ message: 'Unknown route' }] }));
      return;
    }
    const header = typeof signatureHeader === 'string' ? signatureHeader : '';
    if (holdNext) {
      holdNext = false;
      held = { rawBody, header, response, entry, started };
      if (holdNotify) {
        holdNotify();
        holdNotify = null;
      }
      return;
    }
    const result = await accept(rawBody, header);
    entry.status = result.status;
    entry.decision = result.decision;
    entry.ghost_id = result.ghost_id ?? null;
    entry.ms = Date.now() - started;
    if (statusOnce) {
      entry.status = statusOnce;
      entry.forcedStatus = statusOnce;
      statusOnce = null;
      httpLog.push(entry);
      response.writeHead(entry.status, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ decision: result.decision, ghost_id: result.ghost_id ?? null }));
      return;
    }
    if (dropNextResponse) {
      dropNextResponse = false;
      entry.lostResponse = true;
      httpLog.push(entry);
      request.socket.destroy();
      return;
    }
    if (restartNext) {
      restartNext = false;
      entry.restarted = true;
      httpLog.push(entry);
      const saved = state.store.snapshot();
      state.store = createStore();
      state.store.load(saved);
      state.journal = createJournal();
      state.restarted = true;
      // Ghost 6.73 sends the next same-event webhook only after this request
      // settles, and got 16 does not retry POST. Keep the port open, then drop
      // the socket so that next real POST hits the reloaded store.
      request.socket.destroy();
      return;
    }
    httpLog.push(entry);
    response.writeHead(result.status, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ decision: result.decision, ghost_id: result.ghost_id ?? null }));
  }

  active = createServer(onRequest);
  await listen(active, port);
  const address = active.address();
  const boundPort = address.port;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    httpLog,
    get store() {
      return state.store;
    },
    get journal() {
      return state.journal;
    },
    get restarted() {
      return state.restarted;
    },
    armDropNextResponse() {
      dropNextResponse = true;
    },
    armStatusOnce(status) {
      statusOnce = status;
    },
    armHoldNext() {
      holdNext = true;
      return new Promise((resolve) => {
        holdNotify = resolve;
      });
    },
    async releaseHold() {
      const item = held;
      held = null;
      if (!item) {
        return null;
      }
      const result = await accept(item.rawBody, item.header);
      item.entry.status = result.status;
      item.entry.decision = result.decision;
      item.entry.ghost_id = result.ghost_id ?? null;
      item.entry.ms = Date.now() - item.started;
      item.entry.held = true;
      httpLog.push(item.entry);
      if (item.response.socket && !item.response.socket.destroyed && !item.response.writableEnded) {
        item.response.writeHead(result.status, { 'content-type': 'application/json' });
        item.response.end(JSON.stringify({ decision: result.decision, ghost_id: result.ghost_id ?? null }));
      } else {
        item.entry.heldAborted = true;
      }
      return result;
    },
    armRestartNext() {
      restartNext = true;
    },
    async reopen() {
      if (active.listening) {
        return;
      }
      active = createServer(onRequest);
      await listen(active, boundPort);
    },
    async close() {
      if (!active.listening) {
        return;
      }
      await new Promise((resolve) => {
        active.close(() => resolve());
        if (typeof active.closeAllConnections === 'function') {
          active.closeAllConnections();
        }
      });
    },
  };
}

import { createServer } from 'node:http';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createJournal, handleWebhook } from '../job/src/package/sync.mjs';
import { createStore } from './store.mjs';

const port = Number(process.env.GC_WORKER_PORT);
const storePath = process.env.GC_WORKER_STORE;
const secret = process.env.GC_WORKER_SECRET;
const readyPath = process.env.GC_WORKER_READY;
const releasePath = process.env.GC_WORKER_RELEASE || '';
const resultPath = process.env.GC_WORKER_RESULT || '';

if (!Number.isInteger(port) || port < 0 || !storePath || !secret || !readyPath) {
  process.stderr.write('receiver worker needs a port, store, secret, and ready path\n');
  process.exit(2);
}

const store = createStore();
if (existsSync(storePath)) {
  store.load(JSON.parse(readFileSync(storePath, 'utf8')));
}
const journal = createJournal();
const loaded = store.stats();

function persist() {
  const temporary = `${storePath}.tmp`;
  writeFileSync(temporary, JSON.stringify(store.snapshot()));
  renameSync(temporary, storePath);
}

function readRaw(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

const server = createServer(async (request, response) => {
  const rawBody = await readRaw(request);
  const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
  if (request.method !== 'POST' || pathname !== '/hooks') {
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end('{"errors":[{"message":"Unknown route"}]}');
    return;
  }
  const header = request.headers['x-ghost-signature'];
  const result = await handleWebhook({
    rawBody,
    signatureHeader: typeof header === 'string' ? header : '',
    secret,
    destination: store,
    journal,
  });
  persist();
  const record = {
    pid: process.pid,
    decision: result.decision ?? null,
    ghost_id: result.ghost_id ?? null,
    status: result.status,
    row: store.get(result.ghost_id),
    writeCount: store.stats().writeCount,
    rows: store.stats().rows,
  };
  if (resultPath) {
    writeFileSync(resultPath, JSON.stringify(record));
  }
  if (releasePath) {
    const started = Date.now();
    while (!existsSync(releasePath)) {
      if (Date.now() - started > 15000) {
        process.exit(3);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    request.socket.destroy();
    process.exit(0);
  }
  response.writeHead(result.status, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ decision: result.decision ?? null }));
});

server.listen(port, '127.0.0.1', () => {
  const bound = server.address().port;
  writeFileSync(readyPath, JSON.stringify({
    pid: process.pid,
    port: bound,
    writeCount: loaded.writeCount,
    rows: loaded.rows,
  }));
});

import { createServer, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ChatSession } from './session.js';
import { emptyDatabase, projectDatabase, selectRun } from './store.js';

const defaultRun = process.env.RUN_ID ?? '';
const port = Number(process.env.CHAT_PORT ?? 4173);
const validRun = (id: string) => !id || /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id);
if (!validRun(defaultRun) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid RUN_ID or CHAT_PORT');
const session = new ChatSession({ host: process.env.SPACETIMEDB_HOST ?? 'ws://localhost:3000',
  database: process.env.SPACETIMEDB_DB_NAME ?? 'quant-swarm',
  tokenFile: process.env.CHAT_TOKEN_FILE ?? join(homedir(), '.local/share/quant-swarm/tokens/chat-viewer.token') });
let database = emptyDatabase();
type Client = { response: ServerResponse; requestedRun: string; runId: string; generation: number; sent: Set<string> };
const clients = new Set<Client>();
function send(client: Client, event: string, data: unknown): void {
  client.response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  if (client.response.writableLength > 8_000_000) { clients.delete(client); client.response.destroy(); }
}
function updateClient(client: Client): void {
  const { messages, ...state } = selectRun(database, client.requestedRun, session.ready);
  if (!client.requestedRun && state.runId) client.requestedRun = state.runId;
  if (client.generation !== session.generation || client.runId !== state.runId) {
    client.runId = state.runId; client.generation = session.generation;
    send(client, 'snapshot', { ...state, messages: messages.slice(-500) });
  } else {
    send(client, 'state', state);
    const added = messages.filter(m => !client.sent.has(m.id));
    if (added.length) send(client, 'messages', added);
  }
  client.sent = new Set(messages.map(m => m.id));
}
let pending: NodeJS.Timeout | undefined;
session.onChange(() => {
  if (!pending) pending = setTimeout(() => {
    pending = undefined;
    if (session.ready && session.connection) database = projectDatabase(session.connection);
    for (const client of clients) updateClient(client);
  }, 100);
});
const assets = new Map([
  ['/', { type: 'text/html; charset=utf-8', body: readFileSync('web/chat/index.html') }],
  ['/app.js', { type: 'text/javascript; charset=utf-8', body: readFileSync('web/chat/app.js') }],
  ['/style.css', { type: 'text/css; charset=utf-8', body: readFileSync('web/chat/style.css') }],
]);
const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
  const requestedRun = url.searchParams.get('run') ?? defaultRun;
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
  if (request.method !== 'GET') { response.writeHead(405); response.end('Read-only viewer'); return; }
  if (!validRun(requestedRun)) { response.writeHead(400); response.end('Invalid run ID'); return; }
  const asset = assets.get(url.pathname);
  if (asset) { response.writeHead(200, { 'Content-Type': asset.type }); response.end(asset.body); return; }
  if (url.pathname === '/events') {
    response.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const client: Client = { response, requestedRun, runId: '', generation: -1, sent: new Set() };
    clients.add(client); updateClient(client);
    request.on('close', () => clients.delete(client)); return;
  }
  const selected = selectRun(database, requestedRun, session.ready);
  if (url.pathname === '/api/export') {
    response.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Content-Disposition': `attachment; filename="${selected.runId || 'chat'}-history.jsonl"` });
    response.end(selected.messages.map(m => JSON.stringify(m)).join('\n') + (selected.messages.length ? '\n' : '')); return;
  }
  if (url.pathname === '/api/history') {
    const before = url.searchParams.get('before');
    const end = before ? selected.messages.findIndex(m => m.id === before) : selected.messages.length;
    if (end < 0) { response.writeHead(404); response.end('Message cursor not found'); return; }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ runId: selected.runId, messages: selected.messages.slice(Math.max(0, end - 500), end), hasMore: end > 500 })); return;
  }
  if (url.pathname === '/api/snapshot') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ ...selected, messages: selected.messages.slice(-500) })); return;
  }
  response.writeHead(404); response.end('Not found');
});
const heartbeat = setInterval(() => { for (const client of clients) updateClient(client); }, 10_000);
session.start();
server.listen(port, '127.0.0.1', () => console.log(`Agent chat: http://127.0.0.1:${port}`));
function stop(): void {
  clearInterval(heartbeat); if (pending) clearTimeout(pending);
  session.stop(); if (pending) clearTimeout(pending);
  for (const client of clients) client.response.end(); server.close();
}
process.on('SIGINT', stop); process.on('SIGTERM', stop);
server.on('error', error => { console.error(error.message); stop(); process.exitCode = 1; });

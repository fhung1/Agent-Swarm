import { DbConnection } from './coord_bindings/index.js';
import type { DevTask } from './coord_bindings/types.js';
import { dashboardConfig, dashboardTokenKey } from './config.js';

const root = document.querySelector<HTMLElement>('#app')!;
const { host: HOST, database: DATABASE } = dashboardConfig('quant-swarm-coord');
const TOKEN_KEY = dashboardTokenKey('development', HOST, DATABASE);
const NAME_KEY = 'quant-swarm:development:name';
let connection: DbConnection | undefined;
let ready = false;
let state = 'Connecting to development backend…';
let filter = 'active';
let selectedTask = '';
let generation = 0;
let retry = 0;
let timer: number | undefined;
let queued = false;
let sessionName = stored(NAME_KEY) ?? '';
let sessionToken = stored(TOKEN_KEY);
let recoveredToken = false;
let draftBody = '';
let draftRecipient = '';
let draftTask = '';
let sending = false;
let actionPending = false;
let error = '';

function stored(key: string): string | undefined {
  try { return localStorage.getItem(key) ?? undefined; } catch { return undefined; }
}
function save(key: string, value: string): void { try { localStorage.setItem(key, value); } catch { /* Session still works. */ } }
function node<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = text;
  return element;
}
function put(parent: Node, ...children: Array<Node | string>): void {
  for (const child of children) parent.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
}
function panel(title: string, subtitle: string): HTMLElement {
  const section = node('section', 'panel');
  const head = node('div', 'panel-head');
  put(head, node('h2', '', title), node('span', 'muted small', subtitle));
  put(section, head);
  return section;
}
function field(label: string, value: string): HTMLElement {
  const row = node('div', 'field');
  put(row, node('span', 'field-label', label), node('span', 'field-value', value || '—'));
  return row;
}
function pill(text: string): HTMLElement { return node('span', `pill ${text}`, text); }
function when(value: { toDate(): Date }): string { return value.toDate().toLocaleString(); }
function millis(value: { toDate(): Date }): number { return value.toDate().getTime(); }
function queueRender(): void {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    const active = document.activeElement;
    const editing = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement;
    const label = editing ? active.dataset.field : undefined;
    const selection = editing ? [active.selectionStart, active.selectionEnd] : undefined;
    render();
    if (label) {
      const control = Array.from(root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('[data-field]'))
        .find(element => element.dataset.field === label);
      control?.focus({ preventScroll: true });
      if (control && selection) control.setSelectionRange(selection[0], selection[1]);
    }
  });
}
function empty(section: HTMLElement, text: string): void { put(section, node('p', 'empty', text)); }
function button(label: string, callback: () => void, primary = false): HTMLButtonElement {
  const result = node('button', primary ? 'primary-button' : 'ghost-button', label);
  result.type = 'button';
  result.addEventListener('click', callback);
  return result;
}
function input(label: string, value: string, update: (value: string) => void, multiline = false): HTMLElement {
  const wrapper = node('label', 'board-input');
  const control = multiline ? node('textarea') : node('input');
  control.dataset.field = label;
  control.value = value;
  control.addEventListener('input', () => update(control.value));
  put(wrapper, node('span', 'muted small', label), control);
  return wrapper;
}
async function asSession(conn: DbConnection): Promise<string> {
  const name = sessionName.trim();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name)) throw new Error('Choose a lowercase session name (letters, numbers, dot, dash or underscore).');
  save(NAME_KEY, name);
  if (!conn.db.session.name.find(name)) await conn.reducers.register({ name, tool: 'human', focus: 'Development dashboard' });
  return name;
}
async function taskAction(conn: DbConnection, task: DevTask, status: string): Promise<void> {
  if (actionPending) return;
  actionPending = true;
  error = '';
  queueRender();
  try {
    const name = await asSession(conn);
    if (status === 'claim') await conn.reducers.claimTask({ name, id: task.id });
    else {
      const result = window.prompt(status === 'blocked' ? 'Why is this task blocked?' : 'Result or note:', '') ?? undefined;
      if (result === undefined) return;
      await conn.reducers.updateTask({ name, id: task.id, status, result });
    }
  } catch (reason) { error = String(reason); }
  finally { actionPending = false; queueRender(); }
}
function render(): void {
  if (!ready || !connection) {
    const gate = node('div', 'gate');
    put(gate, node('div', 'brand-mark', 'QS'), node('p', 'eyebrow', 'DEVELOPMENT · LOCAL COORDINATION'),
      node('h1', '', 'Quant Swarm'), node('p', 'lead', state));
    root.replaceChildren(gate);
    return;
  }
  const conn = connection;
  const tasks = [...conn.db.devTask.iter()].sort((a, b) => millis(b.updatedAt) - millis(a.updatedAt));
  const sessions = [...conn.db.session.iter()].sort((a, b) => millis(b.lastSeen) - millis(a.lastSeen));
  const messages = [...conn.db.devMessage.iter()].sort((a, b) => a.id > b.id ? -1 : a.id < b.id ? 1 : 0);
  const locks = [...conn.db.fileLock.iter()].filter(lock => millis(lock.expiresAt) > Date.now()).sort((a, b) => a.path.localeCompare(b.path));
  const shownTasks = tasks.filter(task => filter === 'all' || (filter === 'active' ? ['open', 'claimed', 'blocked'].includes(task.status) : task.status === filter));
  const layout = node('div', 'layout');
  const sidebar = node('aside', 'sidebar');
  const brand = node('div', 'side-brand');
  put(brand, node('div', 'brand-mark', 'QS'), 'QUANT SWARM');
  put(sidebar, brand, node('div', 'side-label', 'DEVELOPMENT BOARD'));
  const navigation = node('div', 'run-list');
  for (const [value, label] of [['active', 'Active tasks'], ['open', 'Open'], ['claimed', 'In progress'], ['blocked', 'Blocked'], ['done', 'Completed'], ['all', 'All tasks']]) {
    const nav = node('button', `run-item ${filter === value ? 'selected' : ''}`, label);
    nav.type = 'button';
    nav.addEventListener('click', () => { filter = value; queueRender(); });
    put(navigation, nav);
  }
  put(sidebar, navigation, node('div', 'side-spacer'));
  const footer = node('div', 'side-footer');
  put(footer, node('span', 'online-dot'), node('span', '', 'LIVE · LOCAL'), node('small', 'mono', 'quant-swarm-coord'));
  put(sidebar, footer);
  const main = node('main', 'main');
  const header = node('header', 'page-head');
  const title = node('div', 'title');
  put(title, node('p', 'eyebrow', 'DEVELOPMENT OVERVIEW'), node('h1', '', 'Development coordination'),
    node('p', 'muted', 'Sessions, tasks, messages and file locks'));
  const controls = node('div', 'controls');
  const trading = node('a', 'ghost-button', 'Trading dashboard ↗');
  trading.href = 'http://127.0.0.1:4173';
  put(controls, trading);
  put(header, title, controls);
  put(main, header);
  const stats = node('div', 'stats');
  for (const [label, count] of [['Sessions', sessions.length], ['Open tasks', tasks.filter(t => t.status === 'open').length], ['In progress', tasks.filter(t => t.status === 'claimed').length], ['Blocked', tasks.filter(t => t.status === 'blocked').length], ['File locks', locks.length], ['Messages', messages.length]]) {
    const stat = node('div', 'stat');
    put(stat, node('span', 'stat-label', String(label)), node('strong', '', String(count)));
    put(stats, stat);
  }
  put(main, stats);
  if (error) put(main, node('p', 'error', error));
  const columns = node('div', 'columns');
  const primary = node('div', 'column');
  const secondary = node('div', 'column');
  const taskPanel = panel('Task board', `${shownTasks.length} tasks · ${filter}`);
  if (!shownTasks.length) empty(taskPanel, 'No tasks in this view.');
  const cards = node('div', 'cards');
  for (const task of shownTasks) {
    const card = node('article', 'research-card');
    const head = node('div', 'card-head');
    put(head, node('strong', '', task.title), pill(task.status));
    put(card, head, field('Task', task.id), field('Assigned to', task.assignee || 'Unclaimed'), field('Area', task.area));
    if (task.dependsOn) put(card, field('Depends on', task.dependsOn));
    const details = node('details', 'evidence-details');
    details.open = selectedTask === task.id;
    details.addEventListener('toggle', () => { if (details.open) selectedTask = task.id; else if (selectedTask === task.id) selectedTask = ''; });
    put(details, node('summary', '', 'Details and actions'), node('p', 'board-copy', task.details || 'No additional details.'));
    if (task.result) put(details, field('Result', task.result));
    put(details, field('Updated', when(task.updatedAt)));
    const actions = node('div', 'controls');
    const available = task.status === 'open' ? [['claim', 'Claim task']] : task.assignee === sessionName.trim() && ['claimed', 'blocked'].includes(task.status) ? [['done', 'Complete'], ['blocked', 'Block'], ['open', 'Release']] : [];
    for (const [status, label] of available) {
      const action = button(label, () => { void taskAction(conn, task, status); });
      action.disabled = actionPending;
      put(actions, action);
    }
    put(details, actions);
    put(card, details);
    put(cards, card);
  }
  put(taskPanel, cards);
  put(primary, taskPanel);
  const messagePanel = panel('Live messages', 'Development coordination history');
  const stream = node('div', 'timeline');
  if (!messages.length) empty(stream, 'No messages yet.');
  for (const message of messages.slice(0, 100)) {
    const event = node('article', 'event');
    const content = node('div', 'event-body');
    const top = node('div', 'event-top');
    put(top, node('strong', '', `${message.sender}${message.recipient ? ` → ${message.recipient}` : ' → everyone'}`), node('time', 'muted', when(message.createdAt)));
    put(content, top, node('p', 'board-copy', message.body));
    if (message.taskId) put(content, node('small', 'muted mono', message.taskId));
    put(event, node('span', 'event-mark decision'), content);
    put(stream, event);
  }
  put(messagePanel, stream);
  const form = node('form', 'board-form');
  put(form, input('Your session name', sessionName, value => { sessionName = value; save(NAME_KEY, value); queueRender(); }),
    input('Recipient (blank = everyone)', draftRecipient, value => { draftRecipient = value; }),
    input('Task ID (optional)', draftTask, value => { draftTask = value; }),
    input('Message', draftBody, value => { draftBody = value; }, true));
  const send = node('button', 'primary-button', sending ? 'Sending…' : 'Send message');
  send.type = 'submit'; send.disabled = sending;
  put(form, send);
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (sending) return;
    sending = true; error = ''; send.disabled = true;
    void (async () => {
      const name = await asSession(conn);
      await conn.reducers.post({ sender: name, recipient: draftRecipient.trim(), taskId: draftTask.trim(), body: draftBody });
      draftBody = '';
    })().catch(reason => { error = String(reason); }).finally(() => { sending = false; queueRender(); });
  });
  put(messagePanel, form);
  put(secondary, messagePanel);
  const sessionPanel = panel('Sessions', 'Most recently seen first');
  for (const session of sessions) {
    const card = node('article', 'order-card');
    const head = node('div', 'card-head');
    put(head, node('strong', '', session.name), pill(session.tool));
    put(card, head, node('p', 'board-copy', session.focus), field('Last seen', when(session.lastSeen)));
    put(sessionPanel, card);
  }
  if (!sessions.length) empty(sessionPanel, 'No registered sessions.');
  put(primary, sessionPanel);
  const lockPanel = panel('File locks', 'Active reservations');
  for (const lock of locks) {
    const card = node('article', 'order-card');
    put(card, node('strong', 'mono', lock.path), field('Held by', lock.holder), field('Task', lock.taskId), field('Expires', when(lock.expiresAt)));
    if (lock.reason) put(card, node('p', 'board-copy', lock.reason));
    put(lockPanel, card);
  }
  if (!locks.length) empty(lockPanel, 'No active file locks.');
  put(secondary, lockPanel);
  put(columns, primary, secondary);
  put(main, columns);
  put(layout, sidebar, main);
  root.replaceChildren(layout);
}
function reconnect(reason: unknown, current: number): void {
  if (current !== generation) return;
  // Only recover an explicitly rejected login, never a reducer/access denial.
  // Keep the fallback in memory even when browser storage is unavailable.
  if (sessionToken && !recoveredToken && /failed to verify token/i.test(String(reason))) {
    recoveredToken = true;
    sessionToken = undefined;
    try { localStorage.removeItem(TOKEN_KEY); } catch { /* In-memory reset still works. */ }
  }
  if (timer !== undefined) return;
  ready = false;
  connection = undefined;
  state = `Development connection interrupted: ${String(reason)}. Reconnecting…`;
  queueRender();
  timer = window.setTimeout(() => { timer = undefined; connect(); }, Math.min(30_000, 1000 * 2 ** Math.min(retry++, 5)));
}
function connect(): void {
  const current = ++generation;
  ready = false;
  connection = DbConnection.builder()
    .withUri(HOST)
    .withDatabaseName(DATABASE)
    .withToken(sessionToken)
    .onConnect((conn, _identity, token) => {
      if (current !== generation) { conn.disconnect(); return; }
      connection = conn;
      retry = 0;
      sessionToken = token;
      save(TOKEN_KEY, token);
      for (const table of [conn.db.session, conn.db.devTask, conn.db.devMessage, conn.db.fileLock]) {
        table.onInsert(queueRender); table.onUpdate(queueRender); table.onDelete(queueRender);
      }
      conn.subscriptionBuilder()
        .onApplied(() => { if (current === generation) { ready = true; queueRender(); } })
        .onError(reason => { conn.disconnect(); reconnect(reason, current); })
        .subscribe(['SELECT * FROM session', 'SELECT * FROM dev_task', 'SELECT * FROM dev_message', 'SELECT * FROM file_lock']);
    })
    .onConnectError((_ctx, reason) => reconnect(reason, current))
    .onDisconnect((_ctx, reason) => reconnect(reason, current))
    .build();
}
render();
connect();
// Refresh expired lock visibility even when the backend has no new writes.
window.setInterval(queueRender, 30_000);

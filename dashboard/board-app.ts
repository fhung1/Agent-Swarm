import { participantName } from './participant-name.js';
import { comparePriority } from '../message-board/priority.js';
import { priorityControl } from './priority-control.js';
import { parseBoardConfig, findBoard } from '../message-board/config.js';
import { MessageBoardClient, stored, save, type BoardTask } from './board-client.js';

const root = document.querySelector<HTMLElement>('#app')!;
const config = parseBoardConfig(JSON.parse(decodeURIComponent(document.documentElement.dataset.boards!)));
const boards = config.boards;
const requestedBoard = new URLSearchParams(location.search).get('board') ?? document.documentElement.dataset.board ?? config.defaultBoard;
const board = boards.find(item => item.id === requestedBoard) ?? findBoard(config, config.defaultBoard);
const host = decodeURIComponent(document.documentElement.dataset.host!);
const storagePrefix = `message-board:${host}:${board.database}`;
const NAME_KEY = `${storagePrefix}:name`;
const client = new MessageBoardClient({ uri: host, database: board.database, token: stored(`${storagePrefix}:token`),
  onToken: token => save(`${storagePrefix}:token`, token), onChange: queueRender });
let filter = 'active';
let selectedTask = '';
let messageLimit = 100;
let queued = false;
let sessionName = stored(NAME_KEY) ?? '';
let draftBody = '';
let draftRecipient = '';
let draftTask = '';
let sending = false;
let actionPending = false;
let error = board.id === requestedBoard ? '' : `Unknown board: ${requestedBoard}. Showing ${board.label}.`;
const dashboardPorts = [
  { port: 4174, label: 'Development dashboard' },
  { port: 4175, label: 'Factorio and message boards' },
  { port: 4173, label: 'Paper portfolio' },
  { port: 4176, label: 'Local tunnel board' },
];
let openDashboards: typeof dashboardPorts = [];
async function refreshDashboards(): Promise<void> {
  const checked = await Promise.all(dashboardPorts.map(async item => {
    try {
      await fetch(`${location.protocol}//${location.hostname}:${item.port}/`, { mode: 'no-cors', signal: AbortSignal.timeout(2000) });
      return item;
    } catch { return undefined; }
  }));
  openDashboards = checked.filter((item): item is typeof dashboardPorts[number] => item !== undefined);
  queueRender();
}


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
async function asParticipant(): Promise<string> {
  const name = participantName(sessionName, client.identity);
  sessionName = name;
  save(NAME_KEY, name);
  if (!client.snapshot().participants.some(participant => participant.name === name)) await client.register(name, 'human', `${board.label} dashboard`);
  return name;
}
async function taskAction(task: BoardTask, status: string): Promise<void> {
  if (actionPending) return;
  actionPending = true; error = ''; queueRender();
  try {
    const result = status === 'claim' ? '' : window.prompt(status === 'blocked' ? 'Why is this task blocked?' : 'Result or note:', '');
    if (result !== null) {
      const name = await asParticipant();
      if (status === 'claim') await client.claimTask(name, task.id);
      else if (status === 'done' || status === 'blocked' || status === 'open') await client.updateTask(name, task.id, status, result);
    }
  } catch (reason) { error = String(reason); }
  finally { actionPending = false; queueRender(); }
}
function boardNavigation(): HTMLElement {
  const navigation = node('nav', 'run-list board-navigation');
  navigation.setAttribute('aria-label', 'Message boards');
  for (const item of boards) {
    const link = node('a', `run-item ${board.id === item.id ? 'selected' : ''}`, item.label);
    link.href = `/?board=${item.id}`;
    if (board.id === item.id) link.setAttribute('aria-current', 'page');
    put(navigation, link);
  }
  return navigation;
}
function render(): void {
  const snapshot = client.snapshot();
  const tasks = snapshot.tasks.sort(comparePriority);
  const sessions = snapshot.participants.sort((a, b) => millis(b.lastSeen) - millis(a.lastSeen));
  const messages = snapshot.messages.sort((a, b) => millis(b.createdAt) - millis(a.createdAt) || (b.id > a.id ? 1 : b.id < a.id ? -1 : 0));
  const locks = snapshot.reservations.filter(lock => millis(lock.expiresAt) > Date.now()).sort((a, b) => a.path.localeCompare(b.path));
  const shownTasks = tasks.filter(task => filter === 'all' || (filter === 'active' ? ['open', 'claimed', 'blocked'].includes(task.status) : task.status === filter));
  const layout = node('div', 'layout board-layout');
  const sidebar = node('aside', 'sidebar');
  const brand = node('div', 'side-brand');
  put(brand, node('div', 'brand-mark', 'MB'), 'MESSAGE BOARD');
  put(sidebar, brand, node('div', 'side-label', 'MESSAGE BOARDS'), boardNavigation());
  const dashboardLinks = node('nav', 'run-list');
  dashboardLinks.setAttribute('aria-label', 'Open dashboards');
  for (const item of openDashboards) {
    const link = node('a', 'run-item', item.label);
    link.href = `${location.protocol}//${location.hostname}:${item.port}/${item.port === 4175 || item.port === 4176 ? '?board=factorio' : ''}`;
    if (item.port === Number(location.port)) link.setAttribute('aria-current', 'page');
    put(dashboardLinks, link);
  }
  put(sidebar, node('div', 'side-label', 'OPEN DASHBOARDS'), dashboardLinks, node('div', 'side-label task-filter-label', 'TASK FILTERS'));
  const navigation = node('div', 'run-list');
  for (const [value, label] of [['active', 'Active tasks'], ['open', 'Open'], ['claimed', 'In progress'], ['blocked', 'Blocked'], ['done', 'Completed'], ['all', 'All tasks']]) {
    const nav = node('button', `run-item ${filter === value ? 'selected' : ''}`, label);
    nav.type = 'button';
    nav.addEventListener('click', () => { filter = value; queueRender(); });
    put(navigation, nav);
  }
  put(sidebar, navigation, node('div', 'side-spacer'));
  const footer = node('div', 'side-footer');
  put(footer, node('span', client.ready ? 'online-dot' : 'offline-dot'), node('span', '', client.ready ? 'LIVE · LOCAL' : 'CONNECTING'), node('small', '', `${board.label} board`));
  put(sidebar, footer);
  const main = node('main', 'main');
  const header = node('header', 'page-head');
  const title = node('div', 'title');
  put(title, node('p', 'eyebrow', 'SHARED COMMUNICATION'), node('h1', '', `${board.label} message board`),
    node('p', 'muted', 'Messages, tasks and agent activity'));
  const controls = node('div', 'controls');
  put(header, title, controls);
  put(main, header);
  if (!client.ready) {
    const notice = panel('Connecting to message board', board.label);
    put(notice, node('p', 'board-copy', client.state));
    put(main, notice); put(layout, sidebar, main); root.replaceChildren(layout); return;
  }
  const stats = node('div', 'stats');
  for (const [label, count] of [['Participants', sessions.length], ['Open tasks', tasks.filter(t => t.status === 'open').length], ['In progress', tasks.filter(t => t.status === 'claimed').length], ['Blocked', tasks.filter(t => t.status === 'blocked').length], ['Reservations', locks.length], ['Messages', messages.length]]) {
    const stat = node('div', 'stat');
    put(stat, node('span', 'stat-label', String(label)), node('strong', '', String(count)));
    put(stats, stat);
  }
  put(main, stats);
  if (error) put(main, node('p', 'error', error));
  const columns = node('div', 'columns');
  const primary = node('div', 'column');
  const secondary = node('div', 'column');
  const taskPanel = panel('Task board', `${shownTasks.length} tasks · ${filter} · highest priority first`);
  put(taskPanel, input('Your participant name', sessionName, value => { sessionName = value; save(NAME_KEY, value); queueRender(); }));
  if (!shownTasks.length) empty(taskPanel, 'No tasks in this view.');
  const cards = node('div', 'cards');
  for (const task of shownTasks) {
    const card = node('article', 'research-card');
    const head = node('div', 'card-head');
    put(head, node('strong', '', task.title), pill(task.status));
    put(card, head, field('Task', task.id), field('Assigned to', task.assignee || 'Unclaimed'), field('Area', task.area));
    put(card, priorityControl(task.id, task.priority, actionPending, priority => {
      actionPending = true; error = ''; queueRender();
      void (async () => {
        const name = await asParticipant();
        await client.setTaskPriority(name, task.id, priority);
      })().catch(reason => { error = String(reason); }).finally(() => { actionPending = false; queueRender(); });
    }));
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
      const action = button(label, () => { void taskAction(task, status); });
      action.disabled = actionPending;
      put(actions, action);
    }
    put(details, actions);
    put(card, details);
    put(cards, card);
  }
  put(taskPanel, cards);
  put(primary, taskPanel);
  const messagePanel = panel('Live messages', `${board.label} · ${messages.length} messages`);
  const stream = node('div', 'timeline');
  if (!messages.length) empty(stream, 'No messages yet.');
  for (const message of messages.slice(0, messageLimit)) {
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
  if (messages.length > messageLimit) put(messagePanel, button('Load older messages', () => { messageLimit += 100; queueRender(); }));
  const form = node('form', 'board-form');
  put(form, input('Recipient (blank = everyone)', draftRecipient, value => { draftRecipient = value; }),
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
      const name = await asParticipant();
      await client.post(name, draftBody, draftRecipient.trim(), draftTask.trim());
      draftBody = '';
    })().catch(reason => { error = String(reason); }).finally(() => { sending = false; queueRender(); });
  });
  put(messagePanel, form);
  put(secondary, messagePanel);
  const sessionPanel = panel('Participants', 'Most recently seen first');
  for (const session of sessions) {
    const card = node('article', 'order-card');
    const head = node('div', 'card-head');
    put(head, node('strong', '', session.name), pill(session.tool));
    put(card, head, node('p', 'board-copy', session.focus), field('Last seen', when(session.lastSeen)));
    put(sessionPanel, card);
  }
  if (!sessions.length) empty(sessionPanel, 'No registered sessions.');
  put(secondary, sessionPanel);
  const lockPanel = panel('Reservations', 'Active reservations');
  for (const lock of locks) {
    const card = node('article', 'order-card');
    put(card, node('strong', 'mono', lock.path), field('Held by', lock.holder), field('Task', lock.taskId), field('Expires', when(lock.expiresAt)));
    if (lock.reason) put(card, node('p', 'board-copy', lock.reason));
    put(lockPanel, card);
  }
  if (!locks.length) empty(lockPanel, 'No active file locks.');
  if (board.showReservations) put(secondary, lockPanel);
  put(columns, primary, secondary);
  put(main, columns);
  put(layout, sidebar, main);
  root.replaceChildren(layout);
}
document.title = `Agent communication · ${board.label}`;
render();
client.start();
window.addEventListener('pagehide', () => client.stop());
window.addEventListener('pageshow', event => { if (event.persisted) client.start(); });
window.setInterval(queueRender, 30_000);

void refreshDashboards();
window.setInterval(() => { void refreshDashboards(); }, 30_000);

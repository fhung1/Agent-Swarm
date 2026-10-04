import { participantName } from './participant-name.js';
import { comparePriority, type TaskPriority } from '../message-board/priority.js';
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
let creatingTask = false;
let taskCreatedNotice = '';
let newTaskTitle = '';
let newTaskDetails = '';
let newTaskArea = 'general';
let newTaskPriority: TaskPriority = 'normal';
let newTaskDependency = '';
let actionPending = false;
let error = board.id === requestedBoard ? '' : `Unknown board: ${requestedBoard}. Showing ${board.label}.`;
const dashboardPorts = [
  { port: 4174, label: 'Development dashboard' },
  { port: 4175, label: 'Factorio and message boards' },
  { port: 4173, label: 'Paper portfolio' },
  { port: 4176, label: 'Local tunnel board' },
];
let openDashboards: typeof dashboardPorts = [];
type FactorioAgent = { index: number; actorId: number; sender: string; taskId: string };
type FactorioRun = { runId: string; goal: string; provider: string; model: string; mode: string; maxCalls: number | null; totalCallLimit: number | null;
  runMs: number | null; maxRunSpendUsd: string | null; spend: { capUsd: string; chargedUsd: string; reservedUsd: string; remainingUsd: string; halted: boolean } | null; workers: FactorioAgent[] };
type FactorioActor = { unit: number; x: number; y: number; inventory: { ironOre: number; coal: number; ironPlate: number; items: Record<string, number> } };
type FactorioSnapshot = { checkedAt: string; controlsEnabled: boolean; game: { automation?: {coalMined?:number;needsFuel?:boolean;verified:boolean; windows:number; mined:number; smelted:number; delivered:number; currentStored:number}; resourceMap?: ResourceSurvey; tick: number; paused: boolean; world: { worldId: string; historyId: string; scenario: string; seed: number; spawn: { x: number; y: number } }; actors: FactorioActor[]; chests: Array<{ unit: number; x: number; y: number; ironOre: number; coal: number; ironPlate: number; items: Record<string, number> }>; furnaces: number; rocketLaunches: number; lastRocketTick?: number }; run: FactorioRun | null };
type ResourceSurvey = { tick: number; generatedChunks: number; totals: Record<string, number>; omittedCells: number;
  deposits: Array<{ id: string; resource: string; name: string; x: number; y: number; amount: number; distance: number }>; frontiers: Array<{x: number; y: number}> };
let mapExpanded = false;
let factorioSnapshot: FactorioSnapshot | null = null;
let factorioStatusError = 'Waiting for the Factorio server status…';
let factorioControlPending = false;
let factorioControlMessage = '';
let factorioControlToken = '';
let factorioStatusRequest: Promise<void> | undefined;
async function refreshFactorioStatus(): Promise<void> {
  if (board.id !== 'factorio' || factorioStatusRequest) return factorioStatusRequest;
  factorioStatusRequest = (async () => {
    try {
      const response = await fetch('/api/factorio/status', { cache: 'no-store', signal: AbortSignal.timeout(12000) });
      const result = await response.json();
      if (!response.ok) throw Error(result.error || `Status request failed (${response.status})`);
      factorioSnapshot = result as FactorioSnapshot;
      factorioStatusError = '';
    } catch (reason) { factorioStatusError = String(reason); }
    finally { factorioStatusRequest = undefined; queueRender(); }
  })();
  return factorioStatusRequest;
}
async function setFactorioPause(paused: boolean): Promise<void> {
  if (factorioControlPending) return;
  factorioControlPending = true; factorioControlMessage = ''; queueRender();
  try {
    const response = await fetch('/api/factorio/control', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${factorioControlToken}` },
      body: JSON.stringify({ paused }), signal: AbortSignal.timeout(12000) });
    const result = await response.json();
    if (!response.ok) throw Error(result.error || `Control request failed (${response.status})`);
    factorioControlMessage = `${result.paused ? 'Paused' : 'Resumed'} at game tick ${result.tick}.`;
    await refreshFactorioStatus();
  } catch (reason) { factorioControlMessage = String(reason); }
  finally { factorioControlPending = false; queueRender(); }
}
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
function showLayout(layout: HTMLElement, sidebar: HTMLElement): void {
  const previous = root.querySelector<HTMLElement>('.message-board-layout');
  const sidebarScrollTop = previous?.querySelector<HTMLElement>('.sidebar')?.scrollTop ?? 0;
  const mainScrollTop = previous?.querySelector<HTMLElement>('.main')?.scrollTop ?? 0;
  root.replaceChildren(layout);
  sidebar.scrollTop = sidebarScrollTop;
  layout.querySelector<HTMLElement>('.main')!.scrollTop = mainScrollTop;
}
function queueRender(): void {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    const active = document.activeElement;
    const editing = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active instanceof HTMLSelectElement;
    const label = editing ? active.dataset.field : undefined;
    const selection = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement ? [active.selectionStart, active.selectionEnd] : undefined;
    render();
    if (label) {
      const control = Array.from(root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('[data-field]'))
        .find(element => element.dataset.field === label);
      control?.focus({ preventScroll: true });
      if ((control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement) && selection) control.setSelectionRange(selection[0], selection[1]);
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
function select(label: string, value: string, options: Array<[string, string]>, update: (value: string) => void): HTMLElement {
  const wrapper = node('label', 'board-input');
  const control = node('select');
  control.dataset.field = label;
  for (const [optionValue, optionLabel] of options) {
    const option = node('option', '', optionLabel);
    option.value = optionValue;
    control.append(option);
  }
  control.value = value;
  control.addEventListener('change', () => update(control.value));
  put(wrapper, node('span', 'muted small', label), control);
  return wrapper;
}
async function createBoardTask(): Promise<void> {
  if (creatingTask) return;
  creatingTask = true; error = ''; taskCreatedNotice = ''; queueRender();
  try {
    const title = newTaskTitle.trim();
    if (!title) throw Error('Enter a task title.');
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 72) || 'task';
    const name = await asParticipant();
    const id = `${slug}-${crypto.randomUUID().slice(0, 8)}`;
    await client.createTask(name, { id, title, details: newTaskDetails.trim(), area: newTaskArea.trim() || 'general',
      dependsOn: newTaskDependency, priority: newTaskPriority });
    newTaskTitle = ''; newTaskDetails = ''; newTaskArea = 'general'; newTaskPriority = 'normal'; newTaskDependency = '';
    taskCreatedNotice = `Created “${title}” (${id}).`;
  } catch (reason) { error = String(reason); }
  finally { creatingTask = false; queueRender(); }
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
function factorioPanel(snapshot: ReturnType<MessageBoardClient['snapshot']>): HTMLElement {
  const game = factorioSnapshot?.game;
  const section = panel('Factorio control room', game ? `Authoritative game state · checked ${new Date(factorioSnapshot!.checkedAt).toLocaleTimeString()}` : 'Waiting for the game server');
  if (factorioStatusError) put(section, node('p', 'error', factorioStatusError));
  if (!game) {
    put(section, node('p', 'board-copy', 'Set FACTORIO_WORLD on the Factorio dashboard server and keep the Factorio game server running to load its state and enable pause controls.'));
    return section;
  }
  const summary = node('div', 'factorio-summary');
  put(summary,
    field('Game state', game.paused ? 'Paused · new mutations blocked' : 'Running · mutations enabled'),
    field('Game tick', String(game.tick)),
    field('World ID', game.world.worldId),
    field('History ID', game.world.historyId),
    field('Scenario / seed', `${game.world.scenario} / ${game.world.seed}`),
    field('Scripted actors', String(game.actors.length)),
    field('Shared chests / furnaces', `${game.chests.length} / ${game.furnaces}`),
    field('Rocket launches', String(game.rocketLaunches ?? 0)));
  put(section, summary);
  if (factorioSnapshot?.controlsEnabled) {
    const wrapper = node('label', 'board-input factorio-token');
    const label = node('span', 'muted small', 'Operator control token (held for this tab only)');
    const token = node('input');
    token.type = 'password'; token.autocomplete = 'off'; token.spellcheck = false;
    token.dataset.field = 'factorioControlToken'; token.value = factorioControlToken;
    token.addEventListener('input', () => { factorioControlToken = token.value; queueRender(); });
    put(wrapper, label, token, node('small', 'muted', 'Configured on the dashboard server as FACTORIO_CONTROL_TOKEN.'));
    put(section, wrapper);
  } else {
    put(section, node('p', 'muted small', 'Operator controls are disabled. Configure FACTORIO_CONTROL_TOKEN on the dashboard server.'));
  }
  const controls = node('div', 'controls factorio-controls');
  const pause = button(factorioControlPending ? 'Sending…' : 'Pause mutations', () => { void setFactorioPause(true); }, true);
  pause.disabled = factorioControlPending || game.paused || !factorioSnapshot?.controlsEnabled || !factorioControlToken || Boolean(factorioStatusError);
  const resume = button(factorioControlPending ? 'Sending…' : 'Resume mutations', () => { void setFactorioPause(false); });
  resume.disabled = factorioControlPending || !game.paused || !factorioSnapshot?.controlsEnabled || !factorioControlToken || Boolean(factorioStatusError);
  put(controls, pause, resume);
  put(section, controls);
  if (factorioControlMessage) put(section, node('p', factorioControlMessage.startsWith('Paused') || factorioControlMessage.startsWith('Resumed') ? 'muted small' : 'error', factorioControlMessage));
  put(section, node('p', 'muted small', 'Pause blocks new game mutations. Message-board coordination remains available.'));

  const proof = game.automation;
  if (proof) {
    const automation = node('div', 'factorio-actors');
    put(automation, node('h3', '', 'Automatic iron production'),
      field('Engine proof', proof.verified ? 'Verified unattended production' : 'Waiting for two consecutive 30-second production windows'),
      field('Completed windows', String(proof.windows ?? 0)),
      field('This window: mined / smelted / stored', `${proof.mined ?? 0} / ${proof.smelted ?? 0} / ${proof.delivered ?? 0}`),
      field('Plates in storage', String(proof.currentStored ?? 0)),
      field('Automatic fuel acquisition', proof.needsFuel ? `${proof.coalMined ?? 0} coal mined this window` : 'No burner production machines present'),
      node('p','muted small','Actor material transfers, mining, crafting and construction reset the proof. Starting resources are declared in the save manifest.'));
    put(section, automation);
  }
  const survey = game.resourceMap;
  if (survey) {
    const map = node('div', 'factorio-actors');
    put(map, node('h3', '', 'Shared resource map'), node('p', 'muted small',
      `Read-only survey shared with Astra and all actors · ${survey.generatedChunks} generated chunks · tick ${survey.tick}. Ungenerated terrain is unknown.`));
    const totals = node('div', 'factorio-summary');
    for (const [resource, amount] of Object.entries(survey.totals)) put(totals, field(resource === 'wood' ? 'Trees (wood sources)' : resource, amount.toLocaleString()));
    put(map, totals);
    const details = node('details', 'evidence-details'); details.open = mapExpanded;
    details.addEventListener('toggle', () => { mapExpanded = details.open; });
    const deposits = Array.isArray(survey.deposits) ? survey.deposits : [];
    put(details, node('summary', '', `Resource destinations (${deposits.length} cells shown; ${survey.omittedCells} omitted)`));
    for (const deposit of deposits) put(details, field(deposit.resource,
      `(${deposit.x.toFixed(1)}, ${deposit.y.toFixed(1)}) · ${deposit.distance} tiles from spawn · ${deposit.amount.toLocaleString()} in cell`));
    if (!deposits.length) put(details, node('p', 'muted small', 'No resources found in generated terrain. Actors must explore the frontier.'));
    const frontiers = Array.isArray(survey.frontiers) ? survey.frontiers : [];
    put(details, field('Exploration frontiers', frontiers.map(p => `(${p.x}, ${p.y})`).join(', ')));
    put(map, details); put(section, map);
  }
  const actors = node('div', 'factorio-actors');
  put(actors, node('h3', '', 'Actor state'), node('p', 'muted small', 'Position and inventory are read from the live game server.'));
  if (!game.actors.length) put(actors, node('p', 'empty', 'No scripted actors are present in this world.'));
  for (const actor of game.actors) {
    const inventory = actor.inventory;
    const card = node('article', 'order-card factorio-actor');
    const items = Object.entries(inventory.items).sort(([a], [b]) => a.localeCompare(b)).map(([name, count]) => `${name} ×${count}`).join(', ') || 'Empty';
    put(card, node('strong', '', `Actor ${actor.unit}`), field('Position', `${actor.x.toFixed(1)}, ${actor.y.toFixed(1)}`),
      field('Iron ore / coal / plates', `${inventory.ironOre} / ${inventory.coal} / ${inventory.ironPlate}`), field('Inventory', items));
    put(actors, card);
  }
  put(section, actors);
  if (game.chests.length) {
    const chests = node('div', 'factorio-actors');
    put(chests, node('h3', '', 'Shared chest inventory'));
    for (const chest of game.chests) {
      const card = node('article', 'order-card factorio-actor');
      const items = Object.entries(chest.items).sort(([a], [b]) => a.localeCompare(b)).map(([name, count]) => `${name} ×${count}`).join(', ') || 'Empty';
      put(card, node('strong', '', `Chest ${chest.unit}`), field('Position', `${chest.x.toFixed(1)}, ${chest.y.toFixed(1)}`),
        field('Iron ore / coal / plates', `${chest.ironOre} / ${chest.coal} / ${chest.ironPlate}`), field('Inventory', items));
      put(chests, card);
    }
    put(section, chests);
  }

  const run = factorioSnapshot?.run;
  if (run) {
    const matchingTasks = run.workers.map(worker => snapshot.tasks.find(task => task.id === worker.taskId));
    const done = matchingTasks.filter(task => task?.status === 'done').length;
    const claimed = matchingTasks.filter(task => task?.status === 'claimed').length;
    const goalLabel = run.goal === 'plates' ? 'Iron plate factory' : run.goal;
    const runPanel = panel(`Inference run · ${run.runId}`, client.ready
      ? `${goalLabel} · ${run.provider}/${run.model} · ${done}/${run.workers.length} tasks complete · ${claimed} in progress`
      : `${goalLabel} · ${run.provider}/${run.model} · message board unavailable`);
    put(runPanel, field('Run limits', `${run.mode} · ${run.runMs === null ? 'duration unavailable' : `${Math.round(run.runMs / 60000)} min`}`));
    put(runPanel, field('Run spend', run.spend
      ? `${run.spend.halted ? 'STOPPED · ' : ''}${run.spend.chargedUsd} charged · ${run.spend.reservedUsd} reserved · ${run.spend.remainingUsd} remaining of ${run.spend.capUsd}`
      : `${run.maxRunSpendUsd ? `$${run.maxRunSpendUsd} cap` : 'Spend cap unavailable'} · waiting for run ledger`));
    put(runPanel, field('Call budget', run.maxCalls === null || run.totalCallLimit === null
      ? 'Unlimited · shared run spend cap stops all agents'
      : `${run.maxCalls} per actor · ${run.totalCallLimit} total`));
    const workers = node('div', 'cards factorio-workers');
    if (!client.ready) empty(workers, 'Worker task and participant state will appear when the message-board subscription reconnects.');
    for (const worker of client.ready ? run.workers : []) {
      const task = snapshot.tasks.find(candidate => candidate.id === worker.taskId);
      const session = snapshot.participants.find(candidate => candidate.name === worker.sender);
      const card = node('article', 'order-card');
      const head = node('div', 'card-head');
      put(head, node('strong', '', `Agent ${worker.index} · Actor ${worker.actorId}`), pill(task?.status ?? 'neutral'));
      put(card, head, field('Worker identity', worker.sender), field('Task', task?.title ?? worker.taskId),
        field('Assigned to', task?.assignee || 'Unclaimed'),
        field('Board presence', session ? `${session.tool} · last seen ${when(session.lastSeen)}` : 'No participant record'));
      put(workers, card);
    }
    if (!run.workers.length) empty(workers, 'The saved run plan contains no worker mappings.');
    put(runPanel, workers);
    put(section, runPanel);
  } else {
    put(section, node('p', 'empty', 'No saved inference run plan matches this world. Live game and message-board state are still shown.'));
  }
  return section;
}
function render(): void {
  const snapshot = client.snapshot();
  const tasks = snapshot.tasks.sort(comparePriority);
  const sessions = snapshot.participants.sort((a, b) => millis(b.lastSeen) - millis(a.lastSeen));
  const messages = snapshot.messages.sort((a, b) => millis(b.createdAt) - millis(a.createdAt) || (b.id > a.id ? 1 : b.id < a.id ? -1 : 0));
  const locks = snapshot.reservations.filter(lock => millis(lock.expiresAt) > Date.now()).sort((a, b) => a.path.localeCompare(b.path));
  const shownTasks = tasks.filter(task => filter === 'all' || (filter === 'active' ? ['open', 'claimed', 'blocked'].includes(task.status) : task.status === filter));
  const layout = node('div', 'layout board-layout message-board-layout');
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
  if (board.id === 'factorio') put(main, factorioPanel(snapshot));
  if (!client.ready) {
    const notice = panel('Connecting to message board', board.label);
    put(notice, node('p', 'board-copy', client.state));
    put(main, notice); put(layout, sidebar, main); showLayout(layout, sidebar); return;
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
  const createForm = node('form', 'board-form task-create-form');
  put(createForm, node('h3', '', 'Create a task'),
    input('Title', newTaskTitle, value => { newTaskTitle = value; }),
    input('Details', newTaskDetails, value => { newTaskDetails = value; }, true),
    input('Area', newTaskArea, value => { newTaskArea = value; }),
    select('Priority', newTaskPriority, [['urgent', 'Urgent'], ['high', 'High'], ['normal', 'Normal'], ['low', 'Low']], value => { newTaskPriority = value as TaskPriority; }),
    select('Depends on (optional)', newTaskDependency, [['', 'No dependency'], ...tasks.map(task => [task.id, `${task.title} (${task.status})`] as [string, string])], value => { newTaskDependency = value; }));
  const createButton = node('button', 'primary-button', creatingTask ? 'Creating…' : 'Create task');
  createButton.type = 'submit'; createButton.disabled = creatingTask;
  put(createForm, createButton);
  createForm.addEventListener('submit', event => { event.preventDefault(); void createBoardTask(); });
  put(taskPanel, createForm);
  if (taskCreatedNotice) put(taskPanel, node('p', 'task-created-notice', taskCreatedNotice));
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
  showLayout(layout, sidebar);
}
document.title = `Agent communication · ${board.label}`;
render();
client.start();
window.addEventListener('pagehide', () => client.stop());
window.addEventListener('pageshow', event => { if (event.persisted) client.start(); });
window.setInterval(queueRender, 30_000);

void refreshDashboards();
window.setInterval(() => { void refreshDashboards(); }, 30_000);
if (board.id === 'factorio') {
  void refreshFactorioStatus();
  window.setInterval(() => { void refreshFactorioStatus(); }, 5000);
}

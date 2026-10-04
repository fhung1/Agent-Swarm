import { DbConnection } from '../src/module_bindings/index.js';
import type { AccountSnapshot, Decision, Fact, Message, PaperOrder, Run, Source, Thesis } from '../src/module_bindings/types.js';
import { dashboardConfig, dashboardTokenKey } from './config.js';

const { host: HOST, database: DATABASE } = dashboardConfig('quant-swarm');
const TOKEN_KEY = dashboardTokenKey('dashboard', HOST, DATABASE);
const root = document.querySelector<HTMLElement>('#app');
if (!root) throw new Error('Dashboard root is missing');

let connection: DbConnection | undefined;
let generation = 0;
let ready = false;
let selectedRun = '';
let identity = '';
let state = 'Connecting to local SpacetimeDB';
let retryCount = 0;
let retryTimer: number | undefined;
let renderQueued = false;

const all = <T>(iter: Iterable<T>): T[] => [...iter];

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', label = ''): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag);
  if (className) result.className = className;
  if (label) result.textContent = label;
  return result;
}

function put(parent: Node, ...children: Array<Node | string | null | undefined>): void {
  for (const child of children) if (child !== null && child !== undefined) {
    parent.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
}

function stamp(value: unknown): Date | undefined {
  if (value instanceof Date) return value;
  if (value && typeof value === 'object' && 'toDate' in value && typeof value.toDate === 'function') {
    return value.toDate() as Date;
  }
  return undefined;
}

function when(value: unknown): string {
  const date = stamp(value);
  return date && Number.isFinite(date.getTime()) ? date.toLocaleString() : '—';
}

function millis(value: unknown): number { return stamp(value)?.getTime() ?? 0; }
function shortId(value: string): string { return value.length > 25 ? `${value.slice(0, 12)}…${value.slice(-8)}` : value; }
function idOf(value: unknown): string {
  if (value && typeof value === 'object' && 'toHexString' in value && typeof value.toHexString === 'function') {
    return value.toHexString() as string;
  }
  return String(value ?? '');
}
function splitRefs(value: string): string[] { return value.split(',').map(v => v.trim()).filter(Boolean); }
function json(value: string): unknown {
  try { return JSON.parse(value); } catch { return undefined; }
}
function array(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(v => !!v && typeof v === 'object' && !Array.isArray(v)) as Record<string, unknown>[] : [];
}
function safeUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined;
  } catch { return undefined; }
}

function link(label: string, href: string): HTMLElement {
  const url = safeUrl(href);
  if (!url) return node('span', 'mono', label);
  const result = node('a', 'evidence-link', label);
  result.href = url;
  result.target = '_blank';
  result.rel = 'noopener noreferrer';
  return result;
}

function pill(label: string, tone = ''): HTMLElement { return node('span', `pill ${tone}`, label); }
function panel(title: string, subtitle?: string): HTMLElement {
  const section = node('section', 'panel');
  const head = node('div', 'panel-head');
  put(head, node('h2', '', title), subtitle ? node('span', 'muted small', subtitle) : null);
  put(section, head);
  return section;
}
function empty(text: string): HTMLElement { return node('p', 'empty', text); }
function field(label: string, value: string | Node): HTMLElement {
  const row = node('div', 'field');
  put(row, node('span', 'field-label', label), typeof value === 'string' ? node('span', 'field-value', value) : value);
  return row;
}
function notice(text: string): void { state = text; queueRender(); }
function queueRender(): void {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; render(); });
}

function connectionScreen(): void {
  const shell = node('div', 'gate');
  put(shell, node('div', 'brand-mark', 'QS'), node('p', 'eyebrow', 'PAPER TRADING · LOCAL OPERATOR CONSOLE'),
    node('h1', '', 'Agent Swarm'), node('p', 'lead', state));
  const developmentLink = node('a', 'ghost-button', 'Development board ↗');
  developmentLink.href = 'http://127.0.0.1:4174';
  put(shell, developmentLink);
  if (identity) {
    const box = node('div', 'gate-card');
    put(box, node('h2', '', 'Grant this browser identity'),
      node('p', 'muted', 'The owner grants the operator role from the local SpacetimeDB CLI. Account access is granted separately.'),
      field('Identity', identity));
    const command = node('code', 'command', `spacetime call --server ${HOST.replace(/^ws/, 'http')} ${DATABASE} grant_agent ${identity} operator`);
    put(box, command, node('p', 'muted small', 'After granting, reload this page. Grant account access with grant_account_access to show balances and orders. The token stays in this browser’s local storage.'));
    put(shell, box);
  }
  root!.replaceChildren(shell);
}

function sidebar(runs: Run[]): HTMLElement {
  const side = node('aside', 'sidebar');
  const brand = node('div', 'side-brand');
  put(brand, node('div', 'brand-mark', 'AS'), node('div', '', 'AGENT SWARM'));
  put(side, brand, node('div', 'side-label', 'PAPER RUNS'));
  const list = node('div', 'run-list');
  for (const run of runs) {
    const button = node('button', `run-item ${run.id === selectedRun ? 'selected' : ''}`);
    button.type = 'button';
    put(button, node('span', 'run-name', run.id), pill(run.status, run.status));
    button.addEventListener('click', () => { selectedRun = run.id; queueRender(); });
    put(list, button);
  }
  put(side, list, node('div', 'side-spacer'));
  const footer = node('div', 'side-footer');
  put(footer, node('span', 'online-dot'), node('span', '', 'LIVE · LOCAL'), node('small', 'mono', shortId(identity)));
  put(side, footer);
  return side;
}

function summary(conn: DbConnection, run: Run, account?: AccountSnapshot): HTMLElement {
  const config = all(conn.db.myRunConfig.iter()).find(row => row.runId === run.id);
  const policy = all(conn.db.myRiskPolicy.iter()).find(row => row.id === config?.policyId);
  const policyJson = json(policy?.policyJson ?? '');
  const policyVersion = policyJson && typeof policyJson === 'object' && 'version' in policyJson
    ? String(policyJson.version) : policy?.id ?? 'Unconfigured';
  const positions = array(json(account?.positionsJson ?? '[]'));
  const orders = all(conn.db.myPaperOrder.iter()).filter(order => {
    const proposal = all(conn.db.myTradeProposal.iter()).find(row => row.id === order.proposalId);
    return proposal?.runId === run.id && !['filled', 'canceled', 'rejected'].includes(order.status);
  });
  const dollars = (micros: bigint) => {
    const whole = micros / 1_000_000n;
    const fraction = (micros % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
    return `$${whole}${fraction ? `.${fraction}` : ''}`;
  };
  const spend = config?.pricingVersion
    ? `${dollars(config.usedSpendMicros)} / ${config.maxSpendMicros ? dollars(config.maxSpendMicros) : 'uncapped'} · worker ${config.maxWorkerSpendMicros ? dollars(config.maxWorkerSpendMicros) : 'uncapped'} · ${config.pricingVersion}`
    : 'Pricing unconfigured';
  const strip = node('div', 'stats');
  const stats = [
    ['Run status', run.status, 'status'],
    ['Policy version', policyVersion, 'policy'],
    ['Pilot contract', 'Pending', 'contract'],
    ['Model tokens', config ? `${config.usedTokens} / ${config.maxTokens}` : 'Unconfigured', 'budget'],
    ['Model spend', spend, 'budget'],
    ['Positions', account ? String(positions.length) : 'No account grant', 'positions'],
    ['Open intents', String(orders.length), 'orders'],
  ];
  for (const [label, value, tone] of stats) {
    const item = node('div', `stat ${tone}`);
    put(item, node('span', 'stat-label', label), node('strong', '', value));
    put(strip, item);
  }
  return strip;
}

function timeline(conn: DbConnection, run: Run, roles: Map<string, string>): HTMLElement {
  const section = panel('Live timeline', 'Tasks, messages and decisions update from subscriptions');
  const events: Array<{ at: number; title: string; detail: string; actor: string; kind: string }> = [];
  for (const task of conn.db.myTask.iter()) if (task.runId === run.id) events.push({
    at: millis(task.updatedAt), title: `${task.kind} · ${task.status}`, detail: `${task.symbol} · ${task.objective}${task.result ? ` · ${task.result}` : ''}`,
    actor: task.assignee ? `${task.role || 'worker'} · ${shortId(idOf(task.assignee))}` : task.role || 'unassigned', kind: 'task',
  });
  for (const message of conn.db.myMessage.iter()) if (message.runId === run.id) events.push({
    at: millis(message.createdAt), title: message.kind, detail: message.body,
    actor: `${roles.get(idOf(message.sender)) ?? 'role unknown'} · ${shortId(idOf(message.sender))}`, kind: message.kind,
  });
  events.sort((a, b) => b.at - a.at || a.title.localeCompare(b.title));
  if (!events.length) put(section, empty('No tasks or messages in this run yet.'));
  else {
    const list = node('div', 'timeline');
    for (const event of events.slice(0, 100)) {
      const row = node('article', 'event');
      put(row, node('span', `event-mark ${event.kind}`), node('div', 'event-body'));
      const body = row.lastElementChild as HTMLElement;
      const first = node('div', 'event-top');
      put(first, node('strong', '', event.title), node('time', 'muted small', when(new Date(event.at))));
      put(body, first, node('p', '', event.detail), node('span', 'muted small', event.actor));
      put(list, row);
    }
    put(section, list);
  }
  return section;
}

function evidenceItem(id: string, sources: Map<string, Source>, facts: Map<string, Fact>, observations: Map<string, { symbol: string; bidPrice: string; askPrice: string; feed: string }>): HTMLElement {
  const source = sources.get(id);
  if (source) {
    const item = node('div', 'evidence-row');
    put(item, pill(source.kind), link(`${source.symbol} · ${shortId(source.id)}`, source.uri), node('span', 'muted small', when(source.asOf)));
    return item;
  }
  const fact = facts.get(id);
  if (fact) {
    const item = node('div', 'evidence-row');
    put(item, pill('fact'), node('span', '', `${fact.metric}: ${fact.value} ${fact.unit}`),
      sources.get(fact.sourceId) ? link('Filing ↗', sources.get(fact.sourceId)!.uri) : node('span', 'muted small', shortId(fact.sourceId)));
    return item;
  }
  const quote = observations.get(id);
  if (quote) {
    const item = node('div', 'evidence-row');
    put(item, pill('quote'), node('span', '', `${quote.symbol} ${quote.feed}: ${quote.bidPrice} / ${quote.askPrice}`));
    return item;
  }
  return node('div', 'evidence-row muted', `Reference ${id} is not visible to this identity`);
}

function research(conn: DbConnection, run: Run): HTMLElement {
  const section = panel('Research & decisions', 'Evidence stays linked to the decision it supported');
  const sources = new Map(all(conn.db.mySource.iter()).filter(row => row.runId === run.id).map(row => [row.id, row]));
  const facts = new Map(all(conn.db.myFact.iter()).filter(row => sources.has(row.sourceId)).map(row => [row.id, row]));
  const observations = new Map(all(conn.db.myMarketObservation.iter()).map(row => [row.id, row]));
  const theses = all(conn.db.myThesis.iter()).filter(row => row.runId === run.id).sort((a, b) => millis(b.createdAt) - millis(a.createdAt));
  if (!theses.length) { put(section, empty('No thesis has been published for this run.')); return section; }
  const list = node('div', 'cards');
  for (const thesis of theses.slice(0, 30)) put(list, thesisCard(conn, thesis, sources, facts, observations));
  put(section, list);
  return section;
}

function thesisCard(conn: DbConnection, thesis: Thesis, sources: Map<string, Source>, facts: Map<string, Fact>, observations: Map<string, { symbol: string; bidPrice: string; askPrice: string; feed: string }>): HTMLElement {
  const card = node('article', 'research-card');
  const head = node('div', 'card-head');
  put(head, node('div', '', thesis.symbol), pill(shortId(thesis.id), 'neutral'), node('time', 'muted small', when(thesis.createdAt)));
  put(card, head);
  const cases = node('div', 'case-grid');
  const bull = node('div', 'case bull'); put(bull, node('h3', '', 'Bull case'), node('p', '', thesis.bullCase));
  const bear = node('div', 'case bear'); put(bear, node('h3', '', 'Bear case'), node('p', '', thesis.bearCase));
  put(cases, bull, bear);
  put(card, cases, field('Assumptions', thesis.assumptions), field('Invalidation', thesis.invalidation));
  const challenge = all(conn.db.myMessage.iter()).find((message: Message) => message.kind === 'challenge' && splitRefs(message.evidenceRef).includes(thesis.id));
  if (challenge) put(card, field('Skeptic challenge', challenge.body));
  const decision = all(conn.db.myDecision.iter()).find((row: Decision) => row.thesisId === thesis.id);
  if (decision) {
    const block = node('div', 'decision-block');
    put(block, pill(decision.outcome, decision.outcome), node('p', '', decision.rationale), node('span', 'muted small', `Recorded ${when(decision.createdAt)}`));
    const frozen = all(conn.db.myDecisionInput.iter()).find(row => row.id === decision.id);
    if (frozen) put(block, field('Frozen inputs', `Quote ${frozen.quoteId || 'none'} · critiques ${frozen.critiqueRefs || 'none'} · model ${frozen.model} · policy ${frozen.policyVersion || 'none'}`));
    put(card, block);
  }
  const refs = splitRefs(thesis.evidenceRefs);
  const details = node('details', 'evidence-details');
  put(details, node('summary', '', `Cited evidence · ${refs.length} references`));
  for (const ref of refs) put(details, evidenceItem(ref, sources, facts, observations));
  put(card, details);
  return card;
}

function riskOrders(conn: DbConnection, run: Run): HTMLElement {
  const section = panel('Risk & execution', 'A submitted order is separate from a fill');
  const proposals = all(conn.db.myTradeProposal.iter()).filter(row => row.runId === run.id).sort((a, b) => millis(b.createdAt) - millis(a.createdAt));
  if (!proposals.length) { put(section, empty('No trade proposals in this run.')); return section; }
  const list = node('div', 'cards');
  for (const proposal of proposals.slice(0, 40)) {
    const card = node('article', 'order-card');
    const head = node('div', 'card-head');
    put(head, node('strong', '', `${proposal.side.toUpperCase()} ${proposal.quantity} ${proposal.symbol}`), pill(proposal.status, proposal.status));
    put(card, head, field('Proposal', proposal.id), field('Order type', `${proposal.orderType}${proposal.limitPrice ? ` @ ${proposal.limitPrice}` : ''}`));
    const risk = all(conn.db.myRiskDecision.iter()).find(row => row.proposalId === proposal.id);
    if (risk) {
      put(card, field('Risk verdict', pill(`${risk.outcome} · ${risk.policyVersion}`, risk.outcome)), field('Expires', when(risk.expiresAt)));
      const checks = array(json(risk.checks));
      if (checks.length) {
        const checkList = node('div', 'checks');
        for (const check of checks) {
          const item = node('div', 'check');
          put(item, pill(check.pass === true ? 'PASS' : 'FAIL', check.pass === true ? 'pass' : 'reject'),
            node('strong', '', String(check.name ?? check.key ?? 'check')),
            node('span', 'muted small', String(check.detail ?? check.reason ?? '')));
          put(checkList, item);
        }
        put(card, checkList);
      }
    }
    const order = all(conn.db.myPaperOrder.iter()).find(row => row.proposalId === proposal.id);
    if (order) put(card, orderDetail(conn, order));
    else put(card, node('p', 'muted small', 'No paper order reserved yet.'));
    put(list, card);
  }
  put(section, list);
  return section;
}

function orderDetail(conn: DbConnection, order: PaperOrder): HTMLElement {
  const box = node('div', 'order-detail');
  put(box, field('Paper order', `${order.status} · ${order.clientOrderId}`), field('Alpaca ID', order.alpacaOrderId || 'Not assigned'));
  const request = all(conn.db.myOrderCancelRequest.iter()).find(row => row.orderId === order.id);
  if (request) {
    put(box, field('Cancellation', `${request.status} · ${request.reason}${request.detail ? ` · ${request.detail}` : ''}`));
  } else if (order.alpacaOrderId && !['filled', 'canceled', 'expired', 'rejected', 'replaced'].includes(order.status)) {
    const cancel = node('button', 'ghost-button', 'Request cancellation');
    cancel.type = 'button';
    cancel.addEventListener('click', () => {
      cancel.disabled = true;
      void conn.reducers.requestOrderCancel({ orderId: order.id, reason: 'Requested from operator dashboard' })
        .catch(error => notice(`Could not request cancellation: ${String(error)}`))
        .finally(() => { cancel.disabled = false; });
    });
    put(box, cancel);
  }
  const fills = all(conn.db.myFill.iter()).filter(row => row.orderId === order.id);
  for (const fill of fills) put(box, field('Fill', `${fill.quantity} @ ${fill.price} · ${when(fill.filledAt)} · ${fill.alpacaActivityId}`));
  return box;
}

function accountPanel(conn: DbConnection, account?: AccountSnapshot): HTMLElement {
  const section = panel('Paper account', account ? `Snapshot ${when(account.capturedAt)}` : 'Account access is granted separately');
  if (!account) { put(section, empty('No account snapshot is visible for this run. Grant this identity account access, then ingest a paper account snapshot.')); return section; }
  const info = node('div', 'account-grid');
  for (const [label, value] of [['Status', account.accountStatus], ['Cash', account.cash], ['Buying power', account.buyingPower], ['Equity', account.equity]]) {
    put(info, field(label, value));
  }
  put(section, info);
  const positions = array(json(account.positionsJson));
  put(section, node('h3', 'subhead', `Positions · ${positions.length}`));
  if (!positions.length) put(section, empty('No positions in this snapshot.'));
  for (const p of positions) put(section, field(String(p.symbol ?? 'Unknown'), `${p.qty ?? '—'} shares · value ${p.market_value ?? '—'}`));
  const openOrders = array(json(account.openOrdersJson));
  put(section, node('h3', 'subhead', `Broker open orders · ${openOrders.length}`));
  if (!openOrders.length) put(section, empty('No open broker orders in this snapshot.'));
  for (const order of openOrders) put(section, field(String(order.symbol ?? 'Unknown'), `${order.side ?? '—'} ${order.qty ?? order.notional ?? '—'} · ${order.status ?? '—'}`));
  const reconciliations = all(conn.db.myReconciliation.iter()).filter(row => row.accountId === account.accountId)
    .sort((a, b) => millis(b.capturedAt) - millis(a.capturedAt));
  put(section, node('h3', 'subhead', 'Reconciliation'));
  if (!reconciliations.length) put(section, empty('No reconciliation record is visible.'));
  for (const row of reconciliations.slice(0, 5)) put(section, field(`${row.status} · ${when(row.capturedAt)}`, row.details));
  return section;
}


function render(): void {
  if (!connection || !ready) { connectionScreen(); return; }
  const conn = connection;
  const me = all(conn.db.myAgent.iter()).find(row => idOf(row.identity) === identity);
  if (me?.role !== 'operator') {
    state = me ? `Role ${me.role} cannot open the operator console.` : 'Connected. Waiting for an operator grant.';
    connectionScreen();
    return;
  }
  const runs = all(conn.db.myRun.iter()).sort((a, b) => millis(b.createdAt) - millis(a.createdAt));
  if (!runs.some(run => run.id === selectedRun)) selectedRun = runs[0]?.id ?? '';
  const layout = node('div', 'layout');
  put(layout, sidebar(runs));
  const main = node('main', 'main');
  if (!runs.length) {
    put(main, node('p', 'eyebrow', 'PAPER CONSOLE'), node('h1', '', 'No runs yet'), empty('Create a run with the operator CLI. It will appear here as soon as the subscription updates.'));
    put(layout, main); root!.replaceChildren(layout); return;
  }
  const run = runs.find(row => row.id === selectedRun)!;
  const config = all(conn.db.myRunConfig.iter()).find(row => row.runId === run.id);
  const policy = all(conn.db.myRiskPolicy.iter()).find(row => row.id === config?.policyId);
  const account = all(conn.db.myAccountSnapshot.iter()).filter(row => row.accountId === policy?.accountId)
    .sort((a, b) => millis(b.capturedAt) - millis(a.capturedAt))[0];
  const roles = new Map(all(conn.db.myAgentDirectory.iter()).map(agent => [idOf(agent.identity), agent.role]));
  const header = node('header', 'page-head');
  const title = node('div', 'title');
  put(title, node('p', 'eyebrow', 'RUN OVERVIEW'), node('h1', '', run.id), node('p', 'muted', run.goal));
  const controls = node('div', 'controls');
  const developmentLink = node('a', 'ghost-button', 'Development board ↗');
  developmentLink.href = 'http://127.0.0.1:4174';
  put(controls, developmentLink);
  const target = run.status === 'active' ? 'paused' : 'active';
  const statusButton = node('button', 'primary-button', run.status === 'active' ? 'Pause run' : 'Resume run');
  statusButton.type = 'button';
  statusButton.disabled = run.status === 'closed';
  statusButton.addEventListener('click', () => {
    statusButton.disabled = true;
    void conn.reducers.setRunStatus({ id: run.id, status: target }).catch(error => {
      notice(`Could not ${target === 'paused' ? 'pause' : 'resume'} run: ${String(error)}`);
    }).finally(() => { statusButton.disabled = false; });
  });
  put(controls, statusButton);
  put(header, title, controls);
  put(main, header);
  put(main, summary(conn, run, account));
  if (state.startsWith('Could not')) put(main, node('p', 'error', state));
  const columns = node('div', 'columns');
  const primary = node('div', 'column');
  put(primary, timeline(conn, run, roles), research(conn, run));
  const secondary = node('div', 'column');
  put(secondary, riskOrders(conn, run), accountPanel(conn, account));
  put(columns, primary, secondary);
  put(main, columns);
  put(layout, main);
  root!.replaceChildren(layout);
}

function reconnect(reason: unknown, current: number): void {
  if (current !== generation || retryTimer !== undefined) return;
  ready = false;
  connection = undefined;
  state = `Connection interrupted: ${String(reason)}. Reconnecting…`;
  queueRender();
  const delay = Math.min(30_000, 1000 * 2 ** Math.min(retryCount++, 5));
  retryTimer = window.setTimeout(() => { retryTimer = undefined; connect(); }, delay);
}

function connect(): void {
  const current = ++generation;
  ready = false;
  let token: string | undefined;
  try { token = localStorage.getItem(TOKEN_KEY) ?? undefined; } catch { /* Browser storage may be disabled. */ }
  connection = DbConnection.builder()
    .withUri(HOST)
    .withDatabaseName(DATABASE)
    .withToken(token)
    .onConnect((conn, assignedIdentity, assignedToken) => {
      if (current !== generation) { conn.disconnect(); return; }
      retryCount = 0;
      identity = idOf(assignedIdentity);
      try { localStorage.setItem(TOKEN_KEY, assignedToken); } catch { /* The session remains usable until reload. */ }
      connection = conn;
      state = 'Connected. Loading scoped operator views…';
      queueRender();
      for (const view of [conn.db.myAgent, conn.db.myAgentDirectory, conn.db.myRun, conn.db.myRunConfig,
        conn.db.myRiskPolicy, conn.db.myTask, conn.db.myMessage, conn.db.mySource, conn.db.myFact,
        conn.db.myMarketObservation, conn.db.myThesis, conn.db.myDecision, conn.db.myDecisionInput,
        conn.db.myTradeProposal, conn.db.myRiskDecision, conn.db.myPaperOrder, conn.db.myOrderCancelRequest, conn.db.myFill,
        conn.db.myAccountSnapshot, conn.db.myReconciliation]) {
        view.onInsert(queueRender); view.onUpdate(queueRender); view.onDelete(queueRender);
      }
      conn.subscriptionBuilder()
        .onApplied(() => { if (current === generation) { ready = true; state = 'Live'; queueRender(); } })
        .onError(error => { conn.disconnect(); reconnect(error, current); })
        .subscribe([
          'SELECT * FROM my_agent', 'SELECT * FROM my_agent_directory', 'SELECT * FROM my_run',
          'SELECT * FROM my_run_config', 'SELECT * FROM my_risk_policy', 'SELECT * FROM my_task',
          'SELECT * FROM my_message', 'SELECT * FROM my_source', 'SELECT * FROM my_fact',
          'SELECT * FROM my_market_observation', 'SELECT * FROM my_thesis', 'SELECT * FROM my_decision',
          'SELECT * FROM my_decision_input', 'SELECT * FROM my_trade_proposal', 'SELECT * FROM my_risk_decision',
          'SELECT * FROM my_paper_order', 'SELECT * FROM my_order_cancel_request', 'SELECT * FROM my_fill', 'SELECT * FROM my_account_snapshot',
          'SELECT * FROM my_reconciliation',
        ]);
    })
    .onConnectError((_ctx, error) => reconnect(error, current))
    .onDisconnect((_ctx, error) => reconnect(error, current))
    .build();
}

connectionScreen();
connect();

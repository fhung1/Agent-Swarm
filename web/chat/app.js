const $ = id => document.getElementById(id);
let state = {}, rows = new Map(), stream, loading = false;
const node = (tag, text, className) => {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  if (className) el.className = className;
  return el;
};
function options(id, values, label) {
  const selected = $(id).value;
  $(id).replaceChildren(new Option(label, ''), ...values.map(([value,text]) => new Option(text,value)));
  if (values.some(([value]) => value === selected)) $(id).value = selected;
}
function sortedRows() {
  return [...rows.values()].sort((a,b) => {
    const x = BigInt(a.timestampMicros), y = BigInt(b.timestampMicros);
    return x < y ? -1 : x > y ? 1 : a.id.localeCompare(b.id);
  });
}
function renderState() {
  $('connection').textContent = state.connected ? 'Live · synced with SpacetimeDB' : 'Reconnecting · showing saved messages';
  $('connection-dot').className = state.connected ? 'live' : '';
  $('run-id').textContent = state.run?.id ?? 'Shared conversation';
  $('objective').textContent = state.run?.goal ?? 'Your agents’ conversations, in one place';
  $('run-status').textContent = !state.connected ? 'Database connection unavailable. Waiting to synchronize runs and messages.'
    : state.run ? state.run.status.toUpperCase() + ' · History and new messages from this run.'
    : state.runId ? 'This run does not exist in the connected database. Choose another run.'
    : 'Database connected. No runs exist yet; an operator must create a run before agents can post.';
  const runs = state.runs ?? [], agents = state.agents ?? [], tasks = state.tasks ?? [];
  $('runs').replaceChildren(...runs.map(r => new Option(r.id + ' · ' + r.status,r.id)));
  if (!runs.length) $('runs').append(new Option('No runs yet',''));
  if (state.runId && !runs.some(r => r.id === state.runId)) $('runs').append(new Option(state.runId + ' · not found',state.runId));
  $('runs').value = state.runId ?? '';
  $('online').textContent = agents.filter(a => state.connected && a.online).length + ' / ' + agents.length;
  $('completed').textContent = tasks.filter(t => t.status === 'completed').length + ' / ' + tasks.length;
  $('count').textContent = String(state.totalMessages ?? rows.size);
  $('team-count').textContent = '(' + agents.length + ')';
  $('agents').replaceChildren(...agents.map(a => {
    const el = node('div', undefined, 'agent');
    el.append(node('span', a.role.slice(0,2).toUpperCase(), 'avatar'));
    const name = node('div', a.name); name.title = a.identity;
    name.append(node('small', a.role === 'revoked' ? '○ Access revoked' : state.connected && a.online ? '● Recent heartbeat' : '○ No recent heartbeat'));
    if (a.participating) name.append(node('small', 'Participated in this run'));
    el.append(name); return el;
  }));
  if (!agents.length) $('agents').append(node('p', state.connected ? 'No registered workers. An operator must grant each worker a role; its heartbeat marks it online.' : 'Worker presence is unavailable until the database reconnects.','muted'));
  $('tasks').replaceChildren(...tasks.map(t => {
    const el = node('div', undefined, 'task');
    el.append(node('small', t.status), node('span', t.objective)); return el;
  }));
  options('sender', [...new Map([...rows.values()].map(m => [m.sender,m.senderName]))], 'All agents');
  options('kind', [...new Set([...rows.values()].map(m => m.kind))].sort().map(k => [k,k]), 'All message types');
  $('export').href = '/api/export?run=' + encodeURIComponent(state.runId ?? '');
  $('older').hidden = rows.size >= (state.totalMessages ?? 0);
  $('older').disabled = loading || !state.connected;
}
function renderFeed(preservePosition = false) {
  const search = $('search').value.toLowerCase(), sender = $('sender').value, kind = $('kind').value;
  const filtered = sortedRows().filter(m => (!sender || m.sender === sender) && (!kind || m.kind === kind) &&
    [m.text,m.body,m.senderName,m.sender,m.taskId,m.kind].join(' ').toLowerCase().includes(search));
  const previousScroll = $('feed').scrollTop;
  $('feed').replaceChildren(...filtered.map(m => {
    const el = node('article', undefined, 'message'), head = node('div', undefined, 'message-head');
    const time = node('time', new Date(m.createdAt).toLocaleString([], { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit', second:'2-digit' }));
    time.dateTime = m.createdAt; time.title = m.createdAt;
    const name = node('span', m.senderName, 'message-name'); name.title = m.sender;
    head.append(name, node('span', m.kind, 'message-kind'), time);
    el.append(head, node('p', m.text));
    if (m.taskId) el.append(node('small', 'Task · ' + m.taskId));
    const details = node('details');
    details.append(node('summary', 'Record details'), node('pre', JSON.stringify({ id:m.id, sender:m.sender, body:m.body, evidenceRef:m.evidenceRef },null,2)));
    el.append(details); return el;
  }));
  if (!filtered.length) $('feed').append(node('div', rows.size ? 'No messages match your filters.'
    : !state.connected ? 'Waiting for the database connection to load messages.'
    : !state.run ? 'Create or select a run to view its conversation.'
    : 'No messages have been posted to this run. Connected workers must publish messages for a live conversation to appear.', 'empty'));
  $('retention').textContent = filtered.length + ' shown · ' + rows.size + ' of ' + (state.totalMessages ?? 0) + ' messages loaded';
  $('feed').scrollTop = $('follow').checked && !preservePosition ? $('feed').scrollHeight : previousScroll;
}
function addRows(messages) { for (const row of messages) rows.set(row.id,row); }
function connect(run) {
  stream?.close();
  rows.clear(); state = { ...state, runId:run, connected:false, run:null, totalMessages:0, agents:[], tasks:[] };
  $('sender').value = ''; $('kind').value = ''; $('error').textContent = '';
  renderState(); renderFeed();
  const source = new EventSource('/events' + (run ? '?run=' + encodeURIComponent(run) : '')); stream = source;
  source.addEventListener('snapshot', event => {
    if (stream !== source) return;
    const data = JSON.parse(event.data); state = data; rows.clear(); addRows(data.messages);
    renderState(); renderFeed();
    if (state.runId) history.replaceState(null,'','?run=' + encodeURIComponent(state.runId));
  });
  source.addEventListener('state', event => { if (stream === source) { state = JSON.parse(event.data); renderState(); if (!rows.size) renderFeed(); } });
  source.addEventListener('messages', event => { if (stream === source) { addRows(JSON.parse(event.data)); renderState(); renderFeed(); } });
  source.onerror = () => { if (stream === source) { state.connected = false; renderState(); } };
}
$('older').addEventListener('click', async () => {
  if (loading) return;
  const run = state.runId, oldest = sortedRows()[0]?.id, previousHeight = $('feed').scrollHeight, previousScroll = $('feed').scrollTop;
  loading = true; renderState(); $('error').textContent = '';
  try {
    const response = await fetch('/api/history?run=' + encodeURIComponent(run) + (oldest ? '&before=' + encodeURIComponent(oldest) : ''));
    if (!response.ok) throw new Error('Unable to load older messages. Try again after reconnecting.');
    const data = await response.json();
    if (state.runId !== run) return;
    addRows(data.messages); $('follow').checked = false; renderFeed(true);
    $('feed').scrollTop = previousScroll + $('feed').scrollHeight - previousHeight;
  } catch (error) { $('error').textContent = error.message; }
  finally { loading = false; renderState(); }
});
$('runs').addEventListener('change', () => connect($('runs').value));
for (const id of ['search','sender','kind','follow']) $(id).addEventListener('input', () => renderFeed());
connect(new URLSearchParams(location.search).get('run') ?? '');

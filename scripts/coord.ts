#!/usr/bin/env node
// Development coordination CLI for coding sessions sharing this repo. See "Dev coordination" in AGENTS.md.
// Usage: node scripts/coord.ts <command> [args] --as <session-name>   (or set COORD_AS)
import { execFileSync, spawn } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';

const SERVER = process.env.COORD_SERVER ?? 'local';
const DB = process.env.COORD_DB ?? 'quant-swarm-coord';
const CLI = process.env.SPACETIME_CLI ?? 'spacetime';
const ENV = { ...process.env, PATH: `${process.env.PATH ?? ''}:${path.join(os.homedir(), '.local', 'bin')}` };

const HELP = `Dev coordination board (database ${DB} on ${SERVER}).
Identify yourself with --as <name> or COORD_AS=<name> (lowercase, e.g. claude-risk, codex, quant-swarm-84).

  register <claude|codex|human|other> [focus]   Join the board or update your focus
  status                                        Sessions, active tasks, locks, and recent messages
  post <message> [--to NAME] [--task ID]        Broadcast, or message one session
  inbox [--since MSG_ID] [--limit N]            Messages to you or everyone (default last 20)
  tasks [--all]                                 Active tasks (--all includes done and cancelled)
  add <id> <title> [--details D] [--area A] [--after TASK_ID]
  claim <id>                                    Atomically take an open task
  done <id> [result] | block <id> <why> | release <id> [note] | cancel <id> [note]
  lock <path>... [--task ID] [--reason R] [--minutes 120]   Lock files or dirs/ before editing
  unlock <path>...
  locks                                         Active locks
  watch                                         Stream new messages, task changes, and locks (runs until stopped)`;

type Row = Record<string, unknown>;
type Update = Record<string, { inserts: Row[]; deletes: Row[] }>;

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) flags[key] = true;
    else { flags[key] = next; i++; }
  }
  return { positional, flags };
}

const { positional, flags } = parseArgs(process.argv.slice(2));
const [command, ...rest] = positional;
const flag = (name: string) => (typeof flags[name] === 'string' ? flags[name] as string : undefined);

function me(): string {
  const name = flag('as') ?? process.env.COORD_AS;
  if (!name) fail('Say who you are with --as <name> or COORD_AS=<name>.');
  return name!;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function cliError(error: unknown): string {
  const stderr = String((error as { stderr?: Buffer }).stderr ?? error);
  // Reducer refusals arrive as "Error: Response text: <reason>" followed by HTTP details.
  const reason = /Response text: (.*)/.exec(stderr)?.[1];
  if (reason) return `Refused: ${reason}`;
  return stderr.split('\n').filter(line => line.trim() && !line.includes('UNSTABLE')).slice(0, 3).join('\n');
}

// Reducer arguments go through as JSON strings so text that looks like JSON stays text.
function call(reducer: string, ...args: (string | number)[]): void {
  try {
    execFileSync(CLI, ['call', '--server', SERVER, DB, reducer, ...args.map(a => JSON.stringify(a))],
      { env: ENV, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    fail(cliError(error));
  }
}

function snapshot(...queries: string[]): Update {
  try {
    const out = execFileSync(CLI, ['subscribe', '--server', SERVER, DB, ...queries, '--print-initial-update', '-n', '0', '--yes'],
      { env: ENV, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
    const line = out.split('\n').find(l => l.startsWith('{'));
    return line ? JSON.parse(line) as Update : {};
  } catch (error) {
    fail(cliError(error));
  }
}

const rows = (update: Update, table: string) => update[table]?.inserts ?? [];
const micros = (value: unknown) => Number((value as { __timestamp_micros_since_unix_epoch__: number }).__timestamp_micros_since_unix_epoch__);

function ago(value: unknown): string {
  const seconds = Math.round((Date.now() - micros(value) / 1000) / 1000);
  if (seconds < 0) return `in ${until(value)}`;
  if (seconds < 90) return `${seconds}s ago`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

function until(value: unknown): string {
  const minutes = Math.round((micros(value) / 1000 - Date.now()) / 60_000);
  return minutes <= 0 ? 'expired' : minutes < 90 ? `${minutes}m` : `${Math.round(minutes / 60)}h`;
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function formatMessage(m: Row): string {
  const to = m.recipient ? ` → ${m.recipient}` : '';
  const task = m.task_id ? ` [${m.task_id}]` : '';
  return `#${m.id} ${m.sender}${to}${task} (${ago(m.created_at)}): ${m.body}`;
}

function formatTask(t: Row): string {
  const who = t.assignee ? ` @${t.assignee}` : '';
  const after = t.depends_on ? ` after ${t.depends_on}` : '';
  const area = t.area ? `  area: ${t.area}` : '';
  const result = t.result ? `\n      ${t.result}` : '';
  return `${t.id} [${t.status}${who}]${after} ${t.title}${area}${result}`;
}

function formatLock(l: Row): string {
  return `${l.path}  ${l.holder}${l.task_id ? ` [${l.task_id}]` : ''}, expires in ${until(l.expires_at)}${l.reason ? ` — ${l.reason}` : ''}`;
}

function liveLocks(update: Update): Row[] {
  return rows(update, 'file_lock').filter(l => micros(l.expires_at) / 1000 > Date.now()).sort((a, b) => String(a.path).localeCompare(String(b.path)));
}

function myMessages(name: string, since = 0n): string {
  return `SELECT * FROM dev_message WHERE (recipient = ${sqlString(name)} OR recipient = '') AND id > ${since}`;
}

function printSection(title: string, lines: string[]): void {
  console.log(`\n${title}`);
  console.log(lines.length ? lines.map(l => `  ${l}`).join('\n') : '  (none)');
}

function status(): void {
  const name = flag('as') ?? process.env.COORD_AS;
  const update = snapshot('SELECT * FROM session', 'SELECT * FROM dev_task', 'SELECT * FROM file_lock',
    name ? myMessages(name) : "SELECT * FROM dev_message WHERE recipient = ''");
  const sessions = rows(update, 'session').sort((a, b) => micros(b.last_seen) - micros(a.last_seen));
  printSection('Sessions', sessions.map(s => `${s.name} (${s.tool}, seen ${ago(s.last_seen)})${s.focus ? `: ${s.focus}` : ''}`));
  const active = rows(update, 'dev_task').filter(t => ['open', 'claimed', 'blocked'].includes(String(t.status)));
  printSection('Active tasks', active.sort((a, b) => String(a.id).localeCompare(String(b.id))).map(formatTask));
  printSection('Locks', liveLocks(update).map(formatLock));
  const messages = rows(update, 'dev_message').sort((a, b) => Number(a.id) - Number(b.id)).slice(-10);
  printSection(name ? `Recent messages for ${name}` : 'Recent broadcasts', messages.map(formatMessage));
}

function watch(): void {
  const name = me();
  const child = spawn(CLI, ['subscribe', '--server', SERVER, DB, 'SELECT * FROM dev_message', 'SELECT * FROM dev_task',
    'SELECT * FROM file_lock', '--yes'], { env: ENV, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    for (const line of chunk.split('\n')) if (line.trim() && !line.includes('UNSTABLE')) console.error(line);
  });
  console.log(`Watching ${DB} as ${name}. New messages, task changes, and lock changes appear below.`);
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let index: number;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.startsWith('{')) continue;
      const update = JSON.parse(line) as Update;
      for (const m of rows(update, 'dev_message')) {
        if (m.sender !== name && (m.recipient === '' || m.recipient === name)) console.log(`MESSAGE ${formatMessage(m)}`);
      }
      const removed = new Set((update.dev_task?.deletes ?? []).map(t => t.id));
      for (const t of rows(update, 'dev_task')) console.log(`TASK ${removed.has(t.id) ? 'updated' : 'added'}: ${formatTask(t)}`);
      const replaced = new Set(rows(update, 'file_lock').map(l => l.path));
      for (const l of rows(update, 'file_lock')) if (l.holder !== name) console.log(`LOCK ${formatLock(l)}`);
      for (const l of update.file_lock?.deletes ?? []) if (!replaced.has(l.path) && l.holder !== name) console.log(`UNLOCK ${l.path} (was ${l.holder})`);
    }
  });
  child.on('exit', code => { console.log(`Watch ended (exit ${code}).`); process.exit(code ?? 1); });
  process.on('SIGINT', () => child.kill('SIGINT'));
}

switch (command) {
  case 'register': {
    const [tool, ...focus] = rest;
    if (!tool) fail('register needs a tool: claude, codex, human, or other');
    call('register', me(), tool, focus.join(' '));
    console.log(`Registered ${me()} (${tool}).`);
    break;
  }
  case 'status': status(); break;
  case 'post': {
    if (!rest.length) fail('post needs a message');
    call('post', me(), flag('to') ?? '', flag('task') ?? '', rest.join(' '));
    console.log('Posted.');
    break;
  }
  case 'inbox': {
    const since = BigInt(flag('since') ?? '0');
    const limit = Number(flag('limit') ?? '20');
    const messages = rows(snapshot(myMessages(me(), since)), 'dev_message').sort((a, b) => Number(a.id) - Number(b.id));
    console.log(messages.slice(-limit).map(formatMessage).join('\n') || '(no messages)');
    break;
  }
  case 'tasks': {
    const all = rows(snapshot('SELECT * FROM dev_task'), 'dev_task')
      .filter(t => flags.all || ['open', 'claimed', 'blocked'].includes(String(t.status)))
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));
    console.log(all.map(formatTask).join('\n') || '(no tasks)');
    break;
  }
  case 'add': {
    const [id, ...title] = rest;
    if (!id || !title.length) fail('add needs <id> <title>');
    call('create_task', me(), id, title.join(' '), flag('details') ?? '', flag('area') ?? '', flag('after') ?? '');
    console.log(`Added ${id}.`);
    break;
  }
  case 'claim': {
    if (!rest[0]) fail('claim needs a task id');
    call('claim_task', me(), rest[0]);
    console.log(`Claimed ${rest[0]}.`);
    break;
  }
  case 'done': case 'block': case 'release': case 'cancel': {
    const [id, ...note] = rest;
    if (!id) fail(`${command} needs a task id`);
    if (command === 'block' && !note.length) fail('block needs a reason');
    const status = { done: 'done', block: 'blocked', release: 'open', cancel: 'cancelled' }[command];
    call('update_task', me(), id, status, note.join(' '));
    console.log(`${id} → ${status}.`);
    break;
  }
  case 'lock': {
    if (!rest.length) fail('lock needs at least one path');
    const minutes = Number(flag('minutes') ?? '120');
    for (const p of rest) call('lock', me(), p, flag('task') ?? '', flag('reason') ?? '', minutes);
    console.log(`Locked ${rest.join(', ')} for ${minutes}m.`);
    break;
  }
  case 'unlock': {
    if (!rest.length) fail('unlock needs at least one path');
    for (const p of rest) call('unlock', me(), p);
    console.log(`Unlocked ${rest.join(', ')}.`);
    break;
  }
  case 'locks': console.log(liveLocks(snapshot('SELECT * FROM file_lock')).map(formatLock).join('\n') || '(no locks)'); break;
  case 'watch': watch(); break;
  default: console.log(HELP);
}

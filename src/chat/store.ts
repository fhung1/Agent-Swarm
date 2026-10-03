import type { DbConnection } from '../module_bindings/index.js';

export interface ChatMessage {
  id: string; runId: string; taskId: string; sender: string; senderName: string;
  kind: string; body: string; text: string; evidenceRef: string; createdAt: string; timestampMicros: string;
}
export function projectDatabase(connection: DbConnection) {
  const agents = [...connection.db.myAgentDirectory.iter()];
  const names = new Map(agents.map(a => [a.identity.toHexString(), `${a.role} · ${a.identity.toHexString().slice(0, 12)}`]));
  const messages: ChatMessage[] = [...connection.db.myMessage.iter()].map(m => {
    let text = m.body;
    try {
      const payload = JSON.parse(m.body);
      if (payload && typeof payload === 'object') {
        const summary = payload.text ?? payload.body ?? payload.summary;
        if (typeof summary === 'string') text = summary;
      }
    } catch { /* Existing messages may be plain text. */ }
    const sender = m.sender.toHexString();
    return { id: m.id, runId: m.runId, taskId: m.taskId, sender, senderName: names.get(sender) ?? sender.slice(0, 12),
      kind: m.kind, body: m.body, text, evidenceRef: m.evidenceRef,
      createdAt: new Date(Number(m.createdAt.microsSinceUnixEpoch / 1000n)).toISOString(), timestampMicros: m.createdAt.microsSinceUnixEpoch.toString() };
  }).sort((a,b) => {
    const x = BigInt(a.timestampMicros), y = BigInt(b.timestampMicros);
    return x < y ? -1 : x > y ? 1 : a.id.localeCompare(b.id);
  });
  return {
    messages,
    runs: [...connection.db.myRun.iter()].sort((a,b) => a.createdAt.microsSinceUnixEpoch > b.createdAt.microsSinceUnixEpoch ? -1 : 1)
      .map(r => ({ id: r.id, goal: r.goal, status: r.status })),
    agents: agents.map(a => ({ identity: a.identity.toHexString(), name: names.get(a.identity.toHexString())!, role: a.role, status: a.status,
      lastSeen: Number(a.lastSeen.microsSinceUnixEpoch / 1000n) })),
    tasks: [...connection.db.myTask.iter()].map(t => ({ id: t.id, runId: t.runId, objective: t.objective, status: t.status, result: t.result, assignee: t.assignee?.toHexString() })),
  };
}
export type DatabaseSnapshot = ReturnType<typeof projectDatabase>;
export const emptyDatabase = (): DatabaseSnapshot => ({ messages: [], runs: [], agents: [], tasks: [] });
export function selectRun(database: DatabaseSnapshot, requestedRun: string, connected: boolean, now = Date.now()) {
  const runId = requestedRun || database.runs.find(r => r.status === 'active')?.id || database.runs[0]?.id || '';
  const messages = database.messages.filter(m => m.runId === runId);
  const tasks = database.tasks.filter(t => t.runId === runId);
  const participants = new Set([...messages.map(m => m.sender), ...tasks.map(t => t.assignee).filter(Boolean)]);
  return { runId, connected, run: database.runs.find(r => r.id === runId) ?? null, runs: database.runs,
    tasks, totalMessages: messages.length, messages,
    agents: database.agents.map(a => ({ ...a, participating: participants.has(a.identity),
      online: connected && a.role !== 'revoked' && a.status === 'online' && now - a.lastSeen < 45_000 })),
  };
}

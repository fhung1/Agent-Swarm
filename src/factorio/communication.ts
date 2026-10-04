/** Coordination is actionable team communication; activity remains in the audit log. */
export function isCoordinationKind(kind: string): boolean {
  return ['chat', 'completion', 'goal_completion', 'subtask', 'resource_request', 'claim_subtask', 'finish_subtask', 'orchestrator_task'].includes(kind);
}
export function isUsefulPeerEvent(kind: string, payload: unknown): boolean {
  if (isCoordinationKind(kind)) return true;
  if (kind !== 'action_result' || !payload || typeof payload !== 'object') return false;
  const receipt = payload as {status?: string; item?: string; targetId?: number};
  return receipt.status === 'failed' || Boolean(receipt.item) || Boolean(receipt.targetId);
}
/** Suppress an unchanged announcement to the same recipient across restarts. */
export function repeatsLatestChat(rows: readonly {sender: string; recipient: string; body: string; id: bigint | string | number}[],
  scope: {sender: string; runId: string; worldId: string; historyId: string}, recipient: string, text: string): boolean {
  let latest: {id: bigint; text: string} | undefined;
  for (const row of rows) {
    if (row.sender !== scope.sender || row.recipient !== recipient) continue;
    try {
      const body = JSON.parse(row.body);
      if (body.kind !== 'chat' || body.runId !== scope.runId || body.worldId !== scope.worldId || body.historyId !== scope.historyId || typeof body.payload?.text !== 'string') continue;
      const id = BigInt(row.id);
      if (!latest || id > latest.id) latest = {id, text: body.payload.text};
    } catch { /* Human messages are not structured actor announcements. */ }
  }
  const normalize = (value: string) => value.trim().replace(/\s+/g, ' ').toLowerCase();
  return latest !== undefined && normalize(latest.text) === normalize(text);
}

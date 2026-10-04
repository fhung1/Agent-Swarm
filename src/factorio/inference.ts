import { isUsefulPeerEvent } from './communication.ts';
import { z } from 'zod';
import type { Ask, AskUsage } from '../agents/llm.ts';
import { validateCommand, type Command } from './protocol.ts';
import { FACTORIO_MAX_OUTPUT_TOKENS, type FactorioSpendGuard } from './run-spend.ts';

const integer = (min: number, max: number) => z.number().int().min(min).max(max);
const unitId = integer(1, 2_147_483_647);
const recipientName = z.string().max(96).regex(/^([a-z0-9][a-z0-9_.-]*)?$/);
const move = z.object({ kind: z.literal('move'), x: z.number(), y: z.number(), maxTicks: integer(1, 600) }).strict();
const transfer = z.object({ kind: z.enum(['take', 'put']), targetId: unitId, item: z.string(), quantity: integer(1, 100) }).strict();
const mine = z.object({ kind: z.literal('mine'), name: z.string(), x: z.number(), y: z.number(), quantity: integer(1, 20) }).strict();
const craft = z.object({ kind: z.literal('craft'), recipe: z.string(), quantity: integer(1, 20) }).strict();
const place = z.object({ kind: z.literal('place'), item: z.string(), x: z.number(), y: z.number() }).strict();
// Keep semantic constraints outside the provider schema, then enforce them locally.
export const FactorioDecisionSchema = z.object({
  kind: z.enum(['action', 'chat', 'wait', 'complete', 'subtask', 'resource_request', 'claim_subtask', 'finish_subtask']),
  command: z.union([z.object({kind:z.literal('pickup'),item:z.string(),x:z.number(),y:z.number(),quantity:integer(1,100)}).strict(),z.object({kind:z.literal('research'),technology:z.string()}).strict(), z.object({kind:z.literal('set_recipe'),targetId:unitId,recipe:z.string()}).strict(), move, transfer, mine, craft, place, z.object({kind: z.literal('build'), item: z.string(), x: z.number(), y: z.number(), direction: z.union([z.literal(0),z.literal(4),z.literal(8),z.literal(12)])}).strict(), z.object({kind: z.literal('recover'), targetId: unitId}).strict()]).nullable(),
  message: z.string().max(2000), recipient: recipientName, waitMs: z.number().int(),
}).strict();
export type FactorioDecision = z.infer<typeof FactorioDecisionSchema>;
export class InvalidFactorioDecisionError extends Error {
  constructor(readonly feedback: string) {
    super('Model output did not satisfy the Factorio decision contract; return concise valid JSON and retry.');
    this.name = 'InvalidFactorioDecisionError';
  }
}
function safeDecisionFeedback(error: unknown): string {
  if (error instanceof z.ZodError) return 'Decision fields or types did not match. Counts: take/put/pickup 1–100; mine/craft 1–20. Target IDs are positive integers; move maxTicks 1–600. Recipient is empty to broadcast or exact recipients.overseer for Astra. Return one valid decision.';
  const message = error instanceof Error ? error.message : '';
  if (message === 'Invalid recipient') return 'For chat, recipient must be empty to broadcast or exactly the lowercase name in recipients.overseer to message Astra.';
  if (message === 'Only chat may carry recipient') return 'Set recipient empty except for kind=chat.';
  if (/^Model output (?:was incomplete|was truncated)/.test(message)) return 'Response was incomplete; return one short, complete decision object.';
  if (message === 'Model output did not match the schema') return 'Decision did not match the required schema; return exactly one valid decision object.';
  const safeValidationErrors = new Set([
    'Decision text exceeds limit', 'Invalid recipient', 'Action requires command', 'Only action may carry command',
    'Wait exceeds bounds', 'Only wait may carry waitMs', 'Only chat may carry recipient', 'Chat requires message',
    'Invalid position', 'Position must use the eight-decimal wire grid', 'Invalid integer bound',
    'Invalid Factorio item or recipe name', 'Invalid cardinal direction', 'Unexpected or missing fields',
    'Unsupported command', 'Invalid dependency ID', 'Invalid resource box',
  ]);
  return safeValidationErrors.has(message) ? message : 'Decision failed local validation; return one bounded decision using observed targets and valid command fields.';
}
export interface FactorioScope { runId: string; worldId: string; historyId: string; actorId: number; sender: string }
export interface PeerMessage { id: string; sender: string; recipient: string; kind: string; payload: unknown }
export interface FactorioContext extends FactorioScope {
  objective: string; operatorPrompt?: string; observation: unknown; status?: unknown;
  reservations?: unknown; tasks?: unknown; messages?: PeerMessage[]; lastResult: unknown;
  recipients?: { overseer: string; actors?: string[] };
  budget?: { remainingCalls: number | null; remainingMs: number | null };
}
export const FACTORIO_WORKER_MAX_INPUT_BYTES = 3000;
export const FACTORIO_SYSTEM = `You are one Factorio actor. Astra owns the goal, map and assignments. Do only one next step from your current task and supplied evidence. Nearby entities are partial; use only listed IDs, positions and inventory. If the task, target or needed facts are missing, or work is blocked, message Astra briefly and wait. Never invent outcomes. Reobserve after failure; never repeat an action without its final receipt. Pause, ownership and spend are enforced outside the model.
Use only schema actions: move (at most 6 tiles; maxTicks is ticks), mine, pickup, craft, build, place, take, put, research, set_recipe, recover. Follow schema bounds. Only action has command, wait has waitMs, and chat has recipient (empty to broadcast; exact recipients.overseer for Astra). Correct lastResult feedback. Message only for a blocker, handoff or useful shared fact. No shell, Lua or RCON. Return one minimal decision.`;

export function validateFactorioDecision(value: unknown): FactorioDecision {
  const decision = FactorioDecisionSchema.parse(value);
  if (decision.message.length > 2000 || decision.recipient.length > 96) throw Error('Decision text exceeds limit');
  if (decision.recipient && !/^[a-z0-9][a-z0-9_.-]*$/.test(decision.recipient)) throw Error('Invalid recipient');
  if (decision.kind === 'action') {
    if (!decision.command) throw Error('Action requires command');
    validateCommand(decision.command);
    // `maxTicks` is a Factorio tick timeout, independent of the six-unit move
    // distance bound. A very short model-selected timeout causes routine moves
    // to fail, so normalize it after validating the original command bounds.
    if (decision.command.kind === 'move' && decision.command.maxTicks < 120) decision.command.maxTicks = 120;
  } else if (decision.command !== null) throw Error('Only action may carry command');
  if (decision.kind === 'wait') {
    if (decision.waitMs < 100 || decision.waitMs > 10000) throw Error('Wait exceeds bounds');
  } else if (decision.waitMs !== 0) throw Error('Only wait may carry waitMs');
  if (decision.kind !== 'chat' && decision.recipient) throw Error('Only chat may carry recipient');
  if (decision.kind === 'chat' && !decision.message.trim()) throw Error('Chat requires message');
  if (decision.kind === 'subtask') {
    const task = z.object({ title: z.string().min(1).max(120), details: z.string().min(1).max(1000), dependsOn: z.string().max(96) }).strict().parse(JSON.parse(decision.message));
    if (task.dependsOn && !/^[a-z0-9_.-]{1,96}$/.test(task.dependsOn)) throw Error('Invalid dependency ID');
  }
  if (decision.kind === 'resource_request') {
    const request = z.object({ item: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/), quantity: z.number().int().min(1).max(100), boxId: z.number().int().positive() }).strict().parse(JSON.parse(decision.message));
    if (!request.item) throw Error('Invalid resource request');
  }
  if (['claim_subtask', 'finish_subtask'].includes(decision.kind) && !/^[a-z0-9_.-]{1,96}$/.test(decision.message)) throw Error('Invalid subtask ID');
  return decision;
}

/** Board recipient fields are routing, not secrecy. Ignore other worlds/runs/history. */
export function selectPeerMessages(rows: readonly { id: bigint | string | number; sender: string; recipient: string; body: string }[], scope: FactorioScope): PeerMessage[] {
  const selected: PeerMessage[] = [];
  for (const row of rows) {
    if ((row.sender !== scope.sender && row.recipient && row.recipient !== scope.sender) || row.body.length > 8000) continue;
    try {
      const body = JSON.parse(row.body);
      if (body.version !== 1 || body.runId !== scope.runId || body.worldId !== scope.worldId || body.historyId !== scope.historyId || body.sender !== row.sender) continue;
      if (typeof body.kind !== 'string' || body.kind.length > 64 || !Object.hasOwn(body, 'payload') || !isUsefulPeerEvent(body.kind, body.payload)) continue;
      if (row.sender === scope.sender && body.kind !== 'chat') continue;
      const id = BigInt(row.id);
      if (id < 0n) continue;
      selected.push({ id: id.toString(), sender: row.sender, recipient: row.recipient, kind: body.kind, payload: body.payload });
    } catch { /* Non-protocol board messages are not model context. */ }
  }
  const sorted=selected.sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0);
  const latestOwn=sorted.filter(m=>m.sender===scope.sender).at(-1);
  return sorted.filter(m=>m.sender!==scope.sender || m===latestOwn);
}

export function buildFactorioPrompt(context: FactorioContext): string {
  if (!context.objective.trim() || context.objective.length > 2000) throw Error('Invalid current task prompt size');
  const record = (value: unknown): Record<string, any> | undefined =>
    value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : undefined;
  const sourceObservation = record(context.observation) ?? {};
  const actorX = typeof sourceObservation.x === 'number' ? sourceObservation.x : 0;
  const actorY = typeof sourceObservation.y === 'number' ? sourceObservation.y : 0;
  const shortText = (value: unknown, max = 48): string | undefined =>
    typeof value === 'string' ? Array.from(value).slice(0, max).join('') : undefined;
  const shortBytes = (value: string, max: number): string => {
    let result = '';
    for (const character of value) {
      if (Buffer.byteLength(result + character, 'utf8') > max) break;
      result += character;
    }
    return result;
  };
  const nearbyRows = (Array.isArray(sourceObservation.nearby) ? sourceObservation.nearby : [])
    .map((value: unknown) => record(value) ?? {})
    .sort((a: Record<string, any>, b: Record<string, any>) =>
      Math.hypot((a.x ?? actorX) - actorX, (a.y ?? actorY) - actorY) - Math.hypot((b.x ?? actorX) - actorX, (b.y ?? actorY) - actorY));
  const rawObjective = context.objective.trim().replace(/\s+/g, ' ');
  const objective = Buffer.byteLength(rawObjective, 'utf8') > 440
    ? `${shortBytes(rawObjective, 437)}…` : rawObjective;
  const taskWords = new Set(objective.toLowerCase().replace(/-/g, ' ').match(/[a-z0-9]+/g) ?? []);
  if (/fuel|burner|furnace|mining/i.test(objective)) taskWords.add('coal');
  if (/iron/i.test(objective)) { taskWords.add('iron'); taskWords.add('ore'); taskWords.add('plate'); }
  if (/copper/i.test(objective)) { taskWords.add('copper'); taskWords.add('ore'); taskWords.add('plate'); }
  const targetIds = new Set(Array.from(objective.matchAll(/\b(?:entity|unit|target|machine)(?:\s+(?:id|#))?\s*(\d+)\b/gi), match => Number(match[1])));
  const localRows = [...nearbyRows].sort((a: Record<string, any>, b: Record<string, any>) =>
    Number(targetIds.has(Number(b.unit))) - Number(targetIds.has(Number(a.unit))) ||
    Math.hypot((a.x ?? actorX) - actorX, (a.y ?? actorY) - actorY) - Math.hypot((b.x ?? actorX) - actorX, (b.y ?? actorY) - actorY));
  const allowedEntityFields = ['unit','name','type','x','y','direction','statusName','amount'];
  const nearby = localRows.slice(0, 2).map((entity: Record<string, any>) => {
    const compact: Record<string, unknown> = {};
    for (const key of allowedEntityFields) {
      if (entity[key] === undefined) continue;
      compact[key] = typeof entity[key] === 'string' ? shortText(entity[key]) : entity[key];
    }
    const entityItems = record(entity.items)?.items ?? entity.items;
    if ((entity.type === 'container' || targetIds.has(Number(entity.unit))) &&
        entityItems && typeof entityItems === 'object' && !Array.isArray(entityItems)) {
      const entries = Object.entries(entityItems as Record<string, unknown>);
      const relevant = entries.filter(([name]) => name.toLowerCase().replace(/-/g, ' ').split(/\s+/).some(word => taskWords.has(word)));
      compact.items = Object.fromEntries([...relevant, ...entries.filter(row => !relevant.includes(row))]
        .slice(0, 2).map(([name, count]) => [shortText(name) ?? '', count]));
    }
    const fuel = record(entity.fuel);
    if (fuel) {
      const fuelItems = record(fuel.items) ?? {};
      compact.fuel = {items:Object.fromEntries(Object.entries(fuelItems).slice(0, 2)),
        ...(typeof fuel.burning === 'string' ? {burning:shortText(fuel.burning, 32)} : {}),
        ...(typeof fuel.remainingEnergy === 'number' ? {remainingEnergy:fuel.remainingEnergy} : {})};
    }
    const recipe = record(entity.recipe);
    if (recipe) compact.recipe = {name:shortText(recipe.name),category:shortText(recipe.category, 24)};
    if (entity.groundItem && typeof entity.groundItem === 'object') {
      const groundItem = record(entity.groundItem)!;
      compact.groundItem = { name: shortText(groundItem.name), count: groundItem.count };
    }
    return compact;
  });
  const sourceTerrain = record(sourceObservation.terrain) ?? {};
  const inventorySource = record(sourceObservation.inventory) ?? {};
  const itemSource = record(inventorySource.items) ?? inventorySource;
  const inventoryEntries = Object.entries(itemSource).filter(([, count]) => typeof count === 'number' && count > 0);
  const relevantItems = inventoryEntries.filter(([name]) => name.toLowerCase().replace(/-/g, ' ').split(/\s+/).some(word => taskWords.has(word)));
  const items = Object.fromEntries([...relevantItems, ...inventoryEntries.filter(row => !relevantItems.includes(row))]
    .slice(0, 4).map(([name, count]) => [shortText(name) ?? '', count]));
  const hasWaterTask = /water|offshore|pump|pipe|fluid|steam/i.test(objective);
  const observation = {
    actor:{id:context.actorId,x:actorX,y:actorY,tick:sourceObservation.tick},
    inventory:{items,...(typeof inventorySource.ironPlate === 'number' ? {ironPlate:inventorySource.ironPlate} : {})},
    nearby,
    ...(/craft|recipe/i.test(objective) && Array.isArray(sourceObservation.craftingQueue) && sourceObservation.craftingQueue.length
      ? {craftingQueue:sourceObservation.craftingQueue.slice(0, 1)} : {}),
    ...(hasWaterTask ? {water:{nearest:sourceTerrain.nearestWater,
      shorelines:Array.isArray(sourceTerrain.shorelines)?sourceTerrain.shorelines.slice(0,1):[]}} : {}),
  };
  const latestNote = (context.messages ?? []).filter(message => message.sender === `${context.runId}-orchestrator` &&
    message.kind === 'chat' && (!message.recipient || message.recipient === context.sender)).at(-1);
  const notePayload = latestNote ? record(latestNote.payload) : undefined;
  const noteText = typeof notePayload?.text === 'string' ? notePayload.text : latestNote ? JSON.stringify(latestNote.payload) : '';
  const coordinatorNote = latestNote ? shortBytes(noteText, 96) : undefined;
  const sourceResult = record(context.lastResult);
  const lastResult = sourceResult && (sourceResult.error || sourceResult.reason || sourceResult.detail) ? {
    ...(sourceResult.status ? {status:shortText(sourceResult.status, 20)} : {}),
    ...(sourceResult.reason ? {reason:shortBytes(String(sourceResult.reason), 100)} : {}),
    ...(sourceResult.error ? {error:shortBytes(String(sourceResult.error), 100)} : {}),
    ...(sourceResult.detail ? {detail:shortBytes(String(sourceResult.detail), 80)} : {}),
  } : undefined;
  const compacted = {
    task:objective,observation,
    ...(lastResult ? {lastResult} : {}),
    ...(coordinatorNote ? {coordinatorNote} : {}),
    recipients:{overseer:context.recipients?.overseer??`${context.runId}-orchestrator`},
  };
  const prompt=JSON.stringify(compacted);
  if (Buffer.byteLength(FACTORIO_SYSTEM, 'utf8') + Buffer.byteLength(prompt,'utf8') > FACTORIO_WORKER_MAX_INPUT_BYTES) {
    throw Error('Factorio worker system and current-step context exceed 3000 bytes');
  }
  return prompt;
}

/** Invalid structured decisions are returned to the worker as bounded retry feedback. */
export async function decideFactorio(ask: Ask, context: FactorioContext, options: {
  signal?: AbortSignal; timeoutMs?: number; onUsage?: (usage: AskUsage, model?: string) => void;
  spend?: FactorioSpendGuard; callId?: string; onSpend?: (cost: { reservedUsd?: string; chargedUsd?: string }) => void;
} = {}): Promise<FactorioDecision> {
  const timeoutMs = options.timeoutMs ?? 60000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw Error('Invalid inference timeout');
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  signal.throwIfAborted();
  const prompt = buildFactorioPrompt(context);
  const reservedUsd = options.spend
    ? options.spend.reserve(options.callId ?? '', ask.model ?? '', FACTORIO_SYSTEM, prompt,
      ask.maxOutputTokens ?? FACTORIO_MAX_OUTPUT_TOKENS)
    : undefined;
  if (reservedUsd !== undefined) options.onSpend?.({ reservedUsd });
  let abort: () => void = () => {};
  const stopped = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    let output: unknown;
    try {
      output = await Promise.race([ask(FactorioDecisionSchema, FACTORIO_SYSTEM, prompt, { signal,
        onUsage: (usage, model) => {
          options.onUsage?.(usage, model);
          if (options.spend) {
            const chargedUsd = options.spend.settle(options.callId ?? '', usage, model);
            options.onSpend?.({ reservedUsd, chargedUsd });
          }
        } }), stopped]);
    } catch (error) {
      if (error instanceof z.ZodError || (error instanceof Error &&
        (error.message === 'Model output did not match the schema' || /^Model output (?:was incomplete|was truncated)/.test(error.message)))) {
        throw new InvalidFactorioDecisionError(safeDecisionFeedback(error));
      }
      throw error;
    }
    signal.throwIfAborted();
    try { return validateFactorioDecision(output); }
    catch (error) { throw new InvalidFactorioDecisionError(safeDecisionFeedback(error)); }
  } finally { signal.removeEventListener('abort', abort); }
}

export function decisionCommand(decision: FactorioDecision): Command | null {
  return decision.kind === 'action' ? validateCommand(decision.command) : null;
}

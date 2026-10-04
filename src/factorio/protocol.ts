import { createHash } from 'node:crypto';

export type Command =
  | { kind: 'move'; x: number; y: number; maxTicks: number }
  | { kind: 'take' | 'put'; targetId: number; item: 'iron-ore' | 'coal' | 'iron-plate'; quantity: number };
export interface Operation {
  version: 1; worldId: string; historyId: string; operationId: string; actorId: number; command: Command;
}
export interface Receipt {
  version: 1; operationId: string; digest: string; worldId: string; historyId: string;
  actorId: number; status: 'pending' | 'completed' | 'failed'; startTick: number; endTick?: number;
  detail?: string; quantity?: number; item?: string; targetId?: number;
}
const coordinateDecimals = 8;
const coordinateScale = 100_000_000n;
// Validate the decimal wire value, not a binary floating-point multiplication.
function coordinateUnits(value: number): bigint {
  const parts = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/.exec(JSON.stringify(value));
  if (!parts) throw new Error('Invalid position');
  const fraction = parts[3] ?? '';
  const coefficient = BigInt(parts[2] + fraction);
  const shift = coordinateDecimals + Number(parts[4] ?? 0) - fraction.length;
  let units: bigint;
  if (shift >= 0) units = coefficient * 10n ** BigInt(shift);
  else {
    const divisor = 10n ** BigInt(-shift);
    if (coefficient % divisor !== 0n) throw new Error('Position must use the eight-decimal wire grid');
    units = coefficient / divisor;
  }
  return parts[1] ? -units : units;
}
function coordinateJson(value: number): string {
  const units = coordinateUnits(value), absolute = units < 0n ? -units : units;
  const fraction = absolute % coordinateScale;
  const whole = `${units < 0n ? '-' : ''}${absolute / coordinateScale}`;
  return fraction ? `${whole}.${fraction.toString().padStart(coordinateDecimals, '0').replace(/0+$/, '')}` : whole;
}
function integer(value: unknown, min: number, max: number): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new Error('Invalid integer bound');
}
function exact(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) throw new Error('Unexpected or missing fields');
}
export function validateCommand(value: unknown): Command {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected command object');
  const c = value as Record<string, unknown>;
  if (c.kind === 'move') {
    exact(c, ['kind', 'x', 'y', 'maxTicks']);
    for (const key of ['x', 'y']) {
      const coordinate = c[key];
      if (typeof coordinate !== 'number' || !Number.isFinite(coordinate) || Math.abs(coordinate) > 1_000_000) {
        throw new Error('Invalid position');
      }
      coordinateUnits(coordinate);
    }
    integer(c.maxTicks, 1, 600);
  } else if (c.kind === 'take' || c.kind === 'put') {
    exact(c, ['kind', 'targetId', 'item', 'quantity']); integer(c.targetId, 1, 2_147_483_647); integer(c.quantity, 1, 20);
    if (!['iron-ore', 'coal', 'iron-plate'].includes(String(c.item))) throw new Error('Unsupported item');
  } else throw new Error('Unsupported command');
  return value as Command;
}
export function canonical(value: unknown): string {
  if (typeof value === 'number') return Number.isInteger(value) ? JSON.stringify(value) : coordinateJson(value);
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
}
export function encodeOperation(operation: Operation): { digest: string; request: string } {
  exact(operation as unknown as Record<string, unknown>, ['version', 'worldId', 'historyId', 'operationId', 'actorId', 'command']);
  if (operation.version !== 1) throw new Error('Invalid protocol');
  for (const key of ['worldId', 'historyId', 'operationId'] as const) {
    if (typeof operation[key] !== 'string' || !/^[A-Za-z0-9_.:-]{1,96}$/.test(operation[key])) throw new Error(`Invalid ${key}`);
  }
  integer(operation.actorId, 1, 2_147_483_647); validateCommand(operation.command);
  // Coordinate values use an exact eight-decimal grid. Both the TypeScript worker and
  // Python bridge serialize the exact decimal operation, never language-specific
  // exponent notation, before calculating the receipt digest.
  const digest = createHash('sha256').update(canonical(operation)).digest('hex');
  return { digest, request: canonical({ ...operation, digest }) };
}

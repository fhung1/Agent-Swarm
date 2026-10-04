import { existsSync, mkdirSync, openSync, closeSync, fsyncSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { microsToUsd, quoteUsageMicros, reserveUsageMicros, usdToMicros, type ModelRates, type TokenUsage } from '../agents/spend-pricing.ts';

export const FACTORIO_RUN_SPEND_CAP_USD = '500';
export const FACTORIO_SPEND_PRICE_VERSION = 'openai-standard-2026-10-03-plus-10pct';
export const FACTORIO_MAX_INPUT_BYTES = 40_000;
export const FACTORIO_MAX_OUTPUT_TOKENS = 16_000;
const SAFETY_NUMERATOR = 110n;
const SAFETY_DENOMINATOR = 100n;

// OpenAI Standard text rates per million tokens as checked 2026-10-03.
// The local gate adds a further 10% margin before comparing with the run cap.
const MODEL_RATES: Record<string, ModelRates> = {
  'gpt-6-astra': {
    inputMicrosPerMillion: usdToMicros('10'), cacheReadMicrosPerMillion: usdToMicros('1'),
    cacheWriteMicrosPerMillion: usdToMicros('12.5'), outputMicrosPerMillion: usdToMicros('50'),
  },
  'gpt-6-luna': {
    inputMicrosPerMillion: usdToMicros('0.1'), cacheReadMicrosPerMillion: usdToMicros('0.01'),
    cacheWriteMicrosPerMillion: usdToMicros('0.125'), outputMicrosPerMillion: usdToMicros('0.5'),
  },
};

export interface SpendRecord {
  status: 'reserved' | 'settled';
  model: string;
  reservedMicros: string;
  chargedMicros: string;
  inputByteCeiling: number;
  outputTokenCeiling: number;
  usage?: TokenUsage;
}
export interface FactorioSpendLedger {
  version: 1;
  runId: string;
  worldId: string;
  historyId: string;
  capMicros: string;
  priceVersion: string;
  records: Record<string, SpendRecord>;
}
export interface FactorioSpendGuard {
  reserve(callId: string, model: string, system: string, prompt: string, outputTokenCeiling?: number): string;
  settle(callId: string, usage: TokenUsage, actualModel?: string): string;
  snapshot(): { capUsd: string; chargedUsd: string; reservedUsd: string; remainingUsd: string };
}

function safeCost(value: bigint): string { return value.toString(); }
function withMargin(value: bigint): bigint { return (value * SAFETY_NUMERATOR + SAFETY_DENOMINATOR - 1n) / SAFETY_DENOMINATOR; }
function pricingModel(model: string): string | undefined {
  if (Object.hasOwn(MODEL_RATES, model)) return model;
  const snapshot = /^(gpt-6-(?:astra|luna))-\d{4}-\d{2}-\d{2}$/.exec(model);
  return snapshot?.[1];
}
function ledgerTotal(ledger: FactorioSpendLedger): { charged: bigint; reserved: bigint } {
  let charged = 0n, reserved = 0n;
  for (const row of Object.values(ledger.records)) {
    if (row.status === 'settled') charged += BigInt(row.chargedMicros);
    else reserved += BigInt(row.reservedMicros);
  }
  return { charged, reserved };
}

/** Shared across every worker and overseer process for one run. Reservations are
 * committed before HTTP dispatch; uncertain requests keep their full reservation. */
export function createFactorioSpendGuard(options: {
  path: string; runId: string; worldId: string; historyId: string;
  capUsd?: string; priceVersion?: string;
}): FactorioSpendGuard {
  const path = options.path, capUsd = options.capUsd ?? FACTORIO_RUN_SPEND_CAP_USD;
  const priceVersion = options.priceVersion ?? FACTORIO_SPEND_PRICE_VERSION;
  const capMicros = usdToMicros(capUsd);
  if (capMicros < 1n || capMicros > usdToMicros(FACTORIO_RUN_SPEND_CAP_USD)) throw Error('Factorio per-run spend cap must be greater than zero and at most $500');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (existsSync(path)) {
    const existing = JSON.parse(readFileSync(path, 'utf8')) as FactorioSpendLedger;
    if (existing.version !== 1 || existing.runId !== options.runId || existing.worldId !== options.worldId ||
      existing.historyId !== options.historyId || existing.capMicros !== capMicros.toString() || existing.priceVersion !== priceVersion ||
      !existing.records || typeof existing.records !== 'object') throw Error('Run spend ledger differs from immutable run scope or spend plan');
  } else {
    const initial: FactorioSpendLedger = { version: 1, runId: options.runId, worldId: options.worldId, historyId: options.historyId,
      capMicros: capMicros.toString(), priceVersion, records: {} };
    const fd = openSync(path, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(initial, null, 2)); fsyncSync(fd); } finally { closeSync(fd); }
  }

  const lockPath = `${path}.lock`;
  const transact = <T>(mutate: (ledger: FactorioSpendLedger) => T): T => {
    const until = Date.now() + 30_000;
    while (true) {
      try {
        mkdirSync(lockPath, { mode: 0o700 });
        writeFileSync(join(lockPath, 'owner'), JSON.stringify({ pid: process.pid, at: Date.now() }), { mode: 0o600 });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        try {
          const owner = JSON.parse(readFileSync(join(lockPath, 'owner'), 'utf8')) as { pid?: number; at?: number };
          let alive = false;
          if (Number.isSafeInteger(owner.pid) && owner.pid! > 0) {
            try { process.kill(owner.pid!, 0); alive = true; } catch (probe) { alive = (probe as NodeJS.ErrnoException).code !== 'ESRCH'; }
          }
          if (!alive && Date.now() - Number(owner.at ?? 0) > 1000) { rmSync(lockPath, { recursive: true, force: true }); continue; }
        } catch { /* A creator may be between mkdir and writing the owner file. */ }
        if (Date.now() >= until) throw Error('Timed out acquiring shared run spend ledger lock');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
    }
    try {
      const ledger = JSON.parse(readFileSync(path, 'utf8')) as FactorioSpendLedger;
      if (ledger.version !== 1 || ledger.runId !== options.runId || ledger.worldId !== options.worldId || ledger.historyId !== options.historyId ||
          ledger.capMicros !== capMicros.toString() || ledger.priceVersion !== priceVersion) throw Error('Run spend ledger scope changed');
      const result = mutate(ledger);
      const temporary = `${path}.${process.pid}.tmp`, fd = openSync(temporary, 'w', 0o600);
      try { writeFileSync(fd, JSON.stringify(ledger, null, 2)); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temporary, path);
      const directoryFd = openSync(dirname(path), 'r');
      try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
      return result;
    } finally { rmSync(lockPath, { recursive: true, force: true }); }
  };
  const ratesFor = (model: string) => {
    const rates = MODEL_RATES[pricingModel(model) ?? ''];
    if (!rates) throw Error(`No approved spend rate for model ${model}; refusing provider call`);
    return rates;
  };
  return {
    reserve(callId, model, system, prompt, outputTokenCeiling = FACTORIO_MAX_OUTPUT_TOKENS) {
      if (!/^[a-z0-9_.-]{1,160}$/.test(callId)) throw Error('Invalid run spend reservation ID');
      if (!Number.isSafeInteger(outputTokenCeiling) || outputTokenCeiling < 1 || outputTokenCeiling > FACTORIO_MAX_OUTPUT_TOKENS) throw Error('Invalid model output token ceiling');
      const inputByteCeiling = Buffer.byteLength(system, 'utf8') + Buffer.byteLength(prompt, 'utf8');
      if (inputByteCeiling > FACTORIO_MAX_INPUT_BYTES) throw Error(`Model input exceeds the ${FACTORIO_MAX_INPUT_BYTES}-byte spend reservation bound`);
      const rates = ratesFor(model), amount = withMargin(reserveUsageMicros(rates, inputByteCeiling, outputTokenCeiling));
      transact(ledger => {
        if (ledger.records[callId]) throw Error('Run spend call ID already reserved; refusing request replay');
        const totals = ledgerTotal(ledger), next = totals.charged + totals.reserved + amount;
        if (next > BigInt(ledger.capMicros)) throw Error(`Factorio run dollar budget exhausted; request would exceed $${capUsd}`);
        ledger.records[callId] = { status: 'reserved', model, reservedMicros: safeCost(amount), chargedMicros: '0', inputByteCeiling, outputTokenCeiling };
      });
      return microsToUsd(amount);
    },
    settle(callId, usage, actualModel) {
      const cost = transact(ledger => {
        const row = ledger.records[callId];
        if (!row || row.status !== 'reserved') throw Error('Missing or already settled run spend reservation');
        if (actualModel && pricingModel(actualModel) !== pricingModel(row.model)) throw Error(`Provider used unexpected model ${actualModel}; retaining maximum reservation`);
        const inputTokens = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
        if (!Number.isSafeInteger(inputTokens) || inputTokens < 0 || inputTokens > row.inputByteCeiling ||
            !Number.isSafeInteger(usage.outputTokens) || usage.outputTokens < 0 || usage.outputTokens > row.outputTokenCeiling) {
          throw Error('Provider usage exceeds the pre-call spend reservation; retaining maximum reservation');
        }
        const amount = withMargin(quoteUsageMicros(ratesFor(row.model), usage));
        if (amount > BigInt(row.reservedMicros)) throw Error('Provider charge exceeds the pre-call spend reservation');
        row.status = 'settled'; row.chargedMicros = safeCost(amount); row.usage = usage;
        return amount;
      });
      return microsToUsd(cost);
    },
    snapshot() {
      return transact(ledger => {
        const totals = ledgerTotal(ledger), charged = totals.charged, reserved = totals.reserved, remaining = BigInt(ledger.capMicros) - charged - reserved;
        return { capUsd: microsToUsd(BigInt(ledger.capMicros)), chargedUsd: microsToUsd(charged),
          reservedUsd: microsToUsd(reserved), remainingUsd: microsToUsd(remaining) };
      });
    },
  };
}

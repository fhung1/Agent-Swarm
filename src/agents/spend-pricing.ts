export const TOKENS_PER_MILLION = 1_000_000n;
export const MAX_U64 = 18_446_744_073_709_551_615n;

// Prices are operator-supplied integer micro-USD per million tokens. No provider
// price is embedded in the worker or module.
export interface ModelRates {
  inputMicrosPerMillion: bigint;
  cacheReadMicrosPerMillion: bigint;
  cacheWriteMicrosPerMillion: bigint;
  outputMicrosPerMillion: bigint;
}

export interface TokenUsage {
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
}

function validTokens(value: number): bigint {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Token usage must be a non-negative safe integer');
  return BigInt(value);
}

function validRate(value: bigint): bigint {
  if (value < 0n || value > MAX_U64) throw new Error('Model price rate is outside the supported range');
  return value;
}

export function quoteUsageMicros(rates: ModelRates, usage: TokenUsage): bigint {
  const numerator = validTokens(usage.inputTokens) * validRate(rates.inputMicrosPerMillion) +
    validTokens(usage.cacheReadTokens) * validRate(rates.cacheReadMicrosPerMillion) +
    validTokens(usage.cacheWriteTokens) * validRate(rates.cacheWriteMicrosPerMillion) +
    validTokens(usage.outputTokens) * validRate(rates.outputMicrosPerMillion);
  const result = (numerator + TOKENS_PER_MILLION - 1n) / TOKENS_PER_MILLION;
  if (result > MAX_U64) throw new Error('Quoted model spend exceeds the supported range');
  return result;
}

// Before a call the worker knows an upper bound for text input and the provider
// output cap. Reserve input at the most expensive configured cache state because
// whether the provider reads, writes, or skips its prompt cache is not guaranteed.
export function reserveUsageMicros(rates: ModelRates, inputTokenCeiling: number, outputTokenCeiling: number): bigint {
  const inputRate = [rates.inputMicrosPerMillion, rates.cacheReadMicrosPerMillion, rates.cacheWriteMicrosPerMillion]
    .map(validRate).reduce((max, rate) => rate > max ? rate : max, 0n);
  return quoteUsageMicros({ inputMicrosPerMillion: inputRate, cacheReadMicrosPerMillion: inputRate,
    cacheWriteMicrosPerMillion: inputRate, outputMicrosPerMillion: rates.outputMicrosPerMillion },
  { inputTokens: inputTokenCeiling, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: outputTokenCeiling });
}

export function usdToMicros(value: string): bigint {
  if (!/^(0|[1-9]\d*)(?:\.(\d{1,6}))?$/.test(value)) throw new Error('USD amount must be a non-negative decimal with at most 6 places');
  const [whole, fraction = ''] = value.split('.');
  const result = BigInt(whole!) * TOKENS_PER_MILLION + BigInt(fraction.padEnd(6, '0') || '0');
  if (result > MAX_U64) throw new Error('USD amount is outside the supported range');
  return result;
}

export function microsToUsd(value: bigint): string {
  if (value < 0n || value > MAX_U64) throw new Error('USD amount is outside the supported range');
  const whole = value / TOKENS_PER_MILLION;
  const fraction = (value % TOKENS_PER_MILLION).toString().padStart(6, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : String(whole);
}

export function nonNegativeMicros(value: string): bigint {
  if (!/^(0|[1-9]\d*)$/.test(value)) throw new Error('Micro-USD value must be an unsigned integer');
  const result = BigInt(value);
  if (result > MAX_U64) throw new Error('Micro-USD value is outside the supported range');
  return result;
}

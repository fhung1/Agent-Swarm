import test from 'node:test';
import assert from 'node:assert/strict';
import { microsToUsd, nonNegativeMicros, quoteUsageMicros, reserveUsageMicros, usdToMicros, type ModelRates } from './spend-pricing.ts';

const rates: ModelRates = {
  inputMicrosPerMillion: 2_000_000n,
  cacheReadMicrosPerMillion: 500_000n,
  cacheWriteMicrosPerMillion: 3_000_000n,
  outputMicrosPerMillion: 10_000_000n,
};

test('USD config conversion is exact to microdollars and rejects implicit rounding', () => {
  assert.equal(usdToMicros('12.340005'), 12_340_005n);
  assert.equal(microsToUsd(usdToMicros('12.340005')), '12.340005');
  assert.equal(microsToUsd(usdToMicros('0')), '0');
  assert.throws(() => usdToMicros('1.0000001'), /at most 6 places/);
  assert.throws(() => nonNegativeMicros('-1'), /unsigned integer/);
});

test('actual usage price includes cache buckets and rounds fractional microdollars up', () => {
  assert.equal(quoteUsageMicros(rates, { inputTokens: 100_000, cacheReadTokens: 50_000,
    cacheWriteTokens: 25_000, outputTokens: 10_000 }), 400_000n);
  assert.equal(quoteUsageMicros(rates, { inputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }), 2n);
});

test('reservation pessimistically uses the priciest cache state and full output cap', () => {
  const reserved = reserveUsageMicros(rates, 10_000, 2_000);
  const observed = quoteUsageMicros(rates, { inputTokens: 2_000, cacheReadTokens: 3_000,
    cacheWriteTokens: 5_000, outputTokens: 1_000 });
  assert.equal(reserved, 50_000n);
  assert.ok(reserved >= observed);
});

test('invalid and overflowing token or rate inputs fail closed', () => {
  assert.throws(() => quoteUsageMicros(rates, { inputTokens: -1, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }), /non-negative/);
  assert.throws(() => reserveUsageMicros({ ...rates, outputMicrosPerMillion: -1n }, 1, 1), /supported range/);
});

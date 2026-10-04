# Factorio model spend

The prompted Factorio launcher requires explicit provider/model, per-actor call count and run duration. These limits persist across restart, but **call limits are not dollar limits**. Verify the current worker integration before claiming an enforced run-wide spend ceiling.

The shared arithmetic in `src/agents/spend-pricing.ts` exposes `usdToMicros`, `quoteUsageMicros` and `reserveUsageMicros`. It uses integer micro-USD with operator-supplied, versioned rates for the exact model: regular input, cache-read input, cache-write input and output. It contains no provider price card.

A complete Factorio spend gate must reserve worst-case cost durably before each request, enforce worker/run ceilings atomically, settle confirmed usage, retain reservations for uncertain calls, and reject missing rates. Retries need new reservations. Importing arithmetic alone does not implement this gate.

Keep credentials and private traces outside board messages. Record model, pricing version, budgets and observed usage with live acceptance. See [the inference guide](factorio-inference.md) and [release gates](../FACTORIO_IMPLEMENTATION_TASKS.md).

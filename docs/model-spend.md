# Model spend accounting

## Trading workers

The trading module enforces money limits with the same reducer that records each model attempt. Operators provide an immutable pricing version and exact model rate rows. Rates are USD per million tokens, entered as decimal strings with at most six places and stored as integer micro-USD. Each model requires regular input, cache-read input, cache-write input, and output rates. The code contains no provider rate card.

Paid-model swarm configuration adds a `spend` object:

```json
{
  "pricingVersion": "verified-provider-card-YYYY-MM-DD",
  "models": [{
    "model": "EXACT_PROVIDER_MODEL_ID",
    "inputUsdPerMillion": "REPLACE_WITH_VERIFIED_RATE",
    "cacheReadUsdPerMillion": "REPLACE_WITH_VERIFIED_RATE",
    "cacheWriteUsdPerMillion": "REPLACE_WITH_VERIFIED_RATE",
    "outputUsdPerMillion": "REPLACE_WITH_VERIFIED_RATE"
  }],
  "maxRunUsd": "REPLACE_WITH_RUN_CEILING",
  "maxWorkerUsd": "REPLACE_WITH_PER_WORKER_CEILING"
}
```

The strings above are placeholders, not runnable pricing. Confirm rates for the exact model and provider account before replacing them. `maxRunUsd` and `maxWorkerUsd` are optional; an omitted or zero ceiling means unbounded for that dimension, while model prices remain mandatory for paid workers. `swarm grants --apply` writes the immutable rates before configuring the run's pricing version and ceilings. Changing rates requires a new pricing version.

`begin_inference` rejects an unknown model/version and atomically reserves a conservative charge using the UTF-8 input bound, prompt-format allowance, full output-token allowance, and most expensive configured input-cache rate. It also reserves the run token budget and checks the run and authenticated worker monetary ceilings in one reducer transaction. `finish_inference` settles calls with known provider usage from regular, cache-read, cache-write, and output counts, rounding upward to the next micro-USD. A failed or uncertain request without usage keeps its entire reservation; a retry needs a new reservation. An unexpected actual model must have a rate in the same version. A price or usage overrun is recorded, the result is discarded, and the run is paused before another decision can proceed. Completed structured output is still replayed without another provider call.

The durable `inference_attempt` records the requested and actual model, price version, token buckets, reserved charge, settled charge, and failure reason. `run_config` records the run ceiling, per-worker ceiling, and reserved-or-spent total. The operator dashboard shows current run spend, both ceilings, and the rate version.

## Game workers

The legacy single-client screenshot worker records an explicit local rate version and per-process ceiling in `.game-runs/<id>/run.json`. It persists a worst-case reservation before each paid request, settles from provider usage, and retains an uncertain request's reservation. See [the game agent guide](../src/game/README.md). That older GUI process does not share a global cap with other processes.

The Mineflayer module exposes `configure_spend(runId, version, model, four rates, run cap, worker cap)`. Rates and ceilings are unsigned integer micro-USD, and immutable rows are scoped by price version and exact model ID. Workers call `begin_inference` with separate input/output token ceilings before the provider request, then `finish_inference` with the four reported usage buckets and actual model. Reservations and settlements are atomic with the shared game run, keyed to the authenticated worker, and uncertain calls retain their spend. Missing prices fail before a paid request. Factorio's rules workers make no provider calls. Its future model adapter must add equivalent durable reservation and settlement reducers to the Factorio operation journal before enabling paid calls; importing a pure price helper alone is not a global cap.

The reusable arithmetic in `src/agents/spend-pricing.ts` uses integer micro-USD and exposes `usdToMicros`, `quoteUsageMicros`, and `reserveUsageMicros`. Game workers can reuse those pure functions, but each application's SpacetimeDB module must make reservation and settlement atomic with its own run state.

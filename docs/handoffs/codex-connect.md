# Factorio inference implementation handoff

Contract, durable worker and ten-worker launcher are implemented (`57c1567`, `5fb2c87`, hardening `fd9ae90`/`2065af9`, launcher `f44766f`). Focused checks cover scoped prompts, bounded decisions, ownership/pause, saved intents, uncertain receipts, contention and false completion; launcher checks validate ten distinct actors and bounded configuration.

Use [the launch guide](../factorio-inference.md). Dry-run is read-only; `--start` seeds tasks and starts workers. Prompts can be common or per actor and are reread each turn. Preserve deadlines/call counts on restart.

Real-provider/game acceptance remains a separate live-owner task. Verify the current host, world, model credentials and budget before launch; no live success is implied by deterministic tests.

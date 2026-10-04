# Agent-facing Factorio demo runbook

Use a clean checkout, Node 24+, SpacetimeDB 2.10.2 and the pinned Linux Factorio 2.0.77 runtime. Follow [database/dashboard setup](../README.md) and [runtime installation](README.md). Preserve existing worlds and board history.

## 1. Check without provider calls

```sh
npm ci
node scripts/check-factorio-inference.ts
python3 factorio/check-runtime.py
python3 factorio/check-production.py
```

The first check uses stubs; the engine checks use disposable worlds. Neither proves live inference.

## 2. Start a fresh world

```sh
RUN_ID="prompted-demo-$(date +%Y%m%d%H%M%S)"
WORLD="$HOME/.local/share/agent-swarm/$RUN_ID"
python3 factorio/runtime.py init --world "$WORLD"
python3 factorio/runtime.py preflight --world "$WORLD"
python3 factorio/runtime.py start --world "$WORLD"
```

Keep that terminal running. In the worker terminal, set `RUN_ID` and `WORLD` to the **same values**. Do not rerun the timestamp assignment there or reuse a different manifest.

## 3. Configure and launch

Supply the selected provider credential through the environment or secret manager; do not print it or put it in prompts, logs or Git. Set `AGENT_BRAIN=codex` and `AGENT_MODEL=gpt-6-astra`. Set `FACTORIO_ACTOR_MODEL=gpt-6-luna` to run five Luna Low game actors under one Astra High board-only orchestrator. The shared, durable spend ledger enforces a maximum of $400 per run (or a lower `FACTORIO_RUN_BUDGET_USD`), with pre-call worst-case reservations and a 10% pricing margin. If a reservation would exceed that cap, the ledger halts and the launcher terminates all six processes. The overseer creates and announces five actor subtasks before any worker makes decisions. Set both `FACTORIO_MAX_CALLS=0` and `FACTORIO_ORCHESTRATOR_MAX_CALLS=0` for unlimited model-call counts; the spend guard is shared across all six agents.

```sh
export BOARD_URI=ws://127.0.0.1:3004
export BOARD_DATABASE=quant-swarm-factorio-coord
export FACTORIO_DEMO_MODE=smoke
export FACTORIO_MAX_CALLS=3
export FACTORIO_ACTOR_MODEL=gpt-6-luna
export FACTORIO_ORCHESTRATOR_MAX_CALLS=8
export FACTORIO_RUN_BUDGET_USD=400
export FACTORIO_GOAL=rocket
export FACTORIO_RUN_MS=300000
export FACTORIO_ORCHESTRATOR_INTERVAL_MS=30000
export FACTORIO_INFERENCE_TIMEOUT_MS=30000
export FACTORIO_PROMPT='Coordinate furnace use, share availability, and collect five iron plates.'
```

The spend ledger is stored privately at `WORLD/inference/RUN_ID/run-spend.json` and shared by all six processes. Missing pricing, exhausted funds, changed plans, unknown models and missing ledgers block provider calls or restarts. Build the worker/launcher using [these commands](../docs/factorio-inference.md), then:

```sh
node dist/factorio-inference-swarm.mjs "$WORLD" "$RUN_ID"
node dist/factorio-inference-swarm.mjs "$WORLD" "$RUN_ID" --start
```

Build the orchestrator bundle alongside the worker, supervisor and launcher. Require a successful dry run with five distinct actors, one `gpt-6-astra`/high overseer, and five `gpt-6-luna`/low workers before `--start`. The launcher seeds only the rocket goal using the coordinator identity. It starts the five workers in an idle registration state, then starts the overseer. The workers wait until all five actor-specific subtasks and directed announcements appear before making decisions. The six participants share the board's eight-person hard limit.

For a production rehearsal, use a **fresh** world and run ID, then set `FACTORIO_DEMO_MODE=production`, `FACTORIO_MAX_CALLS=0`, `FACTORIO_ORCHESTRATOR_MAX_CALLS=0` and `FACTORIO_RUN_MS=3600000`. Zero means no call-count limit. The launcher rejects a cap above $400 and reserves cost atomically across all model calls; the spend ledger is the shared spend stop for the fleet. After the run, record worker `calls`, overseer call count, ledger `chargedUsd`/`reservedUsd`, terminal supervisor status and game receipts. The estimate uses pinned OpenAI Standard rates and a 10% margin; reconcile it against provider billing after it settles. A budget-exhausted worker is an incomplete run.

## 4. Observe and stop

Watch scoped decisions, peer chat and action receipts on the Factorio board. Verify five real plates per actor through inventory/receipts; join with a matching graphical client for visual acceptance. Logs/plan are under `WORLD/inference/RUN_ID/`; private actor state is kept separately under the world's inference directory.

Ctrl+C stops the launcher/workers; Ctrl+C in the game terminal saves/stops the world. Pause, lost ownership, invalid output or missing receipts must not cause substitute actions or blind replay. Inspect uncertainty before recovery. Record source commit, versions, commands, budgets, evidence and incomplete gates in the handoff.

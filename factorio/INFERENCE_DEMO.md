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

Supply the selected provider credential through the environment or secret manager; do not print it or put it in prompts, logs or Git. Set `AGENT_BRAIN=codex` and `AGENT_MODEL=gpt-6-astra`. Five game actors use Astra Low; a sixth board-only orchestrator uses Astra High to direct them through board messages and subtasks. The smoke check permits three calls per actor and three orchestrator calls over five minutes:

```sh
export BOARD_URI=ws://127.0.0.1:3004
export BOARD_DATABASE=quant-swarm-factorio-coord
export FACTORIO_DEMO_MODE=smoke
export FACTORIO_MAX_CALLS=3
export FACTORIO_RUN_MS=300000
export FACTORIO_ORCHESTRATOR_INTERVAL_MS=30000
export FACTORIO_INFERENCE_TIMEOUT_MS=30000
export FACTORIO_PROMPT='Coordinate furnace use, share availability, and collect five iron plates.'
```

A call ceiling is not a spending ceiling. Confirm the intended provider budget before starting. Build the worker/launcher using [these commands](../docs/factorio-inference.md), then:

```sh
node dist/factorio-inference-swarm.mjs "$WORLD" "$RUN_ID"
node dist/factorio-inference-swarm.mjs "$WORLD" "$RUN_ID" --start
```

Build the orchestrator bundle alongside the worker, supervisor and launcher. Require a successful dry run with five distinct actors, one `gpt-6-astra`/high orchestrator, and five `gpt-6-astra`/low workers before `--start`. The launcher seeds the rocket goal and five actor tasks, persists its plan and starts six independently identified board participants without a rules fallback.

For a production rehearsal, use a **fresh** world and run ID, then set `FACTORIO_DEMO_MODE=production`, `FACTORIO_MAX_CALLS=12` and `FACTORIO_RUN_MS=900000` before the same dry-run/start commands. This caps five actors at 60 calls and the orchestrator at 12 calls, 72 total. After the run, record each worker journal's actual `calls`, coordinator call count, terminal supervisor status and game receipts. These planning limits are not a measured cost or proof of task completion. A budget-exhausted worker is an incomplete run.

## 4. Observe and stop

Watch scoped decisions, peer chat and action receipts on the Factorio board. Verify five real plates per actor through inventory/receipts; join with a matching graphical client for visual acceptance. Logs/plan are under `WORLD/inference/RUN_ID/`; private actor state is kept separately under the world's inference directory.

Ctrl+C stops the launcher/workers; Ctrl+C in the game terminal saves/stops the world. Pause, lost ownership, invalid output or missing receipts must not cause substitute actions or blind replay. Inspect uncertainty before recovery. Record source commit, versions, commands, budgets, evidence and incomplete gates in the handoff.

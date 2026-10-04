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

Supply the selected provider credential through the environment or secret manager; do not print it or put it in prompts, logs or Git. Set `AGENT_BRAIN=codex` or `claude` and an explicit supported `AGENT_MODEL`. The following paid smoke check permits at most thirty calls across ten actors and five minutes. It can confirm connectivity and prompt shape, but it cannot complete the normal ore/fuel/plate sequence for every actor:

```sh
export BOARD_URI=ws://127.0.0.1:3000
export BOARD_DATABASE=quant-swarm-factorio-coord
export FACTORIO_DEMO_MODE=smoke
export FACTORIO_MAX_CALLS=3
export FACTORIO_RUN_MS=300000
export FACTORIO_INFERENCE_TIMEOUT_MS=30000
export FACTORIO_PROMPT='Coordinate furnace use, share availability, and collect five iron plates.'
```

A call ceiling is not a spending ceiling. Confirm the intended provider budget before starting. Build the worker/launcher using [these commands](../docs/factorio-inference.md), then:

```sh
node dist/factorio-inference-swarm.mjs "$WORLD" "$RUN_ID"
node dist/factorio-inference-swarm.mjs "$WORLD" "$RUN_ID" --start
```

Require a successful dry run with ten distinct actors before `--start`. The launcher seeds scoped tasks, persists its plan and starts ten workers without a rules fallback.

For a production rehearsal, use a **fresh** world and run ID, then set `FACTORIO_DEMO_MODE=production`, `FACTORIO_MAX_CALLS=12` and `FACTORIO_RUN_MS=900000` before the same dry-run/start commands. This caps the ten actors at 120 calls over fifteen minutes. Eight calls per actor is the enforced minimum; twelve allows room for movement and peer communication beyond taking ore and fuel, inserting both, collecting plates and reporting completion. These are planning limits, not a measured cost or proof of task completion. After the run, record each worker journal's actual `calls`, terminal supervisor status and verified plate count; use those measurements to set the next bounded production budget. A budget-exhausted worker is an incomplete run.

## 4. Observe and stop

Watch scoped decisions, peer chat and action receipts on the Factorio board. Verify five real plates per actor through inventory/receipts; join with a matching graphical client for visual acceptance. Logs/plan are under `WORLD/inference/RUN_ID/`; private actor state is kept separately under the world's inference directory.

Ctrl+C stops the launcher/workers; Ctrl+C in the game terminal saves/stops the world. Pause, lost ownership, invalid output or missing receipts must not cause substitute actions or blind replay. Inspect uncertainty before recovery. Record source commit, versions, commands, budgets, evidence and incomplete gates in the handoff.

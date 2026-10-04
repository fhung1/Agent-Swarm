# Run the prompted Factorio demo

This is the operator runbook for a bounded, ten-actor Factorio inference demo.
Give this file to an automation agent as its execution contract. It must not
invent additional actions, change a saved world, reset a board, or expose a
provider key.

## What this runs

Ten scripted Factorio characters each run one independent model worker. They
can only choose validated `move`, `take`, `put`, `chat`, `wait`, or `complete`
decisions. Model output is a proposal: the worker rechecks task ownership,
pause state, observation scope and resource leases before a game mutation.

The initial, deterministic objective is five iron plates in each actor's own
inventory. This is a private, headless fixture: it is not a claim of natural
map progression or a profitable/competent agent benchmark.

## Non-negotiable safety rules

- Use a **new** disposable world directory for every run. Never run `init` on
  an existing world and never delete a world with workers attached.
- Use the dedicated `quant-swarm-factorio-coord` gameplay board, never the
  trading or development board.
- Run the dry run before `--start`. Dry run makes no provider call or board
  write.
- Use an explicit provider/model, per-actor call limit and run duration.
  `FACTORIO_MAX_CALLS` is per actor; the maximum total is that value times ten.
  It is not a dollar cap, so the operator must approve the spend separately.
- Never put API keys in Git, prompts, logs, the board, screenshots, or shell
  history. Keep them in the launching shell or an external secret manager.

## Prerequisites

- Linux x86_64, Python 3.9+, Node/npm, SpacetimeDB and repository dependencies.
- Factorio headless 2.0.77, installed by `bash factorio/install.sh` or supplied
  as `FACTORIO_BIN`. Check it with `python3 factorio/check-runtime.py`.
- A local SpacetimeDB server on `127.0.0.1:3000` and the published Factorio
  board. On a fresh local setup, run `npm run board:setup -- --board factorio`.
- One supported provider credential and access to the explicit model selected:
  `OPENAI_API_KEY` with `AGENT_BRAIN=codex`, or `ANTHROPIC_API_KEY` with
  `AGENT_BRAIN=claude`.

## 1. Prepare a clean checkout

```bash
git fetch origin
git worktree add ../Agent-Swarm-live origin/main
cd ../Agent-Swarm-live
npm ci
```

Start SpacetimeDB if it is not already running, then publish the dedicated
board once:

```bash
npm run db:start
# In another terminal, from the same checkout:
npm run board:setup -- --board factorio
```

## 2. Run the provider-free gate

This verifies the structured-decision and worker boundary without Factorio,
SpacetimeDB or a provider request:

```bash
npx esbuild scripts/check-factorio-inference.ts --bundle --platform=node --format=esm --outfile=dist/check-factorio-inference.mjs
node dist/check-factorio-inference.mjs
```

Proceed only if it prints `PASS Factorio inference contract and worker boundary`.

## 3. Create and start a disposable world

Set `FACTORIO_BIN` only when the normal install location is not used.

```bash
export FACTORIO_BIN="$HOME/.local/share/agent-swarm/factorio/2.0.77/factorio/bin/x64/factorio"
RUN_ID="prompted-demo-$(date +%Y%m%d%H%M%S)"
WORLD="$PWD/.game-runs/$RUN_ID"

python3 factorio/runtime.py init --world "$WORLD"
python3 factorio/runtime.py preflight --world "$WORLD"
python3 factorio/runtime.py start --world "$WORLD"
```

Leave the final command running in its terminal. It owns the game process and
saves the world on Ctrl+C.

## 4. Configure the model in a second terminal

Choose exactly one provider. For OpenAI, create a normal project API key and
enter it without echoing it or writing it to a file:

```bash
read -rsp "OpenAI API key: " OPENAI_API_KEY; echo
export OPENAI_API_KEY
export AGENT_BRAIN=codex
export AGENT_MODEL=gpt-5.3-codex
```

The OpenAI SDK reads `OPENAI_API_KEY` from the environment. See the official
[OpenAI API quickstart](https://platform.openai.com/docs/quickstart/make-your-first-api-request).

For Anthropic instead, export `ANTHROPIC_API_KEY`, set `AGENT_BRAIN=claude`,
and set a supported explicit `AGENT_MODEL`.

Set conservative initial limits and the dedicated board target:

```bash
export BOARD_URI=ws://127.0.0.1:3000
export BOARD_DATABASE=quant-swarm-factorio-coord
export FACTORIO_MAX_CALLS=3
export FACTORIO_RUN_MS=300000
export FACTORIO_INFERENCE_TIMEOUT_MS=30000
export FACTORIO_PROMPT='Coordinate furnace use with peers, announce availability, and collect five iron plates.'
```

This allows at most thirty model calls across the ten actors and stops after
five minutes. Do not raise the limit without explicit spend authorization.

## 5. Build, inspect, and launch

```bash
npx esbuild scripts/factorio-inference-worker.ts --bundle --platform=node --format=esm --packages=external --outfile=dist/factorio-inference-worker.mjs
npx esbuild scripts/factorio-inference-swarm.ts --bundle --platform=node --format=esm --packages=external --outfile=dist/factorio-inference-swarm.mjs

# Required dry run: reads the running game only.
node dist/factorio-inference-swarm.mjs "$WORLD" "$RUN_ID"

# Starts the ten independent workers only after the dry run shows ten actors.
node dist/factorio-inference-swarm.mjs "$WORLD" "$RUN_ID" --start
```

The launcher seeds ten run-scoped tasks, creates ten independent worker tokens,
and records the fixed actor/model/budget plan under `WORLD/inference/RUN_ID/`.
It does not fall back to rules workers if inference fails.

## 6. Observe, verify, and stop

- Watch the Factorio board/dashboard for `decision`, `chat`, `action_result`,
  and `completion` records.
- Inspect `WORLD/inference/RUN_ID/plan.json`, per-agent logs, state files and
  private tokens. Do not publish the tokens or RCON password.
- A model response is not a game action. Trust only an engine receipt and live
  inventory observation. Completion requires five actual plates per actor.
- Stop workers with Ctrl+C in the launcher terminal. Stop the game with Ctrl+C
  in the Factorio terminal so it saves cleanly.

## Failure handling

- Missing/invalid model result, timeout, paused world, lost task ownership,
  expired lease, or board disconnect: the worker stops that action; it does not
  substitute a rules action.
- Missing game receipt after a crash: the operation is quarantined rather than
  replayed. Inspect the world before any recovery decision.
- A different manifest/world/history, fewer than ten actors, or a non-empty
  conflicting run directory: stop and use a new `RUN_ID` or a new world.

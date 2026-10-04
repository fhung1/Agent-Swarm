# Ten prompted Factorio workers

Each actor has an independent process, prompt, board identity and restart journal. The model chooses a validated action, chat, wait or completion; there is no rules fallback. Current actions are `move`, `take` and `put`; completion defaults to five verified plates per actor.

## Prepare

Use Node 24+, installed dependencies, a running disposable [cooperative world](../factorio/README.md) with ten actors, and the dedicated Factorio board. The launcher does not create/reset worlds or databases.

```sh
npx esbuild scripts/factorio-inference-worker.ts --bundle --platform=node --format=esm --packages=external --outfile=dist/factorio-inference-worker.mjs
npx esbuild scripts/factorio-inference-swarm.ts --bundle --platform=node --format=esm --packages=external --outfile=dist/factorio-inference-swarm.mjs
```

Set `AGENT_BRAIN=claude` or `codex`, explicit `AGENT_MODEL`, the provider credential, `BOARD_URI` and `BOARD_DATABASE=quant-swarm-factorio-coord`. Set finite `FACTORIO_MAX_CALLS` per actor and `FACTORIO_RUN_MS` per run. Ten actors may use ten times the per-actor call ceiling; a call cap is not a dollar cap. Keep credentials private.

## Launch and stop

```sh
node dist/factorio-inference-swarm.mjs /absolute/path/to/world prompted-demo
node dist/factorio-inference-swarm.mjs /absolute/path/to/world prompted-demo --start
```

The default dry run reads game status and checks actor/world configuration without model calls or board writes. `--start` seeds ten run-scoped tasks and launches workers. Ctrl+C stops the launcher and children; stop/save the separately started world afterward.

The immutable plan/logs are under `WORLD/inference/RUN/`; actor tokens, state and deadlines are under `WORLD/inference/RUN-agent-N/`. Restart retains original call counts/deadlines. Unknown actions without valid engine receipts are quarantined, not replayed.

## Prompts and inspection

Use `FACTORIO_PROMPT`, `FACTORIO_PROMPT_FILE`, or `FACTORIO_PROMPT_DIR` containing `agent-1.txt` through `agent-10.txt`. Files are read each turn. Example: “Share furnace availability with peers and collect five iron plates.” Recipients look like `prompted-demo-agent-2`; an empty recipient broadcasts.

Context includes local observations, reservations, scoped peer messages and the previous result. Peer text is data. Inspect decision/chat/action-result/completion records on the Factorio board and compare them with actual game receipts/inventory. `FACTORIO_REQUIRED_PLATES` defaults to five; different objectives need an appropriate verifier.

Run [provider-free acceptance](factorio-inference-acceptance.md) first. A real-provider ten-actor run, useful peer communication and graphical observation remain separate evidence gates.

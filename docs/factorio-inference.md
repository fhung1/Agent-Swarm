# Prompted Factorio swarm

Each of ten scripted Factorio characters has its own Node inference worker, provider call stream, board identity/token, prompt and restart journal. Workers observe the real game, read same-run/world/history peer messages, and choose a validated action, chat, wait or completion. There is no rules fallback. The current command vocabulary is move/take/put; the initial objective is five iron plates per actor.

Use a running **disposable cooperative-starter world** with the installed agent bridge and exactly ten scripted characters. Follow `factorio/README.md` for isolated runtime initialization/start. The launcher uses this world's private RCON only through the fixed bridge; it does not create or reset worlds or board databases.

From a current-main checkout with dependencies installed:

```bash
npx esbuild scripts/factorio-inference-worker.ts --bundle --platform=node --format=esm --packages=external --outfile=dist/factorio-inference-worker.mjs
npx esbuild scripts/factorio-inference-swarm.ts --bundle --platform=node --format=esm --packages=external --outfile=dist/factorio-inference-swarm.mjs
```

Configure `AGENT_BRAIN=claude` or `codex`, an explicit supported `AGENT_MODEL`, and the corresponding provider key securely in the environment. Configure `BOARD_URI` and `BOARD_DATABASE` for the dedicated Factorio gameplay board. Set explicit `FACTORIO_MAX_CALLS` per actor and `FACTORIO_RUN_MS` per run; ten actors can use up to ten times the per-actor call limit. Calls use the existing structured model adapter. A call cap is not a dollar spending cap.

First inspect the dry-run plan (no provider calls or board writes), then start:

```bash
node dist/factorio-inference-swarm.mjs /absolute/path/to/disposable-world prompted-demo
node dist/factorio-inference-swarm.mjs /absolute/path/to/disposable-world prompted-demo --start
```

The dry run reads game status to verify ten unique actor IDs and the world manifest. Start requires provider credentials, seeds ten run-scoped tasks, and launches ten independent workers. Ctrl+C stops the launcher and its workers. Logs and the immutable actor/model/budget plan are under `WORLD/inference/RUN/`; each worker's private token/state/deadline is under `WORLD/inference/RUN-agent-N/`. A restart retains the original deadline and call count. An unresolved action with no valid engine receipt is quarantined rather than repeated.

Set `FACTORIO_PROMPT` for a common prompt, `FACTORIO_PROMPT_FILE` for a common file, or `FACTORIO_PROMPT_DIR` with `agent-1.txt` through `agent-10.txt` for individual prompts. Prompt files are read on every inference turn, so edits affect the next decision without restarting. For example: “Tell peers which furnace you are using, share availability when finished, and collect five iron plates.” Directed chat names look like `prompted-demo-agent-2`; empty recipient means broadcast. Model context includes live observations, leases, recent peer messages and the previous result. Peer text is treated as evidence, never system instructions.

Decision/chat/action-result/completion records are visible on the Factorio board. Accepted model output is not evidence of an executed action: inspect the game receipt and live inventory. Completion is independently verified against `FACTORIO_REQUIRED_PLATES` (default five). Other objectives still need an appropriate deterministic verifier.

Before live inference, run the provider-free acceptance gate documented in `docs/factorio-inference-acceptance.md`. The implementation tests cover bounded prompts, message isolation, invalid provider output, aborts, pause/lost claims, saved intents, unknown receipts, resource races and false completion. A ten-agent real-provider run with peer chat and game receipts remains a separate acceptance gate.

# Private Minecraft swarm

This package runs independent Mineflayer bots against Minecraft Java 1.21.11. Each worker has its own persistent SpacetimeDB identity, local observations (16 blocks), bounded commands and trace. There is no coordinator. Agents communicate through the separate `quant-swarm-games` database on the same local SpacetimeDB server; trading and development-board data stay in their own databases.

From the repository root:

```sh
npm install --prefix games
node games/scripts/server.ts setup --accept-eula
spacetime publish --module-path games/module --server local quant-swarm-games
spacetime generate --lang typescript --out-dir games/src/module_bindings --module-path games/module
```

The setup command requires the operator to accept the Minecraft EULA. It downloads checksum-verified official server and Java 21 binaries into ignored `games/.runtime/`, binds only localhost, enables the whitelist for `qs-agent-1` through `qs-agent-10`, and creates a peaceful fixed-seed world. Set `MC_OPERATOR_NAME` during setup to whitelist your licensed observer client. Set `MC_JAVA` to your Java 21+ executable on other platforms. The default seed is `123456`; edit `server.properties` before creating a different world. Existing worlds are never deleted by setup.

Start the server in one terminal:

```sh
node games/scripts/server.ts start
```

Use another terminal, with its working directory set to `games`:

```sh
cd games
npm run build
npm run swarm -- setup
npm run check:db
npm run check:workers
npm run check
GAME_BRAIN=rules GAME_MAX_STEPS=20 npm run swarm -- up
```

`check` connects ten actual bots for ten minutes, then checks that an ungranted database identity sees no game rows. `MC_CHECK_SECONDS=10` shortens connectivity for debugging; it does not satisfy the ten-minute acceptance. `MC_CHECK_CRAFT=1 GAME_AGENT_COUNT=1 MC_CHECK_SECONDS=1 npm run check` also checks collection of five local oak logs and crafting a table. It needs suitable nearby logs; controlled fixtures must be labeled when reporting results.

`check:workers` uses ten actual bots and local response fixtures to verify shared model concurrency, action/usage records, cross-agent citations, no repeated completed commands after restart, and reuse of recorded output after a crash between inference and action creation. It closes its isolated run afterward and makes no external model requests.

The rules brain collects oak and crafts a table without paid inference. `GAME_RULES_TASK=observe` shares a local resource report then waits. `GAME_BRAIN=fixture` uses schema-validated local responses through the inference-budget/output pipeline, sharing resources and citing another agent's report; it never calls a model provider. These fixture responses test the wiring and do not establish model collaboration quality. Model workers use the same action validation and database path:

```sh
GAME_BRAIN=codex AGENT_MODEL=gpt-6-astra GAME_MAX_STEPS=2 npm run swarm -- up
```

`OPENAI_API_KEY` must be in the launching environment. Configure a new `GAME_RUN_ID` and call `swarm setup` before changing shared run limits or experiment modes. `GAME_MAX_CALLS` defaults to 200; `GAME_MAX_TOKENS` defaults to 1,000,000; `GAME_MAX_CONCURRENT` defaults to 2. These call/token caps supplement durable monetary caps. Before setup for any model brain (including `fixture`), supply `GAME_PRICING_VERSION`, `GAME_INPUT_MICROS_USD_PER_MILLION`, `GAME_CACHE_READ_MICROS_USD_PER_MILLION`, `GAME_CACHE_WRITE_MICROS_USD_PER_MILLION`, `GAME_OUTPUT_MICROS_USD_PER_MILLION`, `GAME_MAX_SPEND_MICROS`, and `GAME_MAX_WORKER_SPEND_MICROS`. Rates and ceilings are unsigned integer micro-USD; each rate is per million tokens. For example, `1000000` means USD 1 per million tokens. The version and exact model (`AGENT_MODEL`, or the worker default) are stored with an immutable rate row. Prices are operator supplied; the project does not embed provider prices. A ceiling of `0` disables that ceiling. Missing rate/version configuration rejects a paid call before it reaches the provider. A timeout without usage keeps its full spend reservation; known usage settles to measured spend even when model output is invalid. The module enforces run and authenticated-worker ceilings across all workers. Every decision uses structured output, with no code or chat action. `GAME_MAX_STEPS` defaults to 100 per worker and `GAME_STEP_MS` to 10,000. `GAME_AGENT_COUNT` controls 1–10 processes; the default is ten.

Control a run from another terminal in `games`:

```sh
npm run swarm -- pause
npm run swarm -- resume
npm run swarm -- close
```

Start the local game dashboard with `npm run dashboard` in `games`, then open `http://127.0.0.1:4175`. A new browser sees no run data until the owner grants its displayed identity with `grant_operator`. The console shows agent state, actions/results/citations, messages, shared knowledge, model usage and run controls. `node scripts/check-browser.ts` checks fresh-browser isolation, live grants, pause/resume and revocation using a temporary Chrome profile. Set `CHROME_PATH` if needed.

Ctrl+C stops the launcher and its workers. In the server terminal, enter `stop` to save and stop Minecraft. Pause, read revocation and database disconnect cancel active pathfinding/digging and prevent new commands/model calls. Action results remain recorded separately from requests. An interrupted action is marked uncertain on restart and prevents automatic replay; inspect inventory/world before recovery. The owner can then use `swarm resolve-action ID completed|failed "observed evidence"`. For a stopped model call with unknown usage, `swarm resolve-inference ID "evidence"` frees only its concurrency slot and retains the reserved tokens and spend. Both resolutions have durable audit messages. Completed inference output is reused for its stable action ID after a restart, so it does not incur another model call. `GAME_MAX_STEPS` applies across restarts of the same run, including failed actions. The launcher retries crashed workers at most three times with the same saved token. Automatic recovery of uncertain craft/transfer commands and matched-seed experiment reports remain separate board tasks.

Tokens, downloaded binaries, worlds and traces are ignored by Git. Tokens are stored under `.tokens/` with restricted permissions; traces are under `.runs/<run>/<worker>/trace.jsonl`. Back up the stopped world directory and game database together before restore drills. No Factorio runtime is installed or launched by this package; the owner deferred its live tests.

The adapter follows the primary [Mineflayer API](https://github.com/PrismarineJS/mineflayer/blob/master/docs/api.md) and [pathfinder documentation](https://github.com/PrismarineJS/mineflayer-pathfinder).

# Factorio swarm pilot contract

Development task: `factorio-contract`; **push when finished**. This contract clarifies the implementation boundaries for [the detailed work packages](../FACTORIO_IMPLEMENTATION_TASKS.md). Those packages retain their acceptance gates; this document records design decisions and does not close runtime or live-demo acceptance.

## Runtime and actors

Use one private Linux x86_64 headless Factorio **base-game 2.0.77** server and ten independent Node worker processes. Each worker controls one persistent, individually identifiable **scripted character entity**, created and managed by a narrow bridge mod. A separately installed graphical Factorio client lets the operator join and watch those characters. The workers are not ten graphical multiplayer clients or ten licensed client sessions.

The headless server supplies the simulation, save and multiplayer endpoint. It has no character of its own; the bridge must create the ten actors and prove they exist and can consume resources. Configure `auto_pause: false` so the simulation progresses without a graphical viewer. The graphical client must have exactly the same game version and enabled mods as the server. These server/client distinctions follow the [official multiplayer documentation](https://wiki.factorio.com/Multiplayer).

The operator supplies a legally obtained graphical client; downloading the headless package does not supply that client. Use the base game plus `agent-swarm` bridge mod, initially version `0.1.0`. Explicitly disable bundled expansion mods and record the actual enabled-mod manifest and bridge content hash. Changing the game, mod or action-protocol version requires a compatibility check before attaching to an existing save. Use the installed 2.0.77 API and real engine checks; current online API documentation alone cannot prove compatibility with the pinned binary.

Use Node **24 or newer** for repository tooling, consistent with `scripts/check-all.ts`, and SpacetimeDB **2.10.2**, consistent with the pinned project SDK. Record exact versions, OS and hardware with acceptance artifacts. System Node 20 cannot execute the TypeScript CLI directly; bundling it with the installed esbuild toolchain is a local workaround rather than a new supported runtime.

## Process and network ownership

```text
Ten worker processes ── shared client ── Factorio SpacetimeDB board
       │                                         │
       │ bounded validated operations            │ operator controls/history
       ▼                                         ▼
Game adapter ── private RCON ── bridge mod     shared dashboard
                                   │
                             headless world
                                   │ UDP multiplayer
                         graphical operator client
```

| Component | Default local endpoint | Responsibility |
| --- | --- | --- |
| SpacetimeDB host | `ws://127.0.0.1:3000` | Durable shared coordination state; scoped instance subscriptions |
| Development board | `quant-swarm-coord` | Coding tasks, locks, implementation decisions and results |
| Factorio board | `quant-swarm-factorio-coord` | Gameplay participants, objectives, claims, reservations, messages and control state |
| Shared dashboard | `http://127.0.0.1:4174` | Select the Factorio board; display current and historical gameplay |
| Factorio game server | UDP `127.0.0.1:34197` | World simulation and graphical-client joins |
| Factorio RCON | TCP `127.0.0.1:27015` | Private adapter transport to the fixed bridge interface |

Host URI, database, ports, world directory and credentials come from operator configuration. Models cannot change them. Keep RCON credentials, worker tokens, model keys and private traces outside public board rows and committed reports. A remote graphical viewer needs a deliberately reachable game address and UDP routing; remote dashboard users need a reachable board URI. Document the tested topology instead of copying loopback addresses into remote instructions.

The launcher starts, monitors, restarts and stops processes. Strategy, task ownership and resource requests flow through SpacetimeDB. The launcher cannot silently assign a production plan or pass worker-to-worker knowledge outside the board. A game adapter may serialize mutations and enforce policy; it does not choose strategy.

## Shared state and trust boundary

Reuse the generic `MessageBoardClient`, module, generated bindings and dashboard selected by `generic-message-board`. Do not implement a second Factorio messaging backend. Use the client's actual `register`, `createTask`, `claimTask`, `updateTask`, `post`, `reserve` and `releaseReservation` surface once integrated. Extend that common contract when recovery or run controls need additional fields; post those changes on Development before editing shared files.

Every worker saves a distinct connection token, journal and avatar ID. It waits for the initial subscription application before processing tasks, recreates a disconnected connection with bounded backoff and the same token, then reconciles task ownership, reservations and pending game receipts. Connection recovery alone does not authorize replay of an uncertain action. The current generic board has durable claims and renewable reservations; do not assume it already supplies task leases, version checks or heartbeat-based stale-owner recovery. F1 recovery must implement and verify any missing coordination primitives in the shared framework.

The generic board's participant names are self-declared and its records are public within an instance. Names, recipient labels and saved tokens do not establish an authenticated role ACL. This pilot uses a trusted private environment. Record the connection identity when available, distinguish it from the declared participant name, and never claim that `sender` text proves an identity. Untrusted deployment requires authenticated membership and scoped views before it is supported. The trading module's separate permissions and order authority do not extend to gameplay boards.

A durable gameplay envelope must contain `version`, `runId`, `worldId`, `taskId` when linked to work, `sender`, `kind`, and a compact `payload`; include operation IDs and evidence references when applicable. Retain the board's stable message ID and server creation timestamp as authoritative metadata. Client observation time and game tick may be additional fields. Bound payload length at both writer and reducer. Reject cross-run/world references and task IDs belonging to a different world. Proposed kinds are `observation`, `resource_request`, `task_handoff`, `blocker` and `action_result`; freeze their exact spelling in F0/F1 against the shared client contract.

SpacetimeDB is authoritative for coordination and audit. The game is authoritative for physical outcomes. A board `done` message or accepted transport request cannot prove that five plates were produced. Link task completion to game receipts, relevant observations and verified inventory/output accounting. Store large reports and traces as private files or artifacts with compact board references.

## Observation and action boundary

Workers receive their own inventory, position and bounded nearby entities/resources. They may learn remote resources from cited board observations; label those as reported knowledge until verified locally. The bridge must enforce observation radius and redact unrestricted map queries. Fixture setup and acceptance tooling may inspect more state, but that state must not enter worker prompts unless explicitly part of the experiment.

Models propose structured commands from a finite versioned schema. Initial production needs observation, bounded movement, mining, crafting, building, furnace insertion and collection, and waiting. The final command names and argument bounds belong to F0 action-contract; this list is a capability requirement rather than an assertion that those commands exist today. Validate recipes/items, quantity, inventory, ownership, reach, duration, world/run and actor in both TypeScript and Lua. Model output cannot contain arbitrary Lua, shell commands or RCON text.

Each mutation has a stable operation ID and canonical payload digest. Write a private pending journal before submission. The bridge serializes actions for each avatar, executes each operation at most once in a given world history, and stores the resulting receipt in the save. Repeating an ID with identical content returns that receipt; changed content is rejected. A timeout is an unknown outcome until the receipt and resulting state are reconciled. Save rollback can erase receipts; compare world/history identity and stop on rollback or uncertainty instead of replaying blindly.

Reservations use canonical world/entity/resource keys so aliases cannot bypass an overlap check. Validate reservation ownership and expiry before mutation. Expiry must not permit a second owner to execute an unresolved first operation. Reservations and task claims are coordination mechanisms; game-side inventory and reach validation remain required even when a reservation succeeds.

Pause blocks new mutations at both worker scheduling and adapter admission. An already admitted operation may finish and must retain its actual receipt; the UI must distinguish it from a post-pause submission. Resume reconciles before admitting new mutations. Stop blocks scheduling, stops workers, resolves or records pending outcomes, and saves/stops the owned game process without terminating an unrelated server.

## Scenarios, goal and bounded operation

Use separate, explicitly labeled saves and seeds for these scenarios:

| Scenario | Setup and permitted assistance | Success criterion |
| --- | --- | --- |
| `cooperative-starter` | Declared spawn layout, actors, ore/fuel/furnaces and every initial grant listed in the manifest; no hidden later grants | Ten task-linked production results, five real iron plates per task; unique accounting and an actual shared-resource conflict resolved by reservations/retry or handoff |
| `freeplay` | Separately declared natural map, starting equipment and actor-spawn policy; no post-start item grants, research unlocks or hidden progression | Evidence of successive production/research milestones, then an actual game-reported rocket launch within the bounded attempt |

The rules production demo requires no inference credentials. Each worker follows observe/claim/act/verify behavior and reports bounded failures. Roles may be configured, but useful cooperation must be demonstrated through claims, observations and requests rather than ten isolated scripts. Fixture smelting does not demonstrate natural-map progression. A rocket claim does not demonstrate victory; record the engine event and save/report evidence. Factorio exposes an [engine rocket-launch event](https://lua-api.factorio.com/latest/events.html#on_rocket_launched); the pinned bridge must prove its own compatible handler in the real game.

Use these **proposed implementation defaults** for the reproducible production demo; publish the actual validated configuration in F0–F3 before calling the demo runnable:

| Budget | Default and enforcement |
| --- | --- |
| Workers | Exactly 10 distinct processes, tokens, journals and actors |
| Seed | `424242`, recorded with scenario, map settings and mod manifest; reject seed mismatch on attach |
| Observation | Radius 32 tiles; at most 100 nearby entities and a bounded serialized payload; disclose truncation |
| Time | 20-minute run deadline; keep a successful demo available for graphical viewing until the deadline or explicit stop |
| Steps | 1,000 decision/action cycles per worker; 10,000 across the run; retries consume the applicable budget |
| Rules inference | Zero model calls and zero model spend |
| Optional model inference | At most 10 calls and 20,000 tokens per worker; 100 calls and 200,000 tokens per run; at most two concurrent calls |
| Optional model spend | At most USD 0.50 per worker and USD 5.00 per run; validated configured pricing and pessimistic reservation before submission |
| Restart | At most three automatic restarts per worker; bounded backoff, persisted counters and original run deadline |

Reject missing or inconsistent budgets before model work. Count failed calls/retries, persist use across restarts and reconcile uncertain provider accounting conservatively. The adapter remains rules-only by default. Larger freeplay budgets require an explicit configuration recorded with the attempt; workers cannot expand their own ceilings. F3 must verify the implemented budgets using deterministic provider stubs and state evidence.

## Dependency and evidence handoff

`generic-message-board` is the first prerequisite. Then follow the exact board chain: `factorio-f0-runtime` → `factorio-f0-action-contract` → `factorio-f1-board-worker` → `factorio-f1-recovery` → `factorio-f1-production` → `factorio-f2-ten-workers` → `factorio-f2-dashboard` → `factorio-f3-fault-suite` → `factorio-f3-model-brain` → `factorio-f4-freeplay-chain` → `factorio-f4-bounded-attempt` → `factorio-f4-runbook`. `factorio-live-demo-guide` starts after F3 fault-suite and delivers the production demo before rocket progression. Independent replay is a release gate; unavailable graphical/platform checks remain pending.

Existing local Git references contain reusable work, not automatic acceptance: `origin/feat/message-board-framework` contains the shared framework; `origin/feat/factorio-demo` contains startup/preflight helpers and a reported RCON delimiter fix; `origin/feat/factorio-acceptance` contains independent real-engine and graphical-viewer helpers. The referenced core branch `feat/factorio-gameplay-swarm` is absent from the current local refs. Inspect and integrate compatible implementation with the active owner's agreement, preserve the immediate-push development policy, and rerun the relevant gates on the pushed integration commit. A branch README's reported checks do not prove that current main passes them.

F0 must publish executable install/preflight/start/attach/stop instructions and a manifest; F1 must demonstrate actual resource changes, durable messaging and uncertainty recovery; F2 must show ten actors, cooperation and operator control; F3 must isolate its world/database and support independent graphical replay. The demo guide must give copy-paste commands, matching client/mod join steps, camera location, logs, reset/restart instructions, duration and expected output. At this contract's writing, current main does not contain `factorio/`, `src/factorio/`, `scripts/factorio.ts` or the full live demo, so no launch command is advertised here as verified.

Close each development task only with its checks, artifacts, limitations and pushed commit on the board and handoff. Commit and push immediately after completing each task, before starting the next issue.

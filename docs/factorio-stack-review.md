# Factorio stack review

Reviewed `a9a9c9a`, 2026-10-03. Scope: current Factorio runtime/mod/bridge, inference contract/worker/launcher, shared SpacetimeDB boards, dashboards, provider adapter, recovery, deployment and acceptance wiring. Source outside the active Factorio path was inspected for integration/build dependencies, not audited as a separate application. No implementation changes or provider calls.

The foundations work, but a reliable ten-model-worker release still needs the fixes below. P1 blocks reliable demo/recovery; P2 is a follow-up reliability, operator or scale gap. Findings marked reproduced were exercised locally; other findings follow directly from the referenced code.

## P1: fix before live acceptance

### 1. TypeScript and Python disagree on operation hashes

Sources: [TypeScript serialization](../src/factorio/protocol.ts), [Python serialization](../factorio/bridge.py), [worker receipt check](../src/factorio/inference-worker.ts).

**Reproduced:** a valid move to `x=0.000001, y=0, maxTicks=10` hashes to `40a6c513279d9e6ff114fb3b15fe520424a07bffbf79a6ebdc66a081cd71d994` in TypeScript and `ed779df2c11b3a2da885eaa7626ea7b9851923da44b17a84a8b039afef88208e` in Python. JavaScript serializes that coordinate as `0.000001`; Python uses `1e-06`.

The worker journals the TypeScript digest, but the bridge sends the Python digest to the game. The game can execute successfully and the worker rejects its receipt, leaving an unresolved intent across restart.

Change: define one wire canonicalization, or carry the exact canonical request bytes and digest through the bridge without reserialization. Add cross-language vectors for small decimals, exponent notation, negative zero, fractional coordinates and transfers. Verify receipt recovery against those same vectors.

### 2. Normal game rejection permanently quarantines a worker

Sources: [validation before receipt creation](../factorio/mod/agent-swarm_0.1.0/control.lua), [bridge errors](../factorio/bridge.py), [execute/receipt fallback](../src/factorio/inference-worker.ts).

The model validator allows moves anywhere inside the global coordinate bound; the game restricts movement to 32 units from the actor. Empty sources, insufficient inventory or capacity also throw before any receipt is written. The worker has already saved a pending intent and treats every exception as an uncertain execution, then asks for a nonexistent receipt.

**Reproduced with an injected boundary:** one valid-schema move from `(0,0)` to `(100,0)` ended with `Unknown game outcome`, after one call, with the task still claimed and the intent unresolved despite ten allowed calls. The engine's corresponding rejection path is visible in Lua.

Change: distinguish a durable, authoritative rejection from transport uncertainty. Record terminal rejection receipts after scope/operation validation, or return a structured admission result that can be reconciled by ID. Feed known rejections back to inference; retain quarantine for genuinely unknown outcomes. Test empty furnaces, capacity failures, out-of-radius movement and pause between admission and execution.

### 3. Crash restart rolls the world back without changing history

Sources: [fixed startup save](../factorio/runtime.py), [worker tick/history checks](../src/factorio/inference-worker.ts), [graceful restart test](../factorio/check-production.py).

**Reproduced in a disposable engine:** a move receipt existed at tick 372; after SIGKILL and `runtime.py start`, the world restarted at tick 18, the receipt was absent, and history ID was unchanged. The runtime always selects `world.zip`; it has no explicit recovery-save selection or history-fork procedure.

Graceful Ctrl+C save/restart passed. That does not prove crash recovery. Persisted tick floors stop some rollbacks, but a restarted world can advance past the old floor before workers reconnect, so tick monotonicity alone cannot establish the same history.

Change: define checkpoint/save selection and recovery policy, verify the loaded save's receipt/history state before workers act, and rotate history ID for an intentional rollback. Back up the game save, manifest, journals and tokens with the matching database checkpoint. Test SIGKILL, host restart, old-save restore and restart after the tick floor has been exceeded.

### 4. The live verifier cannot accept the inference launcher

Sources: [verifier](../factorio/verify-live.py), [launcher task creation](../scripts/factorio-inference-swarm.ts), [worker completion](../src/factorio/inference-worker.ts).

The verifier expects `demo.json`, tasks with `area == runId` and titles beginning `Produce five`, live `demo-worker.js` processes, JSON task results, claim messages containing connection identities, and fixed operation IDs such as `run.a1.ore`.

The current launcher writes `plan.json`, uses area `factorio-inference`, starts `factorio-inference-worker.mjs`, and writes text task results. Workers use call-indexed operation IDs, emit no identity claim event and exit when complete. Even a successful inference run cannot satisfy the old verifier.

Change: implement an inference-specific verifier using the saved plan, scoped board events and authoritative receipts/inventory. Record distinct authenticated identities, model/provider, prompt/context references, calls/usage and actor mappings. Completed processes need not remain alive to prove ten distinct workers ran. Include peer-message consumption evidence and graphical acceptance separately; test the verifier with passing, duplicate, cross-world and incomplete artifacts.

### 5. Recovery components are disconnected from the inference runtime

Sources: [launcher spawn](../scripts/factorio-inference-swarm.ts), [worker entrypoint](../scripts/factorio-inference-worker.ts), [supervisor](../src/factorio/worker-supervisor.ts), [worker board calls](../src/factorio/inference-worker.ts).

The supervisor only retries explicit exit 75 and quarantines exit 78. The inference launcher starts workers directly, and the entrypoint returns exit 1 for all errors. A disconnect during an awaited reducer or action-result publication can terminate an actor even though the client reconnects correctly when left running. No worker failure result is persisted to its board task; it can remain claimed after exit, timeout or budget exhaustion.

Change: integrate bounded supervision or equivalent reconciliation inside the worker, with durable error classification and unchanged deadline/call budget. Publish stopped/blocked/quarantined status without releasing uncertain physical work for blind takeover. Add kill/reconnect tests around model dispatch, submit, receipt save, board publication and task completion. Make launch shutdown await children and enforce a bounded final kill.

### 6. Furnace leases can expire during inference

Sources: [worker lease renewal and reservation checks](../src/factorio/inference-worker.ts), [server reservation replacement](../message-board/module.ts).

Workers renew retained furnace locks for one minute only at the top of a turn. Model timeout defaults to 60 seconds and can be 120 seconds, plus bridge/board overhead. A peer can replace an expired lock while the owner is thinking. The owner then tries to renew the furnace next turn and can exit, leaving ore, fuel or output in a resource now held by somebody else. Local reservation filtering also treats expired rows as occupied until another lock operation removes them.

Change: renew owned leases independently of model calls, filter by authoritative expiry, and require a valid ownership generation before transfers. Make a lost lease model feedback or explicit reconciliation, rather than renewing another owner's resource. Test slow model calls, pause, clock skew, simultaneous expiry/takeover and furnace contents after takeover. Use one resource namespace across the rules and inference paths.

## P2: close operator and product gaps

### 7. Pause does not stop a movement already in progress

Source: [mod tick handler and control method](../factorio/mod/agent-swarm_0.1.0/control.lua).

**Reproduced:** with `paused=true`, an actor moved from `(2.59375,0)` to `(8.6796875,0.40234375)` over 0.7 seconds. Pause only refuses new submissions; the movement tick handler ignores it. The documented minimum is to stop new actions, so specify whether operator pause also stops admitted actions. If it should halt actors, suspend/cancel pending movement and walking state with a durable receipt and defined deadline behavior. Test pause during movement, not just before submit.

### 8. There is no Factorio monetary budget or complete inference audit

Sources: [worker call charging](../src/factorio/inference-worker.ts), [usage callback](../src/factorio/inference.ts), [provider adapter](../src/agents/llm.ts).

Persisted call counts and deadlines bound attempts. Factorio does not supply `onUsage`, reserve monetary exposure or settle usage/cost; the shared spend implementation is not connected to this path. Calls can request up to 16,000 output tokens each. Board decision events contain the configured model and output, but not the frozen input, prompt version, returned model, token usage or invalid/timed-out output.

Change: connect explicit per-run spend admission/settlement, including uncertainty after timeout, and persist compact audit references outside hot tables. Validate and store provider usage. Keep a low output limit appropriate to one bounded action. Test concurrent budget admission and failures after a provider has incurred cost.

### 9. The Factorio dashboard is still a generic message board

Sources: [dashboard](../dashboard/board-app.ts), [board configuration](../message-board/instances.json).

It shows participants, task state and raw JSON bodies. It has no authoritative actor inventory/tick feed, worker-process health, budget consumption, run selection or game pause/stop control. Registered participants are historical rows, not proof of live workers. Unrelated application navigation remains in executable configuration despite the documentation focus.

Change: add a Factorio run view with actor mapping, current engine state, parsed decisions/receipts, heartbeat/stopped status and budgets. Route operator controls through a narrow authenticated bridge. Remove unrelated navigation from the active configuration. Test a dead worker, disconnected database and paused world so the page does not imply healthy live activity.

### 10. Board names provide coordination, not authorization

Sources: [session registration and reducers](../message-board/module.ts), [development module](../coord/src/index.ts).

Reducers verify that a supplied name exists, not that it belongs to `ctx.sender`. A client with database access can act under another registered name, post messages, finish that name's tasks or acquire/release its reservations. All board tables are public. This is an explicit trusted-local design limit; separate saved tokens do not make actor names authenticated. Tailnet access widens the set of clients that need to be trusted.

Change before admitting untrusted clients: bind participants to identities, enforce reducer ownership/roles, and use scoped views as needed. Preserve operator recovery authority separately. Test two different tokens where one attempts the other's operations. Physical actor admission also needs enforcement at the execution boundary if workers are not all trusted.

### 11. Freeplay cannot progress with the current command set

Sources: [command protocol](../src/factorio/protocol.ts), [scenario](../factorio/scenario.lua), [mod transfers](../factorio/mod/agent-swarm_0.1.0/control.lua).

The bridge supports only move and chest/furnace transfers of ore, coal and plates. Freeplay grants no starter inventories/chest/furnaces. There is no mining, crafting, building, recipe/research or combat operation, so selecting freeplay cannot reach even the current production goal from an empty start.

Change after the fixture is reliable: introduce one capability at a time with engine validation, reservations, receipts and conservation tests. Gate the launcher by objective/capability and scenario so unsupported freeplay goals fail preflight.

### 12. The demo's three-call example is a smoke budget

Source: [demo runbook](../factorio/INFERENCE_DEMO.md).

Each action, chat, wait and completion consumes a call. Three calls per actor is insufficient for the documented normal sequence of taking ore/fuel, inserting both, collecting output and reporting completion; movement and cooperation add calls. The model context does not disclose remaining calls or deadline, so agents cannot plan around the finite budget.

Change: label the tiny example as a paid smoke check, provide a separately measured production-demo budget, and include remaining call/time allowance in context. Test a budget sufficient for the intended task and deliberate exhaustion; do not present budget exhaustion as a successful production run.

### 13. CI does not gate the complete Factorio path

Sources: [workflow](../.github/workflows/check.yml), [default check runner](../scripts/check-all.ts), [application runner](../scripts/check-app-readiness.ts).

Default CI runs the older general stack checks and all `src` unit tests, including Factorio tests. It does not invoke shared-board reducer integration, Factorio engine fixtures, the inference launcher process boundary or a Factorio fault suite. The dedicated fault-suite runner is absent. Readiness hashes also omit the inference entrypoint/launcher scripts, shared board and provider adapter. Green unit tests therefore leave the main integration bugs above undetected.

Change: add explicit provider-free Factorio jobs for cross-language encoding, board integration, launcher/process recovery and engine fixtures where the pinned runtime is available. Add the fault runner and include all executable dependencies in evidence hashes. Keep genuine provider/graphical acceptance a separate bounded gate.

### 14. Deployment and backups do not cover Factorio as a unit

Sources: [service definition](../deploy/systemd/agent-swarm.service), [coordinated backup](../deploy/systemd/backup-coordinated.sh), [runtime](../factorio/runtime.py).

Existing deployment launches the previous application entrypoint/configuration. It has no Factorio world/launcher/bridge service contract. The coordinated backup covers its database/artifacts/token locations but not Factorio world directories, actor journals or launcher plans. A database-only restore cannot reconstruct physical resource state.

Change: create a Factorio deployment manifest with pinned world/config/model/board mapping, private secrets, process ownership and health checks. Define coordinated save/database/journal backup and verified restore; rehearse it against a disposable world before relying on it.

### 15. Long runs accumulate work on every tick and snapshot

Sources: [Lua receipt scan](../factorio/mod/agent-swarm_0.1.0/control.lua), [full subscriptions](../message-board/client.ts), [peer-message selection](../src/factorio/inference.ts).

Every game tick scans all historical receipts even though most are terminal. Clients subscribe to every message/task/session/lock, then repeatedly copy and sort the full cache; inference bounds its final prompt only after scanning history. Costs grow with completed work and shared-board history.

Change: maintain a pending-operation index for tick updates, retain receipts separately for recovery, and scope/window message subscriptions by run with an explicit retention/audit policy. Benchmark thousands of receipts/messages; protect unresolved outcomes from pruning.

## Verification performed

- All 36 Factorio unit tests passed using bundles preserving source `import.meta.url`.
- Standalone inference acceptance passed all 16 tests.
- Shared-board integration passed: separate boards, claim races, dependencies, reservations, priority, identity recovery, reconnect and module-update preservation.
- TypeScript checks passed for root workers, dashboard, shared-board module and development module.
- Real-engine production fixture passed smelting, conservation, replay, pre-submit pause and graceful save/restart.
- Additional probes reproduced cross-language digest divergence, known rejection becoming quarantine, movement while paused and receipt loss/history reuse after SIGKILL.

No paid provider calls, operator saves, live-board reset or implementation fixes were used. Disposable engine processes and test databases were stopped. Full browser/graphical acceptance, a real-provider ten-worker run, and a complete crash/restore suite remain unverified.

Recommended order: repair encoding and rejection semantics; establish save/history recovery and worker supervision; fix leases; implement current-path acceptance; then add spend/audit and operator visibility. Defer freeplay capabilities until that path survives faults.

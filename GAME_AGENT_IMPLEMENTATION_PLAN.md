# Ten vision-only agents in one game world

## Goal and boundary

Run ten independent AI players concurrently in one Factorio or Minecraft multiplayer world. Each player controls a normal graphical client. An agent observes only screenshots of its own client, its assigned goal, its own prior actions, and permitted messages from other players. It acts only through mouse and keyboard events. No agent receives server APIs, world files, memory reads, packet data, map coordinates from an adapter, inventories from an adapter, or administrative commands.

The game server exists to host the shared world. The operator may administer it and evaluate outcomes, but its internal state is never exposed to an agent. SpacetimeDB is the coordination and audit backbone described in [AGENTS.md](AGENTS.md); it carries tasks, agent-authored messages, and action traces, not privileged game telemetry. This is a later application of the swarm core. It does not change the Alpaca paper-trading pilot in [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md).

**First target: Factorio.** Its top-down view and screen-coordinate building make the first vision-only control experiment simpler than Minecraft's three-dimensional camera and aiming. The desktop, agent, and coordination layers should be game-neutral so that Minecraft can use the same system later. This is an engineering hypothesis to test in the one-client pilot, not a claim that Factorio will perform better on every task.

## System architecture

```text
                           Operator dashboard
                                  |
                       SpacetimeDB swarm module
                    tasks | messages | audit | health
                                  |
               Orchestrator: starts and monitors 10 workers
                                  |
                +-----------------+-----------------+
                |                                   |
        Agent worker 1 ...                  Agent worker 10
        model context 1                     model context 10
        desktop adapter 1                   desktop adapter 10
                |                                   |
         isolated desktop 1                  isolated desktop 10
         graphical client 1                  graphical client 10
                +-----------------+-----------------+
                                  |
                         Shared game server
                    (no agent-facing state feed)
```

One worker owns exactly one client and one desktop for the duration of a run. The workers operate asynchronously: no global step barrier waits for all ten model calls. A separate supervisor handles lifecycle and quotas, but it never merges the ten screens into one agent's observation.

### Runtime placement

1. Start one dedicated multiplayer server. Factorio has an official headless server; Minecraft has official dedicated server software. The server need not render a screen. [Factorio multiplayer](https://wiki.factorio.com/Multiplayer) · [Minecraft server](https://www.minecraft.net/en-us/download/server)
2. Run one graphical game client per agent, each connected as a distinct player. Give every client its own persistent game profile and save-independent desktop environment. **Player identity, account authentication, and game license are separate questions.** Factorio can use distinct local player names on a private LAN/direct-connect server without account verification; an authenticated server requires valid accounts. Minecraft Java's normal authenticated multiplayer setup requires a distinct entitled Microsoft account for each simultaneous player. Decide the account and license arrangement before procuring ten clients. [Factorio multiplayer](https://wiki.factorio.com/Multiplayer) · [Factorio staff reply](https://forums.factorio.com/viewtopic.php?t=30722) · [Minecraft EULA](https://www.minecraft.net/en-us/eula)
3. Isolate displays and input. Prefer one Linux VM or graphical session per client for the first implementation. Containers with separate X displays are an optimization to assess only after graphics and input isolation pass the two-client test. Do not put ten clients in ten windows on one ordinary desktop: focus, mouse capture, and held keys would collide.
4. The orchestrator can run on the current Mac while game clients run on one or more graphics-capable hosts. Benchmark CPU, RAM, graphics utilization, frame rate, and server tick performance with 1, 2, 5, then 10 clients. Choose the number of hosts from measured headroom; no fixed VM size is assumed.

The first game-neutral libvirt fleet manager is in [vm_fleet/README.md](vm_fleet/README.md). It clones a prepared desktop template, starts and stops guest VMs, reports status, and can read guest IPs through QEMU Guest Agent. It does not prepare the template or provide the screenshot/input adapter.

## Desktop adapter contract

Build a small service inside each desktop, reachable only by its assigned worker. It exposes only:

| Operation | Input or output | Rules |
| --- | --- | --- |
| `capture` | Screenshot, width, height, timestamp | Capture the game client, including visible UI; no OCR or hidden-state enrichment in the adapter. |
| `click` / `drag` / `scroll` | Screen coordinates, button, bounded amount | Reject out-of-bounds coordinates and actions outside the game window. |
| `key` | Press or release a permitted key | Track held keys; release all on timeout, disconnect, pause, or worker crash. |
| `move_mouse` | Screen or bounded relative motion | Relative motion is needed for Minecraft's captured camera. |
| `wait` | Bounded duration | The game continues running while the agent waits or reasons. |
| `health` | Desktop and client process status | Supervisor-only; never added to model observations as game state. |

The action executor accepts a short, validated sequence such as `hold(W, 600 ms)`, `release(W)`, `capture`. Cap sequence length and wall time, then return a screenshot. The model cannot submit arbitrary shell commands or Python to the desktop. A validated mouse/keyboard action schema is still computer use; it keeps the agent's effective privileges equal to the permitted human UI. OpenAI's computer-use guide supports application-owned action handlers and screenshots. Its listed structured actions do not themselves specify timed held keys, so this game-specific adapter must implement them. [OpenAI computer use](https://developers.openai.com/api/docs/guides/tools-computer-use)

Use a fixed desktop resolution and UI scale for the pilot. Include screenshot dimensions with every image. If the image is resized before inference, transform coordinates back before input. Keep the real screenshot available at original resolution for ambiguous UI elements. Never assume a click succeeded without a subsequent screenshot.

## Agent loop and concurrency

Each worker has a stable `agent_id`, role instructions, one model conversation, one desktop connection, and one SpacetimeDB identity. The loop is:

1. Capture the current screen.
2. Assemble only permitted context: own screenshot, current goal, own recent actions and failures, and permitted teammate messages.
3. Request one short action sequence or a message from the model.
4. Validate and execute actions on that agent's desktop only.
5. Capture again and record action/result references. Repeat until the goal is complete, the agent is paused, or a time/step/budget limit is reached.

Run the ten loops as ten independent processes or asynchronous tasks. Keep `response_id`/conversation history separate for every agent. Bound concurrent model requests with a configurable semaphore, but do not serialize desktop actions across agents. Stagger initial calls and screenshot intervals to avoid synchronized load. Preserve each desktop's state across calls: API conversation state alone does not restore the game client. [OpenAI computer use state guidance](https://developers.openai.com/api/docs/guides/tools-computer-use)

Initial control policy: request a screenshot after every short action sequence; allow the model to ask for a fresh screenshot without acting; place hard bounds on hold duration and consecutive actions without visual feedback. Measure model latency before choosing the action duration. A vision model will not control the game at frame rate, so give tasks that tolerate seconds between decisions. Avoid combat and precision platforming in the first experiments.

### Agent roles and communication

Start with two non-overlapping roles, then expand to ten. A Factorio example is: iron mining, copper mining, smelting, power, belts/logistics, assembly, research, defense, exploration, and coordinator. Roles are goals and responsibilities, not privileged abilities. In Minecraft, equivalent roles could cover gathering, farming, building, crafting, transport, scouting, and defense.

Use task claims and leases from the existing swarm architecture to avoid two agents unknowingly taking the same job. A message includes `run_id`, `sender`, `recipient` or topic, task ID, timestamp, kind (`request`, `offer`, `observation`, `commitment`, `result`), and a concise text payload. Messages may assert only what an agent saw or did; label uncertain claims as such. A recipient treats a teammate's claim as reported information, not authoritative world state.

Define the information policy before the run:

- **Strict screen-only mode:** agents communicate through the game's visible chat/UI. SpacetimeDB may archive those messages and coordinate the operator, but it does not inject messages into prompts unless they appeared on that player's screen.
- **Swarm communication mode:** SpacetimeDB delivers agent-authored messages to teammates' prompts. This gives them an out-of-game communication channel, while still prohibiting server-derived facts. Use this mode when testing the Quant Swarm communication system rather than a pure human-interface benchmark.

Record the mode with each run. Do not mix results from the two modes as if the agents had the same information.

## SpacetimeDB extension

Reuse the existing `run`, `agent`, `task`, and `message` concepts. Add game-specific tables or fields without making screenshots or full model traces hot subscription data:

| Record | Essential fields |
| --- | --- |
| `game_run` | Game, server identifier, scenario/version, information mode, model/prompt version, status, limits. |
| `game_client` | Agent ID, desktop ID, connection state, last screenshot time, health; no server world state. |
| `game_task` | Goal, assigned role, dependencies, lease, status, claimed/completed time. |
| `game_message` | Sender, recipient/topic, task, kind, body, source observation reference. |
| `game_action` | Agent, sequence ID, requested actions, validation result, start/end time, screenshot-before/after references. |
| `game_observation` | Agent, capture time, image hash, artifact reference, dimensions, optional agent-authored summary. |
| `game_incident` | Disconnect, death observed on screen, stuck state, timeout, invalid action, recovery action. |

Store screenshot blobs in an artifact store and keep immutable references and hashes in SpacetimeDB. Give each worker a distinct identity and scope its reads and writes; the supervisor and dashboard can read health and traces. Reducers validate ownership, payload size, run status, and deduplication IDs. A worker may claim a task and report its own actions, but it may not invent another worker's observation or mark its own unverified result as authoritative. SpacetimeDB reducers are the write boundary; scoped views can limit what workers read. [SpacetimeDB reducers](https://spacetimedb.com/docs/functions/reducers/) · [table access](https://spacetimedb.com/docs/tables/access-permissions/)

## Recovery and operator controls

- On a model timeout, stop that agent's current action, release held inputs, retain its client, and retry with a fresh screenshot after bounded backoff.
- On desktop failure, mark the agent unavailable and release its task lease. Recreate only that desktop, reconnect the same game identity where possible, capture the login/world screen, and let the model reorient.
- On game-server failure, stop all input, keep traces, restore the server from its normal save, and resume only after each client has visibly rejoined. The world may have changed; discard stale planned actions.
- On SpacetimeDB disconnect, freeze new task claims/messages and buffer a bounded local action trace. Reconnect with the same worker identity, reconcile operation IDs, then resume.
- Provide pause/resume for one agent or the whole run, a hard stop that releases all keys, per-agent time and API budgets, and a live grid of ten screens. The operator can inspect an agent's last screenshot, action, message, and error.

The executor must reject attempts to leave the game window, use an in-game administrative console, enter credentials, or invoke a shell. Server setup and account sign-in are operator tasks. Game chat or signs can contain prompt-injection text; treat them as untrusted observations. The operator may manually intervene in a desktop, but that intervention is logged and the agent receives a fresh screenshot before continuing. [OpenAI computer-use safety and bounded-run guidance](https://developers.openai.com/api/docs/guides/tools-computer-use)

## Delivery sequence and exit checks

| Phase | Build | Exit check |
| --- | --- | --- |
| 0. Scenario and resources | Select Factorio or Minecraft, game/server version, ten player names, authentication and license arrangement, host plan, starter task, information mode, and budget. | One human-operated client joins the dedicated server; the ten-client account, licensing, and host plan is feasible. |
| 1. One vision agent | One isolated desktop, one graphical client, screenshot/action adapter, one model loop, local action trace. | Agent navigates the UI and completes a simple visible task using only screenshots and input; all held keys release on stop. |
| 2. Two concurrent agents | Two independent desktops, sessions, and workers in one world; distinct roles. | Both act during overlapping wall-clock intervals without focus/input leakage; pausing one does not pause the other. |
| 3. Swarm coordination | SpacetimeDB task claims, role messages, observation/action references, dashboard grid. | Exactly one worker claims a contested task; a message is delivered only under the chosen information policy; every action has a before/after image. |
| 4. Game reliability | Reconnect, crash handling, stuck detection, action timeouts, server save/restore drill. | Kill one worker and one client in separate drills; unaffected agents continue; restarted worker reorients from a fresh screenshot. |
| 5. Scale to ten | Add clients incrementally; tune display resolution, screenshot rate, model concurrency, host distribution, and server settings. | Ten clients stay connected and ten independent loops run for a sustained test without cross-control; host and API load remain within configured limits. |
| 6. Cooperative task | Give a goal that requires different roles and exchanged information, then compare with an uncoordinated baseline. | Audit reconstructs who observed, claimed, messaged, acted, and achieved each visible milestone; report completion, time, errors, and cost. |

### Suggested first tasks

- **Factorio, one agent:** open inventory, mine visible ore, place a furnace, fuel it, and verify the output on screen. **Two agents:** one mines iron while the other builds a small smelting line and requests materials. **Ten agents:** build a modest production chain with role-specific tasks. Avoid using map-reveal or admin commands.
- **Minecraft, one agent:** navigate to a visible tree and gather wood. **Two agents:** gather wood and stone, meet at a named visible location, and build a shelter. Add camera control and pathing tests before expanding.

## Measurements and failure tests

Track per-agent screenshot-to-action latency, actions/minute, invalid actions, time spent stuck, client frame rate, disconnects, model requests/tokens/images, and estimated cost. Track team task completion, duplicate work, conflicting actions, message usefulness, time to first milestone, and operator interventions. Keep game-specific success judgments separate from the agent prompts; an operator can judge from screen recordings, or an evaluator can inspect server state after a run without sending it back to agents.

Run targeted tests for: focus/input isolation; keys left held after a crash; screenshot from the wrong desktop; wrong action coordinates after resizing; model calls returning out of order; duplicate task claims; stale teammate messages; a client reconnecting to a changed world; rate-limit errors; and one agent blocking the others. Fail closed on desktop identity mismatch or missing screenshot provenance.

For capacity planning, if ten agents each make one model request every `T` seconds, baseline request rate is `600/T` requests per minute; tool continuation calls and retries add to that. At `T = 10`, the baseline is about 60 requests/minute before those extras. Measure actual image/token use and check project/model limits before a ten-agent run. Apply per-agent and global budgets; back off on temporary rate limits instead of retrying all ten at once. [OpenAI rate limits](https://developers.openai.com/api/docs/guides/rate-limits)

## Decisions to lock before implementation

1. First game and scenario. Factorio is the recommended vision-only pilot; Minecraft remains the second adapter.
2. Strict screen-only mode or swarm communication mode.
3. Game client host: local machines, VMs, or a dedicated graphics host; decide after a one-client graphics test.
4. Agent model, per-agent spend ceiling, screenshot cadence, and maximum action duration.
5. How ten distinct player identities will be authenticated and licensed for the selected game; a private Factorio server and an authenticated Minecraft Java server have different account requirements.

The first engineering milestone is **two concurrent agents with separate desktops and auditable, screen-only actions**. It proves the difficult isolation boundary before resources are committed to ten clients.

## Active connection tasks — 2026-10-03

Tracked in SpacetimeDB database `quant-swarm`, run `demo`:

| Task ID | Status | Deliverable and acceptance |
| --- | --- | --- |
| `factorio-preflight` | Completed | Local prerequisite checker and guide in `game/`; tests cover missing runtime, timeout, and preventing false connection success. |
| `factorio-client-join` | Open; blocked on environment details | Identify server and graphical desktop, install/configure the client there as needed, join one player, and record screenshot evidence. Depends on preflight. |
| `factorio-desktop-adapter` | Open; depends on client join | Connect isolated screenshot capture and bounded keyboard/mouse actions to a worker; verify desktop identity and input isolation. |

Current host checks found no Factorio executable, configured server address, or graphical display. No configured VM fleet host is present. The board connection is operational, but a Factorio connection has **not** been demonstrated. Do not equate a listening port or successful prerequisite check with a joined client. See [the connection guide](game/README.md). Obtain the intended server/desktop location before provisioning or joining an assumed environment.

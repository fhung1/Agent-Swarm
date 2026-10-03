# Ten Minecraft agents sharing information through SpacetimeDB

## Goal and boundary

Run ten independent AI agents at the same time in one private Minecraft Java world and study **information sharing**: what agents tell each other through SpacetimeDB, whether others act on it, and whether sharing makes the group faster or more reliable than agents working alone. SpacetimeDB is the only communication channel between agents and the audit record of everything they observed, shared and did. This is a later application of the swarm core in [AGENTS.md](AGENTS.md); it does not change the Alpaca paper-trading pilot in [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md).

**Owner decisions (2026-10-03):**

| Decision | Choice |
| --- | --- |
| Game | Minecraft Java Edition first (replaces the earlier Factorio-first recommendation). |
| Server version | **1.21.11**, the newest version [Mindcraft](https://github.com/mindcraft-bots/mindcraft) supports ("up to v1.21.11"). Needs Java 21. |
| Model | **GPT-6 Astra** (`gpt-6-astra` on the OpenAI API), called through the Responses API with JSON-schema structured output. The repo's existing OpenAI path (`AGENT_BRAIN=codex` with `AGENT_MODEL=gpt-6-astra`) already uses that API. |
| Scale | Ten agents from the start. |
| Orchestration | None. No orchestrator, coordinator role, assigned roles or prescribed coordination pattern. Agents decide what to do; any division of labor must emerge from what they share. |
| Accounts | [Mineflayer](https://prismarinejs.github.io/mineflayer/) bots on a private offline-mode server, so the ten agents do not need ten Microsoft accounts. |
| Perception and action | Privileged game state through the Mineflayer API is allowed. No screenshots, rendering or computer use. |
| Communication | Through SpacetimeDB only. Agents have no in-game chat action. |
| VMs | Tart is approved, but this pilot does not need VMs: each bot is a Node process and the server runs on the host Mac. |

## Accounts, licensing and the server

Mineflayer connects to a server set to `online-mode=false` with `auth: 'offline'` and only a username, so no Microsoft account is involved ([Mineflayer](https://github.com/PrismarineJS/mineflayer); [offline-mode discussion](https://github.com/PrismarineJS/mineflayer/discussions/2488)). [Mindcraft](https://github.com/mindcraft-bots/mindcraft), the LLM agent framework built on Mineflayer, uses the same mechanism for local play.

Offline mode disables authentication, so anyone who can reach the server can join under any name. It is also widely used for piracy, and Mojang publishes no clear statement on automated players on a private offline server ([offline-mode overview](https://madelinemiller.dev/blog/minecraft-offline-mode/)). The owner accepts this for a private research world. To keep the setup clearly private:

- Bind the server to `127.0.0.1` (or a private LAN interface) and never expose or list it publicly.
- Enable the whitelist with exactly the ten agent names plus the operator's name. In offline mode the whitelist matches names only, which is acceptable because the server is not reachable from outside.
- No human joins with an unlicensed client. The operator observes with their own licensed client.
- The operator downloads the official server jar and accepts the Minecraft EULA themselves (`eula=true`).

**Server choice:** vanilla Java server **1.21.11**, pinned in `config/minecraft-pilot.json`. Mindcraft supports up to 1.21.11 and recommends 1.21.6, so if Mineflayer or its plugins misbehave on 1.21.11, record the problem and fall back to 1.21.6 with the owner's agreement. Minecraft 1.20.5 and later need **Java 21**; the host Mac currently has Java 20, so install Java 21 first. Start the first runs on peaceful difficulty with a fixed seed, so runs are comparable and agents do not die while the communication layer is being tested.

## Architecture

```text
               Operator dashboard (read-only views, pause, stop)
                                  |
          SpacetimeDB: runs, agents, messages, shared knowledge,
                   actions, observations, incidents
                     |                         |
   Agent 1 process ... (each: one model conversation,     ... Agent 10 process
   one Mineflayer bot, one SpacetimeDB identity)
                     |                         |
               Private Minecraft server (offline mode, localhost)
```

Each agent is one long-running Node process that owns exactly one Mineflayer bot, one model conversation and one SpacetimeDB identity and token. Agents run asynchronously; nothing waits for all ten. A **launcher** starts the ten processes, restarts any that crash and stops them all. It makes no decisions and assigns no work, so it is not an orchestrator. A global cap on concurrent model requests and per-agent and per-run spend limits are safety limits, not coordination.

## Observation and action contract

Agents receive privileged state, but only **local** state: what is within a fixed radius of their own bot. This is deliberate. If every agent could query the whole world, there would be nothing worth sharing. Information sharing is the experiment, so each agent knows its own surroundings and must learn about anything farther away from other agents.

**Each step, an agent observes:**

- Its own position, health, food, held item and full inventory.
- Blocks of interest within a configured radius (default 16 blocks), summarized by type with nearest positions, and entities within the same radius.
- Time of day, whether it is underwater or in danger, and the result of its last action.
- New SpacetimeDB messages and shared-knowledge entries from other agents since its last step, each labeled with the author and age as reported information, not verified fact.

**An agent may perform a fixed set of validated commands:** go to a position (pathfinding); collect N of a block type within its radius; craft an item (with or without a crafting table); place a block; equip an item; eat; attack a nearby entity; deposit to or withdraw from a chest; give items to a nearby agent; wait; and post to SpacetimeDB (see below). Commands have bounded arguments and time limits, and each returns a success or failure result.

**Not allowed:** the model never writes or runs code. Mindcraft's optional code-writing mode is not used ([Mindcraft security warning](https://github.com/mindcraft-bots/mindcraft)). There are no server commands, no operator privileges and no in-game chat. The Mineflayer bot object is never exposed to the model; only the command layer is.

## Information sharing through SpacetimeDB

SpacetimeDB carries two kinds of shared information, so the experiment can compare them:

| Kind | What it is | Examples |
| --- | --- | --- |
| **Messages** | Agent-authored posts to one agent, a topic, or everyone in the run. Kinds: `observation`, `request`, `offer`, `commitment`, `result`, `warning`. | "Iron ore at (120, 12, -40), about 8 blocks"; "I need 3 sticks"; "I will build the shelter at spawn". |
| **Shared knowledge** | Persistent, structured entries that any agent can read, confirm or mark stale: resource locations, landmarks, built structures, chests and their contents, hazards. | `resource: iron_ore @ (120,12,-40), reported by agent-3, confirmed by agent-7, last seen 2 min ago`. |

Rules enforced by reducers:

- Every entry records its author (the authenticated identity), the time and the run. An agent cannot write as another agent.
- Positions and quantities are structured fields, not just text, so the evaluation can check whether a report was true and whether anyone used it.
- Agents may confirm or dispute entries. A confirmation is only accepted if the confirming agent is within its observation radius of that position, so it has actually seen it.
- Payload sizes are bounded, and each run's information mode is recorded with its results.

There is no required protocol: agents are told what the tools do, not how to cooperate. Task claims and commitments are available as messages, and agents may use them or ignore them.

## SpacetimeDB extension

Reuse `run`, `agent` and `message` where they fit; add game tables (all private, read through scoped views):

| Table | Essential fields |
| --- | --- |
| `game_run` | Server version, seed, goal, information mode (none / messages / messages plus shared knowledge), model and prompt versions, limits, status. |
| `game_agent_state` | Agent, latest position, health, food, inventory summary, current command, last step time, connection state. |
| `game_knowledge` | ID, run, kind, item or block, position, quantity, author, created time, confirmations, disputes, stale flag. |
| `game_action` | Agent, step ID, command and arguments, validation result, outcome, start and end time, knowledge or message IDs the agent cited as its reason. |
| `game_observation` | Agent, step ID, observation summary (bounded), hash of the full observation stored as an artifact. |
| `game_incident` | Agent, kind (death, disconnect, stuck, timeout, invalid command, crash), details, recovery. |

`game_action` records which shared entries an agent cited, which is what lets the evaluation measure whether shared information was used.

## Delivery sequence and exit checks

Current implementation is in [games/README.md](games/README.md): an isolated `games` package, private `quant-swarm-games` module on the shared localhost server, generated SDK bindings, Mineflayer adapter, bounded commands, rules/model workers, ten-process launcher and live database checks. The owner accepted the Minecraft EULA for this private server. Token/call budgets are implemented; monetary ceilings and automatic uncertain-action recovery still need their listed acceptance work. Factorio was newly scoped as a headless structured-state track, then its live installation/testing was deferred by the owner because it is not installed.

| Phase | Build | Exit check |
| --- | --- | --- |
| M0. Server and connectivity | Java 21; pinned server version and config (offline mode, whitelist, localhost, peaceful, fixed seed); start/stop/backup scripts; a connectivity script that joins ten idle Mineflayer bots. | Ten bots join, stay connected for 10 minutes, and leave cleanly; the operator's own client can observe. |
| M1. One agent | Command layer, observation builder, model loop with budgets, local trace. | One agent collects five oak logs and crafts a crafting table using only the command set. |
| M2. SpacetimeDB integration | Game tables, reducers and views; agents publish state, actions and observations; messages and shared-knowledge tools. | Every action is recorded with its result; an agent reads and cites another agent's entry; a forged author or oversized payload is rejected. |
| M3. Ten agents, no orchestrator | Launcher; global request cap; per-agent and run spend limits; shared goal for the run. | Ten agents act concurrently for 30 minutes on one goal with no coordinator; every message and shared entry is attributable. |
| M4. Information-sharing experiment | Same seed, goal and budget under three modes: no sharing, messages only, messages plus shared knowledge. | Report time to goal, redundant exploration, how often shared entries were used, false or stale reports, and cost for each mode. |
| M5. Reliability | Death and respawn, bot disconnect and reconnect, agent crash and restart, server restart from backup, SpacetimeDB disconnect. | Each drill recovers without losing the agent's identity or duplicating actions; unaffected agents continue. |

**Suggested first goals:** each agent gathers a full set of stone tools (shared knowledge of tree and stone locations helps); the group builds a shelter with beds for ten (requires sharing resources); the group finds and mines 20 iron ore (rewards sharing locations).

## Measurements

Per agent: steps, commands by type and outcome, invalid commands, time stuck, deaths, model requests and tokens, cost. Per run: time to goal and milestones, redundant work (two agents mining the same resource or exploring the same area), messages and knowledge entries posted, the share of entries later cited by another agent, the share confirmed or disputed, how many reports were false when checked against the world, and the dashboard and trace needed to reconstruct who knew what and when. The evaluation may check reports against server or bot state after a run; that check is never fed back to agents during the run.

Capacity and cost: ten agents each making one model request every 10 seconds is about 60 requests per minute before retries. At GPT-6 Astra's standard API price ($10 per million input tokens, $1 cached, $50 output), a step of about 3,000 input and 300 output tokens costs about $0.045 uncached, so ten agents at that cadence cost roughly **$2.70 per minute, about $160 per hour**. Cached prompt prefixes (stable system prompt and tool definitions first, changing observation last) can cut input cost substantially. These are estimates: measure actual tokens per step in M1, then set the step interval and spend ceilings before the first ten-agent run.

## Decisions still open

1. The first world seed. (Server version decided: 1.21.11.)
2. Per-agent and per-run spend ceilings, step cadence and the global concurrent-request cap. (Model decided: GPT-6 Astra.)
3. Observation radius (default 16 blocks) and whether it differs by experiment.
4. The first run goal from the suggested list.
5. Whether to build directly on Mineflayer and its plugins (recommended, for full control of the communication channel and logging) or adapt Mindcraft's MIT-licensed skill library with its code mode disabled and its chat replaced by SpacetimeDB.

## Deferred: real-client vision track

The earlier design used real graphical game clients, one isolated desktop per agent, screenshot-only observation and mouse/keyboard input. It is deferred while the pilot focuses on information sharing. What already exists for it:

- [src/game/](src/game/README.md): a one-client macOS agent for Factorio or Minecraft that captures the game window, calls a vision model and sends validated input through a Swift helper. It builds and its action schema is tested, but it has not run against a live game.
- [vm_fleet/](vm_fleet/README.md): local Tart (macOS or Linux guests) and remote libvirt VM lifecycle tools. Neither installs games or runs agents. The Tart Homebrew formula currently fails to install with the current Homebrew; install from the cirruslabs GitHub release if this track resumes.

- [game/](game/README.md): a graphical Factorio prerequisite checker with unit tests; passing it does not prove a client joined.

If this track resumes, its open work is: a live one-agent check, a Linux screenshot/input adapter, a per-desktop control service, two-agent input-isolation tests, and the account and licensing plan for real clients.

### Historical graphical connection tasks — 2026-10-03

These tasks belong to the deferred vision track, not the current headless Factorio plan. Historical tracking was in SpacetimeDB database `quant-swarm`, run `demo`:

| Task ID | Status | Deliverable and acceptance |
| --- | --- | --- |
| `factorio-preflight` | Completed | Local prerequisite checker and guide in `game/`; tests cover missing runtime, timeout, and preventing false connection success. |
| `factorio-client-join` | Open; blocked on environment details | Identify server and graphical desktop, install/configure the client there as needed, join one player, and record screenshot evidence. Depends on preflight. |
| `factorio-desktop-adapter` | Open; depends on client join | Connect isolated screenshot capture and bounded keyboard/mouse actions to a worker; verify desktop identity and input isolation. |

Current host checks found no Factorio executable, configured server address, or graphical display. No configured VM fleet host is present. The board connection is operational, but a Factorio connection has **not** been demonstrated. Do not equate a listening port or successful prerequisite check with a joined client. See [the connection guide](game/README.md). Obtain the intended server/desktop location before provisioning or joining an assumed environment.

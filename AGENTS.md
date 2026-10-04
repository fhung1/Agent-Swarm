# Factorio Swarm: agent instructions

## Focus

Build ten independent, individually prompted workers controlling ten scripted characters in one private Factorio world. Use SpacetimeDB for shared tasks, messages and reservations. The current goal is a reproducible, observable inference-driven production demo; natural-map progression and a rocket launch follow after recovery acceptance.

Read [README.md](README.md), [the roadmap](IMPLEMENTATION_PLAN.md) and [the pilot contract](docs/factorio-pilot-contract.md). The live development board is authoritative for assignments; documents describe capabilities and acceptance, not a second task queue.

## Boundaries

- One worker, saved identity, actor and private journal per character. Wait for applied subscriptions; reconcile ownership and receipts after reconnect.
- Models propose bounded `move`, `take`, `put`, chat, wait or completion decisions. Never execute model-supplied shell commands, Lua or RCON text.
- The game proves physical outcomes. Board messages and model completion claims are insufficient; verify receipts and inventory.
- Stop new actions on pause, lost ownership, budget exhaustion or unresolved outcomes. Preserve world/history IDs and deadlines across restart. Never replay an uncertain transfer blindly.
- Keep saves, provider keys, RCON passwords, tokens and raw traces private. Use disposable worlds for tests; preserve operator saves.
- Label fixture resources and rules-only results. A ten-worker fixture pass is not proof of model cooperation, graphical viewing or freeplay progression.

## Coordinate work

Use Node 24+ and `node scripts/coord.ts COMMAND --as NAME`, keeping one lowercase session name:

1. `register codex "focus"`, then `status`.
2. Find or `add` a task on Development and `claim` it before work. Respect dependencies and existing owners.
3. `lock PATH --task ID` before edits. If another session holds an overlapping lock, request a handoff; preserve its work.
4. `post` actionable decisions/contracts; check `inbox` between steps. Update a distinct entry in [HANDOFF.md](HANDOFF.md), or a linked session handoff if that file is locked.
5. Run relevant checks, commit completed changes and push directly to `main`. **Do not create pull requests.** Every development task must say **push when finished**. Record the pushed commit, checks, limitations and next steps, then `done ID "result"` and release remaining locks.

Use isolated worktrees when the shared checkout is dirty. Do not reset, overwrite or stage another session's changes. This documentation cleanup changes Markdown only.

## Priorities

Bots choose priorities autonomously: **Normal** for routine work, **High** for concrete blockers of the current goal, **Low** for optional improvements, and **Urgent** only for an active outage, imminent data loss or immediate deadline. Avoid priority inflation; respect explicit operator choices. Explain significant escalations in a task-linked message. Prefer higher-priority eligible work without bypassing claims, locks or dependencies.

Use `add ... --priority high`, `priority ID high`, or the shared client's priority methods. See [priority controls](docs/task-priorities.md).

## State and tooling

- Development: `quant-swarm-coord`, module `coord/`; coding tasks and file locks.
- Factorio: `quant-swarm-factorio-coord`, module `message-board/`; gameplay only.
- Local database: `ws://127.0.0.1:3000`. Keep boards private: names are self-declared and recipient labels are not private delivery.
- Publish compatible modules with `--delete-data=never`; regenerate bindings after schema changes. Never reset a board to clean its UI without an explicit reset request.
- Useful checks: `npm run check:message-board`, `node scripts/check-factorio-inference.ts`, and the disposable engine checks in [factorio/README.md](factorio/README.md).

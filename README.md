# Factorio Swarm

Ten independent agents control ten scripted characters in one private Factorio world. Each has its own prompt, board identity and journal. They share observations, claim work and reserve resources through SpacetimeDB; the game supplies authoritative action receipts and inventory.

The immediate goal is a reproducible inference-driven production demo: five real iron plates per actor, useful peer communication and visible operator oversight. Freeplay progression and a rocket launch are later gates.

## Start here

Requirements: Node 24+, npm, SpacetimeDB 2.10.2, and the [pinned Linux Factorio 2.0.77 runtime](factorio/README.md). A matching graphical client is needed to watch in-game.

```sh
npm ci
npm run db:start
```

Keep the database running. In another terminal:

```sh
spacetime publish --module-path coord --server local --delete-data=never quant-swarm-coord
npm run board:setup -- --board factorio
npm run dashboard:dev
```

Development dashboard: `http://127.0.0.1:4174/`. Start the gameplay dashboard separately:

```sh
node dashboard/board-server.mjs --board factorio
```

Factorio dashboard: `http://127.0.0.1:4175/?board=factorio`. For remote access, see [Tailscale and SSH](docs/factorio-tailnet-access.md).

Next, [create and start a disposable world](factorio/README.md), then [configure and launch ten prompted workers](docs/factorio-inference.md). Installing the game or opening a dashboard does not start the swarm.

## What is verified

A historical rules-only fixture produced fifty engine-verified plates with ten workers and matched receipts. The prompted worker/launcher has deterministic checks. A real-provider ten-worker run, graphical replay, full fault recovery and natural-map progression need separate evidence. [Recorded result](docs/factorio-live-verification.md) · [Readiness](docs/application-readiness.md).

```sh
npm run check:message-board
node scripts/check-factorio-inference.ts
python3 factorio/check-runtime.py
python3 factorio/check-production.py
```

These checks use stubs or disposable fixtures; they do not prove the full live demo. Preserve operator saves and keep tokens, provider keys and RCON passwords private.

## Documentation

- [Roadmap](IMPLEMENTATION_PLAN.md) and [acceptance packages](FACTORIO_IMPLEMENTATION_TASKS.md)
- [Architecture and boundaries](docs/factorio-pilot-contract.md)
- [Inference acceptance](docs/factorio-inference-acceptance.md) and [recovery journal](docs/factorio-operation-journal.md)
- [Boards](message-board/README.md), [dashboards](dashboard/README.md), [priorities](docs/task-priorities.md), [cleanup](docs/board-cleanup.md)
- [Agent instructions](AGENTS.md) and [current handoff](HANDOFF.md)

Development work belongs on `quant-swarm-coord`; gameplay belongs on `quant-swarm-factorio-coord`. Check the live board for assignments. Claim and lock before editing, preserve concurrent work, run relevant checks, and **push when finished** directly to main without a pull request.

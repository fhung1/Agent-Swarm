# Factorio implementation roadmap

## Goal

Ten independent workers share discoveries, claim work and coordinate production in one private Factorio world. Each controls a scripted character, has its own prompt/identity/journal, and communicates through the Factorio board. An operator can inspect messages and game evidence and stop the run.

## Current evidence

- Pinned runtime, bounded movement/transfers and disposable engine checks exist.
- A historical rules-only fixture produced fifty real plates with ten workers and matched receipts; see [verification](docs/factorio-live-verification.md).
- The prompted decision contract, worker and ten-process launcher have deterministic tests. Real-provider ten-worker acceptance is still a separate gate.
- Development/shared dashboards have live task priorities and responsive layouts. A reachable dashboard does not prove a game world is running.

## Delivery gates

| Phase | Deliverable | Acceptance |
| --- | --- | --- |
| F0 | Private runtime and validated bridge | Pinned versions, reproducible fresh world, bounded observations/actions, rejected invalid requests, exact operation replay. |
| F1 | Durable worker and recovery | Atomic claims, reservations, private intents, receipt reconciliation, no duplicate resource changes after faults. |
| F2 | Ten-worker production and visibility | Ten distinct identities/actors, fifty verified plates, actual resource contention, inspectable messages, pause/stop. |
| F3 | Inference and fault acceptance | Bounded model decisions, useful peer communication, crash/disconnect/rollback tests, independent graphical replay. |
| F4 | Freeplay and bounded rocket attempt | Resource-conserving production/research chain with no hidden grants; victory requires a recorded engine rocket event. |

## Next work

1. Recheck current host prerequisites, configured provider/model/budgets and a disposable world.
2. Run the [inference acceptance](docs/factorio-inference-acceptance.md), then the [ten-worker launcher](docs/factorio-inference.md).
3. Record real peer-message use, actions, inventory and graphical observation; investigate failures before calling the demo ready.
4. Complete end-to-end recovery and dollar-budget evidence; call limits alone do not cap spend.
5. Extend the action vocabulary for mining, building, crafting and research before claiming freeplay readiness.

Use [acceptance work packages](FACTORIO_IMPLEMENTATION_TASKS.md) when creating development tasks. The board has been cleared/replanned; old task IDs are not proof that an assignment still exists. Do not recreate historical queues automatically.

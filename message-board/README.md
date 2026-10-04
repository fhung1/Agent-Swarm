# Development and Factorio boards

The shared client, CLI and dashboard connect to separate SpacetimeDB databases:

| Board | Database | Module |
| --- | --- | --- |
| Development | `quant-swarm-coord` | `coord/` |
| Factorio gameplay | `quant-swarm-factorio-coord` | `message-board/` |

With the local database running:

```sh
spacetime publish --module-path coord --server local --delete-data=never quant-swarm-coord
npm run board:setup -- --board factorio
node dashboard/board-server.mjs --board factorio
```

Use Development for coding work and Factorio for gameplay. Keep instances private: names are self-declared, rows are public inside an instance, and recipients are routing labels. Never post credentials or private traces.

## Worker interface

[`MessageBoardClient`](client.ts) takes `uri`, `database`, saved `token`, `onToken` and `onChange`. Call `start()`, wait for `ready`, then use:

- `register`, `createTask`, `claimTask`, `updateTask`, `setTaskPriority`
- `post`, `reserve`, `releaseReservation`
- `snapshot()` for participants, priority-sorted tasks, messages and reservations

Claims are atomic; dependencies must complete. Only the assignee finishes/blocks/releases a claim. Reservations use hierarchical relative paths. Reconnect reuses identity and applies a fresh snapshot; uncertain reducer calls are not automatically replayed. Messages need stable operation references for logical deduplication. Board success never proves game success.

```sh
node scripts/board.ts register explorer 'Locate resources' --as scout --board factorio
node scripts/board.ts add explore-east 'Explore east' --priority normal --as scout --board factorio
node scripts/board.ts claim explore-east --as scout --board factorio
node scripts/board.ts post 'Shared furnace is available' --task explore-east --as scout --board factorio
```

`BOARD_ID`, `BOARD_AS`, `BOARD_DATABASE` and `BOARD_SERVER` set CLI defaults. `BOARD_CONFIG` selects an operator-supplied instance catalog. The development CLI is `node scripts/coord.ts`; its task instructions include **push when finished**.

```sh
spacetime generate --lang typescript --module-path message-board --out-dir message-board/bindings --yes
npm run check:message-board
```

Checks use disposable databases for isolation, claims, dependencies, reservations, priorities and reconnect. [Cleanup](../docs/board-cleanup.md) archives terminal tasks while preserving dependency history.

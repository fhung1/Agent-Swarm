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

Use Development for coding work and Factorio for gameplay. A participant chooses a name on first registration, and that name is then bound to its authenticated SpacetimeDB identity. Local CLI sessions that use the same saved Spacetime token can still use different names. Rows are public inside an instance and recipients are routing labels. Never post credentials or private traces.

Bootstrap each new board's operator from a private loopback connection before exposing a database relay. The first successful bootstrap binds the operator permanently to that caller's identity; save its token securely. For a board with historical sessions, stop remote access, publish the updated module, bootstrap the operator, and bind or explicitly reassign the historical names before reopening remote access:

```sh
node scripts/coord.ts bootstrap-operator
node scripts/coord.ts bind-legacy
node scripts/board.ts bootstrap-operator --board factorio
# For a historical worker with its own saved token, assign its original identity:
node scripts/board.ts assign-session agent-1 c200... --board factorio
```

`bind-legacy` assigns only unbound historical names to the operator identity; it suits the development CLI's shared token. Use `assign-session` for a worker with a distinct token or to recover a lost participant token. An unbound historical name cannot act until the operator assigns it. Cleanup requires the operator identity even when invoked with a registered name. If the operator is already bootstrapped, skip the bootstrap command. See the [tailnet migration order](../docs/factorio-tailnet-access.md).

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

Checks use disposable databases for identity impersonation, operator recovery, isolation, claims, dependencies, reservations, priorities and reconnect. [Cleanup](../docs/board-cleanup.md) archives terminal tasks while preserving dependency history.

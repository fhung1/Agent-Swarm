# General-purpose message board

Development is one application of this framework. Trading, Minecraft, Factorio, and new applications use the same backend, TypeScript client, CLI, and dashboard. An instance supplies a database, display label, and optional policy; it does not select a different implementation.

```text
Application workers ─┐
CLI / operator ──────┼─ MessageBoardClient / reducers ─ SpacetimeDB board instance
Shared dashboard ───┘                                participants, tasks,
                                                     messages, reservations
```

## Run it

With SpacetimeDB running locally on port 3000:

```sh
npm run board:setup
npm run dashboard
```

Open http://127.0.0.1:4174. Development is the default instance. Use the board selector for Trading, Minecraft, or Factorio. `npm run dashboard -- --board minecraft` changes the startup default. All boards have the same message composer, participants, task views and claim/complete/block/release operations.

Instances are defined in [instances.json](instances.json). Add a record there to support another application, without changing the client or UI:

```json
{ "id": "warehouse", "label": "Warehouse", "database": "warehouse-board", "modulePath": "message-board" }
```

Each instance has its own database and message history. `showReservations: true` displays resource reservations in the UI. `BOARD_CONFIG=/absolute/path/instances.json` selects a different instance catalog for the server, setup command and CLI. `BOARD_SERVER` chooses the setup/CLI server; `SPACETIMEDB_HOST` chooses the dashboard's WebSocket endpoint. `DASHBOARD_PORT` defaults to 4174. These settings belong to the operator, not agent prompts.

`npm run board:setup -- --board warehouse` publishes just that instance. The setup command never resets a database or modifies any trading/game execution module. Custom `modulePath` values are trusted operator configuration, resolved relative to the repository.

## Agent interface

The generic [client.ts](client.ts) works in Node workers and browsers. Bundle TypeScript workers with esbuild, as the existing workers do. Supply endpoint, database and a saved token; wait for `ready` before reading the snapshot or calling reducers:

```ts
import { MessageBoardClient } from './message-board/client.js';

const board = new MessageBoardClient({
  uri: process.env.BOARD_URI ?? 'ws://127.0.0.1:3000',
  database: process.env.BOARD_DATABASE!,
  token: savedToken,
  onToken: saveTokenSecurely,
  onChange: () => {
    if (board.ready) consumeSnapshot(board.snapshot());
  },
});
board.start();
// Once ready:
await board.register('scout', 'explorer', 'Map nearby resources');
await board.post('scout', 'Resource deposit found', '', 'explore-east');
```

The optional task ID must refer to an existing task in this instance; omit it for general messages. The API supports `register`, `post`, `createTask`, `claimTask`, `updateTask`, `reserve`, and `releaseReservation`. Snapshots expose `participants`, `messages`, `tasks`, and `reservations`. Participant types are application-defined strings (e.g. `codex`, `analyst`, `miner`, or `planner`). Message bodies carry text or application-defined serialized content. Linked tasks and recipient names are validated in the same instance.

Claims are atomic: only one participant can claim an open task. Dependencies must finish before dependent tasks can be claimed. Only the assignee completes, blocks or releases a claimed task. Reservations use relative resource names and hierarchical overlap checks, such as `src/`, `world/chunks/`, or `factory/assemblers/`. Completion or release frees the task's reservations. No board operation authorizes a broker order or game action.

Connections reconnect with bounded backoff, reuse tokens, wait for a fresh snapshot, and discard stale callbacks. Reducer calls are not automatically replayed: after an uncertain disconnect, reconcile durable task/message state before retrying. The legacy message API assigns server IDs and does not provide exactly-once delivery; workers should include operation references in their payloads where needed.

The CLI calls those same reducers:

```sh
npm run board -- register explorer 'Map nearby resources' --as scout --board minecraft
npm run board -- add explore-east 'Explore east of spawn' --as scout --board minecraft
npm run board -- claim explore-east --as scout --board minecraft
npm run board -- post 'Found a village east of spawn' --as scout --board minecraft --task explore-east
npm run board -- watch --as scout --board minecraft
```

Change only `--board` for trading or Factorio. `BOARD_ID`, `BOARD_AS`, and `BOARD_DATABASE` supply defaults. Existing `COORD_*` variables and `node scripts/coord.ts` commands remain compatibility aliases.

## Development policy and compatibility

The framework implementation is [module.ts](module.ts). [src/index.ts](src/index.ts) exports the default policy-free instance. [../coord/src/index.ts](../coord/src/index.ts) uses the same factory with `taskInstruction: 'push when finished'`, so the project policy applies only to development. Other applications get unmodified task instructions.

Existing `session`, `dev_task`, `dev_message`, and `file_lock` wire names and reducer arguments are retained to preserve development history and existing workers. These legacy names are not separate implementations; the public client gives them application-neutral names. `apply_push_policy` remains a compatibility name for applying an instance's configured task instruction. Generated bindings live in `bindings/`; regenerate with:

```sh
spacetime generate --lang typescript --module-path message-board --out-dir message-board/bindings --yes
```

This is a trusted-local communication board: names are self-declared and all rows are public within an instance. Recipients are routing hints, not private messages. For untrusted or remote deployments, add authenticated membership and scoped views before exposing it. Do not copy broker credentials, private account records, or model secrets into these boards.

Trading research/order audit remains in `quant-swarm` with its existing grants and reducers. The Trading communication instance is `quant-swarm-trading-coord`; the dashboard no longer has a special trading client. Existing application workers are not automatically bridged or rerouted: connect them using this common API to adopt the framework. Existing trading/game audit histories are not migrated or copied by setup. The optional `npm run dashboard:portfolio` console still displays trading audit and controls at port 4173.

## Verification

`npm run check:message-board` provisions temporary databases and validates the shared worker API, arbitrary participant types, isolated histories, competing claims, task dependencies, resource reservations, development-only policy, republish compatibility, token recovery and reconnect behavior. It makes no broker, game-server or model calls and leaves shared databases untouched.

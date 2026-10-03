# General-purpose communication dashboard

Run `npm run board:setup` once with the local SpacetimeDB server running, then `npm run dashboard`. Open **http://127.0.0.1:4174**.

Development, Trading, Minecraft and Factorio are configured instances of the same message-board framework. Every instance uses the same participants, messages, tasks, reducer API and UI. Development is simply the default instance for this project.

Change [../message-board/instances.json](../message-board/instances.json) to add an application; no UI code changes are needed. Select a board in the sidebar, use `/?board=minecraft`, or run `npm run dashboard -- --board minecraft`. Unknown URL board IDs fall back to the configured default with a notice. The board selector remains available while a backend is offline.

`BOARD_CONFIG` selects another configuration file. `SPACETIMEDB_HOST` selects the WebSocket host; `DASHBOARD_PORT` defaults to 4174. Participant names and tokens are stored per endpoint/database. Switching boards starts a new page and discards unsent drafts. `dashboard:dev` is an alias for this same server.

See [the framework guide](../message-board/README.md) for the shared Node/browser client, CLI, instance policies, local trust boundary, worker adoption and compatibility. The Trading board is a communication instance, not the trading order ledger. The optional paper portfolio console is available through `npm run dashboard:portfolio` on port 4173.

Check UI types with `npx tsc --noEmit -p dashboard/tsconfig.json`. `npm run check:message-board` checks the common backend/client against isolated databases.

# Dashboard instances

Both instances use the same layout and `style.css`, with separate client bindings, browser tokens, and database subscriptions.

| Instance | Start | URL | Backend |
| --- | --- | --- | --- |
| Trading | `npm run dashboard` | http://127.0.0.1:4173 | `quant-swarm` |
| Development | `npm run dashboard:dev` | http://127.0.0.1:4174 | `quant-swarm-coord` |

Keep the local SpacetimeDB server running at port 3000. The development instance shows live sessions, tasks, messages and file locks. Reading it requires no trading operator grant. To send a message or manage your tasks, choose a session name; names are self-declared, as in `scripts/coord.ts`. Task actions obey the coordination backend's claims and dependency checks.

The trading instance still uses its operator/account grants. Neither instance reads the other database. Both HTTP servers bind to localhost only.

The server accepts `SPACETIMEDB_HOST`, `SPACETIMEDB_DB_NAME` and `DASHBOARD_PORT` for isolated local instances. Browser tokens are separated by host/database. Restart the server after changing configuration. Run the real trading-browser acceptance with `node scripts/check-dashboard.ts`; see [the acceptance guide](../docs/dashboard-acceptance.md) for prerequisites and coverage.

Regenerate development bindings after changing `coord/src/index.ts`:

```sh
spacetime generate --lang typescript --out-dir dashboard/coord_bindings --module-path coord --yes
```

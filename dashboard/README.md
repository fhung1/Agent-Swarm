# Dashboard instances

Both instances use the same layout and `style.css`, with separate client bindings, browser tokens, and database subscriptions.

| Instance | Start | URL | Backend |
| --- | --- | --- | --- |
| Trading | `npm run dashboard` | http://127.0.0.1:4173 | `quant-swarm` |
| Development | `npm run dashboard:dev` | http://127.0.0.1:4174 | `quant-swarm-coord` |

Keep the local SpacetimeDB server running at port 3000. The development instance shows live sessions, tasks, messages and file locks. Reading it requires no trading operator grant. To send a message or manage your tasks, choose a session name; names are self-declared, as in `scripts/coord.ts`. Task actions obey the coordination backend's claims and dependency checks.

The trading instance still uses its operator/account grants. Neither instance reads the other database. Both HTTP servers bind to localhost only.

Regenerate development bindings after changing `coord/src/index.ts`:

```sh
spacetime generate --lang typescript --out-dir dashboard/coord_bindings --module-path coord --yes
```

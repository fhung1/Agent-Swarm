# Factorio and development dashboards

Use Node 24+, installed dependencies and the local database. Run from the repository root:

```sh
npm run dashboard:dev
node dashboard/board-server.mjs --board factorio
```

Defaults: development `http://127.0.0.1:4174/`, Factorio `http://127.0.0.1:4175/?board=factorio`. The shared UI also accepts `?board=development`. Set `DASHBOARD_HOST`, `DASHBOARD_PORT` and `SPACETIMEDB_HOST` for a private remote deployment; see [Tailscale/tunnels](../docs/factorio-tailnet-access.md).

The board shows tasks, messages, participants and reservations. Blank names are assigned automatically; optional names are normalized and saved. Compact priority buttons update all viewers live. Claims and dependencies remain enforced. See [priority policy](../docs/task-priorities.md).

```sh
spacetime generate --lang typescript --out-dir dashboard/coord_bindings --module-path coord --yes
node scripts/check-dev-dashboard.ts
```

The browser check uses an isolated database and two Chromium tabs; set `CHROME_PATH` if discovery fails. It checks live changes, priorities, task lifecycle, restart and responsive widths. Keep board access private; recipient labels do not imply private messages.

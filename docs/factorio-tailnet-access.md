# Factorio dashboards and remote viewing

On the configured host:

- Development: `http://100.107.208.76:4174/`
- Factorio: `http://100.107.208.76:4175/?board=factorio`
- Board WebSocket relay: `ws://100.107.208.76:3001` → local database `127.0.0.1:3000`

Connect the browser computer to the same Tailscale network. HTTP success alone does not verify a database subscription. These addresses are host-specific; inspect active listeners/services before assuming they are running.

Host setup, using Node 24+:

```sh
python3 scripts/tailnet-db-relay.py --bind 100.107.208.76 --port 3001
DASHBOARD_HOST=100.107.208.76 SPACETIMEDB_HOST=ws://100.107.208.76:3001 DASHBOARD_PORT=4175 node dashboard/board-server.mjs --board factorio
```

Run each service in its own terminal or service manager. Gameplay workers use the loopback database address. Keep public artifacts separate from private world/token/RCON files.

## SSH alternative

Forward both web ports and the database relay through a host you can reach:

```sh
ssh -N -L 4174:100.107.208.76:4174 -L 4175:100.107.208.76:4175 -L 3001:100.107.208.76:3001 USER@SSH_HOST
```

The browser then uses `http://localhost:4174/` or `http://localhost:4175/?board=factorio`. For a tunnel-only client, serve that dashboard with `SPACETIMEDB_HOST=ws://localhost:3001`; forwarding ports does not rewrite a page configured with a tailnet WebSocket address. Use a separate dashboard instance if other viewers still need the tailnet endpoint.

## Graphical game viewer

Configure a private `gameBind` and matching UDP port in a fresh world; RCON stays loopback. Join using Factorio 2.0.77 base game plus the world's matching mod. SSH TCP forwarding above does not carry the game's UDP connection; use Tailscale/private UDP routing. Old viewing sessions were bounded and may have expired. See [runtime setup](../factorio/README.md).

# Factorio test access over Tailscale

The Factorio message board uses http://100.107.208.76:4175/?board=factorio. Its database WebSocket URI is **ws://100.107.208.76:3001**, which relays TCP to SpacetimeDB at 127.0.0.1:3000. Port 3000 on the Tailscale interface currently serves an unrelated Next.js application. HTTP200 from that address does not verify the database or a WebSocket subscription.

Start the relay on the database machine:

```sh
python3 scripts/tailnet-db-relay.py --bind 100.107.208.76 --port 3001
```

It accepts a specific Tailscale IPv4 address and a dedicated port, rejects wildcard/public binds and target-port reuse, and routes only to the fixed loopback database. It does not parse or modify HTTP/WebSocket traffic. Connections are bounded to 128 and inactive sockets time out after 120 seconds. SpacetimeDB identities and database permissions remain authoritative. Private gameplay participant names remain self-declared; this does not introduce a hardened membership ACL.

Configure the communication dashboard with:

```sh
DASHBOARD_HOST=100.107.208.76 \
SPACETIMEDB_HOST=ws://100.107.208.76:3001 \
DASHBOARD_PORT=4175 node dashboard/board-server.mjs --board factorio
```

The shared dashboard and launcher are currently being integrated by their owners; this command requires their files. Node 24 is required for the TypeScript imports used by this dashboard server. Local gameplay workers continue to use ws://127.0.0.1:3000.

## Current viewing services

The deployed services are owned by the Linux user manager. They survive the assistant ending or interrupting a turn; they are transient test services, not reboot provisioning.

```sh
systemctl --user is-active agent-swarm-db-relay agent-swarm-board agent-swarm-factorio-demo4
journalctl --user -u agent-swarm-factorio-demo4 -n 30 --no-pager
```

The current fixture is `/home/cig/.local/share/agent-swarm/live-demo-4`. Its ten-worker launcher runs for 60 minutes, until 2026-10-03 23:56UTC (7:56 PM Eastern), and then saves/stops its owned game. It uses ten rules workers, no paid model requests, a declared chest containing 50 ore/20 coal, and two shared furnaces. The game endpoint is **100.107.208.76:34198**. RCON remains on loopback 27016. Use a legally obtained graphical **Factorio 2.0.77 base-game** client with the exact `agent-swarm` mod; disable expansion mods. Download the matching ZIP from http://100.107.208.76:4180/agent-swarm_0.1.0.zip and put it in the client mods directory. Join through Multiplayer → Connect to address. The public artifact directory contains only the mod, checksum, safe report, board screenshot and HTML; the private world is never served.

For a graceful early stop, create the launcher's stop marker:

```sh
python3 -c 'from pathlib import Path; Path("/home/cig/.local/share/agent-swarm/live-demo-4/stop").write_text("Operator stop\n")'
```

The launcher stops workers and saves/stops its own game. Existing worlds are preserved; use a new directory for a fresh fixture. Runtime corruption/unknown action recovery and natural-map progression remain separate acceptance tasks. The public artifact server also runs as the user service `agent-swarm-viewer-artifacts`. The previous run3 production independently passed ten tasks, fifty actual plates and fifty matched receipts; run4 independently passed the same ten-worker/fifty-plate checks after restart. Its evidence is `/tmp/factorio-live4-independent-evidence/verification.json` and the public artifact copy. Graphical client joining must still be confirmed on the operator's client.

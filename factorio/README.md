# Factorio private runtime

Pinned Linux x86_64 headless Factorio **2.0.77**, Python 3.9+, curl, tar and sha256sum. The graphical viewer must be a legally obtained **2.0.77 base-game** client with the same `agent-swarm` mod; disable quality, elevated-rails and space-age. This runtime creates ten scripted character entities, not ten connected human/client accounts.

From the repository root:

```sh
bash factorio/install.sh
python3 factorio/check-runtime.py
python3 factorio/check-production.py
python3 factorio/runtime.py init --world "$HOME/.local/share/quant-swarm/factorio-test"
python3 factorio/runtime.py preflight --world "$HOME/.local/share/quant-swarm/factorio-test"
python3 factorio/runtime.py start --world "$HOME/.local/share/quant-swarm/factorio-test"
```

Keep the last command running. In another terminal:

```sh
python3 factorio/status.py --world "$HOME/.local/share/quant-swarm/factorio-test"
```

Expected: ten distinct actor unit IDs, advancing tick, persisted world/history IDs, seed 424242, a shared chest with 50 iron ore and 20 coal, and two stone furnaces. These are declared fixture grants. A normally started runtime has idle characters. `check-production.py` runs one rules-controlled character in a disposable world: it walks to the chest, takes five ore and one coal, loads a real furnace and collects five engine-produced plates. Expect a PASS in roughly 25 seconds. It also validates idempotent replay, changed-request rejection, pause enforcement and saved inventory/receipts after server restart. Ten independent workers and gameplay-board integration remain pending; this is one-actor acceptance, not completed swarm acceptance.

The server binds UDP 127.0.0.1:34197; RCON binds TCP 127.0.0.1:27015. A viewer on the same machine can copy `WORLD/mods/agent-swarm_0.1.0` to its mods directory and join `127.0.0.1:34197` through Multiplayer → Connect to address. Spawn and characters are around (0, 0). Graphical joining has not been verified on this headless machine. For a remote Tailscale viewer, use the explicitly configured private `gameBind` below; loopback remains the default. The development board remains separate at http://100.107.208.76:4174/.

Ctrl+C saves/stops the foreground server. Re-run `start` with the same world to resume. `init` refuses any existing directory; use a fresh path for reset and preserve the original save. The world contains manifest, bridge/mod list, private RCON password, save, creation logs and engine data/logs. Keep it outside the checkout. Backup only after stopping: copy the entire world directory. Do not delete/reset a world with workers attached.

`FACTORIO_BIN` overrides the binary path; the version is still checked. `FACTORIO_INSTALL_DIR` overrides installation location; then set `FACTORIO_BIN` to `INSTALL/factorio/bin/x64/factorio`. Installation records the downloaded archive SHA-256 as provenance, not an independently verified vendor signature. To change ports/scenario/seed, copy `config/factorio-pilot.json`, edit it, and pass `--config FILE` to `init`. A freeplay world has ten empty-inventory actors and no fixture chest/furnaces; no natural progression is implemented yet.

The disposable real-engine check verifies actors, exact declared grants, world/history/seed, advancing ticks, conflict/overwrite/hash refusal and graceful stop. It never touches the active SpacetimeDB databases, operator worlds or model APIs. Runtime manifests must be reconciled with game receipts before any future worker resumes after restore. RCON is a privileged private transport, and this status CLI deliberately accepts no arbitrary command text.

## Action bridge milestone

The TypeScript command contract is `src/factorio/protocol.ts`; the Python engine-check adapter is `factorio/bridge.py`. Protocol 1 carries actor, world/history and stable operation IDs plus a canonical-payload digest. Current commands are bounded `move`, `take` and `put`; transfers permit only iron ore, coal and iron plates, quantities 1–20 and targets within six tiles. Observation is radius-limited to at most 32 tiles and 100 nearby entries, with omitted count disclosed. The Lua bridge validates actor ownership, reach, inventory/capacity and command arguments and records receipts in the save. It serializes pending movement per actor and returns the original receipt for exact retries; changed content is refused. Pausing blocks new mutations while already-admitted movement finishes. Crafting, mining, construction, pathfinding around obstacles and natural-map progression are future packages.

The RCON transport and fixture world are trusted/private. Scope, ownership and shared-resource reservations must be reconciled through the gameplay board and durable operation journal before independent workers use this bridge; the standalone production smoke is deliberately a single-actor check. Unknown outcomes must be checked through the existing receipt, never assumed failed and replayed under a new ID.

## Remote Tailscale viewer

On this host, create a dedicated configuration with `gameBind: "100.107.208.76"`, `gamePort: 34198`, and `rconPort: 27016`, then initialize a fresh world using `--config FILE`. Start that world and connect the matching graphical 2.0.77 client over Tailscale to **100.107.208.76:34198**. Copy that world's `mods/agent-swarm_0.1.0` directory into the client's mods directory and enable it alongside base only. RCON remains bound to 127.0.0.1 regardless of gameBind. Configuration accepts specific loopback, private LAN or Tailscale IPv4 addresses and rejects wildcard/public addresses. The selected interface must exist on the server.

`FACTORIO_CHECK_GAME_BIND=100.107.208.76 python3 factorio/check-runtime.py` verifies the real engine can host on this tailnet interface using disposable ports while RCON is loopback. A graphical viewer join is still a separate acceptance check and is not implied by this engine test.

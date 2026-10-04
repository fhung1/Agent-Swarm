# Factorio runtime

Requirements: Linux x86_64, Python 3.9+, curl, tar and sha256sum. The pinned headless game is **Factorio 2.0.77**. Viewing requires a matching graphical base-game client and `agent-swarm` 0.1.0 mod; disable expansion mods. Ten actors are scripted characters, not connected graphical clients.

## Install, test and start

From the repository root:

```sh
bash factorio/install.sh
python3 factorio/check-runtime.py
python3 factorio/check-production.py
python3 factorio/check-rejections.py
python3 factorio/runtime.py init --world "$HOME/.local/share/agent-swarm/factorio-test"
python3 factorio/runtime.py preflight --world "$HOME/.local/share/agent-swarm/factorio-test"
python3 factorio/runtime.py start --world "$HOME/.local/share/agent-swarm/factorio-test"
```

Keep `start` running. Inspect from another terminal:

```sh
python3 factorio/status.py --world "$HOME/.local/share/agent-swarm/factorio-test"
```

The cooperative fixture declares seed 424242, five actors, fifty ore, twenty coal and two furnaces. Idle actors do not mean workers are running. `check-production.py` uses one actor in a disposable world, consumes ore/fuel and verifies five engine-produced plates, exact retry, rejected changed requests, pause and saved receipts after restart.

## Configuration and lifecycle

Default game address: UDP `127.0.0.1:34197`; RCON: TCP `127.0.0.1:27015`. Copy [the config](../config/factorio-pilot.json), change ports/seed/scenario and pass `--config FILE` to `init`. `FACTORIO_BIN` overrides the binary path but version checking remains. `FACTORIO_INSTALL_DIR` changes install location; point `FACTORIO_BIN` to its executable.

`init` refuses an existing directory. Ctrl+C saves/stops the foreground server; `start` resumes the same world. For reset, use a fresh path. Back up the complete world directory only after stopping. Preserve manifests, histories, receipts and private worker state. Never delete a world with workers attached.

A matching viewer joins through Multiplayer → Connect to address. Copy `WORLD/mods/agent-swarm_0.1.1` to the client mods directory; actors are near `(0, 0)`. For remote viewing use an explicit private `gameBind`, such as the Tailscale address, and available game/RCON ports. RCON stays loopback. Graphical joining is a separate acceptance check.

## Bridge limits

[The protocol](../src/factorio/protocol.ts) permits bounded `move`, `take` and `put`. Transfers use iron ore, coal or plates, quantities 1–20 and reach six tiles. Nearby observation is capped at radius 32 and 100 entries. The bridge serializes actor actions and stores scope/ID/payload receipts in the save. A valid scoped operation rejected before mutation has a durable `failed` receipt. Exact retries return that same failure; use a new operation ID for a new decision. Unknown outcomes still require reconciliation. `check-rejections.py` verifies rejection recovery, replay/restart and unchanged resources in a disposable world. Pause rejects new mutations; admitted movement may finish.

Mining, crafting, construction, obstacle-aware navigation and natural progression remain separate capabilities. The `freeplay` fixture supplies empty-inventory actors without starter chest/furnaces; it does not implement a production strategy.

Next: [ten-worker inference launch](../docs/factorio-inference.md), [acceptance](../docs/factorio-inference-acceptance.md), [remote dashboard access](../docs/factorio-tailnet-access.md).

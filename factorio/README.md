# Factorio private runtime

Pinned Linux x86_64 headless Factorio **2.0.77**, Python 3.9+, curl, tar and sha256sum. The graphical viewer must be a legally obtained **2.0.77 base-game** client with the same `agent-swarm` mod; disable quality, elevated-rails and space-age. This runtime creates ten scripted character entities, not ten connected human/client accounts.

From the repository root:

```sh
bash factorio/install.sh
python3 factorio/check-runtime.py
python3 factorio/runtime.py init --world "$HOME/.local/share/quant-swarm/factorio-test"
python3 factorio/runtime.py preflight --world "$HOME/.local/share/quant-swarm/factorio-test"
python3 factorio/runtime.py start --world "$HOME/.local/share/quant-swarm/factorio-test"
```

Keep the last command running. In another terminal:

```sh
python3 factorio/status.py --world "$HOME/.local/share/quant-swarm/factorio-test"
```

Expected: ten distinct actor unit IDs, advancing tick, persisted world/history IDs, seed 424242, a shared chest with 50 iron ore and 20 coal, and two stone furnaces. These are declared fixture grants. Characters are idle at this milestone: model/rules workers, production actions and gameplay-board integration follow in the next work packages. This is a runtime test, not completed swarm acceptance.

The server binds UDP 127.0.0.1:34197; RCON binds TCP 127.0.0.1:27015. A viewer on the same machine can copy `WORLD/mods/agent-swarm_0.1.0` to its mods directory and join `127.0.0.1:34197` through Multiplayer → Connect to address. Spawn and characters are around (0, 0). Graphical joining has not been verified on this headless machine. The loopback game address cannot be reached directly from a remote Tailscale laptop; remote UDP routing/binding belongs to the final demo configuration. The development board remains separate at http://100.107.208.76:4174/.

Ctrl+C saves/stops the foreground server. Re-run `start` with the same world to resume. `init` refuses any existing directory; use a fresh path for reset and preserve the original save. The world contains manifest, bridge/mod list, private RCON password, save, creation logs and engine data/logs. Keep it outside the checkout. Backup only after stopping: copy the entire world directory. Do not delete/reset a world with workers attached.

`FACTORIO_BIN` overrides the binary path; the version is still checked. `FACTORIO_INSTALL_DIR` overrides installation location; then set `FACTORIO_BIN` to `INSTALL/factorio/bin/x64/factorio`. Installation records the downloaded archive SHA-256 as provenance, not an independently verified vendor signature. To change ports/scenario/seed, copy `config/factorio-pilot.json`, edit it, and pass `--config FILE` to `init`. A freeplay world has ten empty-inventory actors and no fixture chest/furnaces; no natural progression is implemented yet.

The disposable real-engine check verifies actors, exact declared grants, world/history/seed, advancing ticks, conflict/overwrite/hash refusal and graceful stop. It never touches the active SpacetimeDB databases, operator worlds or model APIs. Runtime manifests must be reconciled with game receipts before any future worker resumes after restore. RCON is a privileged private transport, and this status CLI deliberately accepts no arbitrary command text.

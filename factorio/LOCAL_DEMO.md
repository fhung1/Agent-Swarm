# Local ten-agent Factorio demo

Tested on Arch Linux x86_64 with Steam Factorio 2.0.77, SpacetimeDB 2.10.2 and Node 26.10.0. The running disposable world is `.game-runs/live-20261003`; personal saves in `~/.factorio/saves` were not used. The world has ten scripted characters, a chest initially containing 50 iron ore and 20 coal, and two furnaces. Mining is not implemented. Transfers use the mod API and happen instantly; furnace smelting advances in game time. The next newly initialized world will show floating item text for each transfer; the current running world uses the earlier bridge hash.

## Watch now

- Open the installed Factorio client and use Multiplayer → Connect to address → `127.0.0.1:34197`. The client needs base 2.0.77 and `agent-swarm` 0.1.0. This run was joined successfully using the same installed binary with `--mod-directory .game-runs/live-20261003/mods` and isolated client data.
- The ten scripted actors, chest and furnaces are near spawn `(0, 0)`. The actors move locally during the viewing phase after production. They are not ten licensed graphical clients.
- Factorio board: http://127.0.0.1:4184/?board=factorio . Development board on the same local dashboard: http://127.0.0.1:4184/?board=development . Both pages include a navigation list and live availability. These use the local SpacetimeDB on `127.0.0.1:3001`. The unrelated SSH tunnel on port 3000 and its database were not used.
- Pause/resume buttons on the Factorio dashboard block/allow new bridge mutations. A movement already admitted before pause can finish.

## Evidence

Run `python3 factorio/verify-demo.py --world "$PWD/.game-runs/live-20261003" --output .game-runs/live-20261003/verification.json`. A pass requires ten different actor inventories with five plates, ten completed board tasks, 50 completed game transfer receipts, 50 matching board action results, and a chest with zero ore and ten coal. Inspect `.game-runs/live-20261003/verification.json`, each worker's `operations.jsonl` and `board.token`, `.game-runs/logs/worker-*.log`, and `.game-runs/client-joined.png`. The game's own log is `.game-runs/live-20261003/data/factorio-current.log`; the isolated client log is `.game-runs/client-data/factorio-current.log`.

The production workers use `rules`, with no LLM calls. Each process has a separate SpacetimeDB token, actor ID and journal. Each task reserves the shared chest and then one of two furnaces on the same gameplay board. Board messages label `action_result` and postproduction `viewing` separately. The bridge limits observation to 32 tiles, transfer reach to six tiles and each move to 32 tiles.

## Restart and stop

The current processes are in the local session. To stop just the demo workers, use `ps -eo pid,args | grep 'node dist/demo-worker.mjs'` and send `kill` to those ten PIDs. Stop the private Factorio process with SIGINT so it saves: `kill -INT $(pgrep -f 'factorio.*--start-server.*/.game-runs/live-20261003/world.zip' | head -1)`. Stop the local dashboard and SpacetimeDB by identifying the processes bound to ports 4184 and 3001 with `ss -ltnp`, then send SIGINT. Do not stop the process on port 3000; it is unrelated.

To restart the existing world, set `FACTORIO_BIN=/home/bobywoby/.local/share/Steam/steamapps/common/Factorio/bin/x64/factorio`, then run `python3 factorio/runtime.py start --world "$PWD/.game-runs/live-20261003"`. In another terminal run `DASHBOARD_PORT=4184 FACTORIO_WORLD="$PWD/.game-runs/live-20261003" node dashboard/live-board.mjs`. Start the local database first if stopped: `~/.local/bin/spacetime start --listen-addr 127.0.0.1:3001 --data-dir .game-runs/local-demo-db --non-interactive`. Rebuild the worker with `npx esbuild src/factorio/demo-worker.ts --bundle --platform=node --format=esm --outfile=dist/demo-worker.mjs`, then start each of the ten workers with `BOARD_URI=ws://127.0.0.1:3001 node dist/demo-worker.mjs "$PWD/.game-runs/live-20261003" INDEX ACTOR demo-20261003`, where INDEX is 1–10 and ACTOR is INDEX+11. Completed production tasks resume directly into viewing. Keep these commands in running terminals.

For a fresh fixture, choose a new directory and run `factorio/runtime.py init --world NEW_DIR`, then publish the gameplay board separately and seed ten new tasks. Do not delete or reuse an existing save. The current source mod adds floating transfer text; make a fresh world to load that change. The current worker/task IDs are fixed to the verified run, so a second simultaneous run needs new task IDs in the worker.

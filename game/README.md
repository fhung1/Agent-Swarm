# Factorio connection checks

This guide supports only the deferred graphical-client vision track in [the game plan](../GAME_AGENT_IMPLEMENTATION_PLAN.md#deferred-real-client-vision-track). It is not a prerequisite or operator guide for the current Factorio pilot. Current work uses the headless scripted-character contract in [the Factorio pilot contract](../docs/factorio-pilot-contract.md) and [implementation tasks](../FACTORIO_IMPLEMENTATION_TASKS.md), with a separately joined licensed human spectator for visible acceptance. Development assignments and evidence live in `quant-swarm-coord`.

Run the operator preflight **inside the intended game desktop**, where the graphical Factorio client is installed:

```sh
FACTORIO_SERVER=your-server:34197 python3 game/preflight.py --binary /path/to/factorio --output /tmp/factorio-preflight.json
```

The command runs the supplied executable with `--version` and checks whether a server address and graphical display are configured. It exits 1 for missing prerequisites. Exit 0 does not prove server reachability, display access, multiplayer compatibility, or a successful join. This is a local check, not a remote VM probe. It does not install or launch a game.

Run the graphical join only after the deferred vision track is explicitly resumed and board task `factorio-client-join` is reopened. Then open the client, join the configured server, and attach the evidence requested by that task. The repository contains only example VM configuration.

The deferred follow-up is `factorio-desktop-adapter`: provide isolated screenshots and bounded keyboard/mouse actions. Its vision-worker restriction does not apply to the current headless pilot, whose bounded server-side observation/action contract is defined separately. Completing this preflight does not prove either track's runtime acceptance.

Run check tests with `python3 -m unittest game.test_preflight`.

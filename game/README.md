# Factorio connection checks

Run the operator preflight **inside the intended game desktop**, where the graphical Factorio client is installed:

```sh
FACTORIO_SERVER=your-server:34197 python3 game/preflight.py --binary /path/to/factorio --output /tmp/factorio-preflight.json
```

The command runs the supplied executable with `--version` and checks whether a server address and graphical display are configured. It exits 1 for missing prerequisites. Exit 0 does not prove server reachability, display access, multiplayer compatibility, or a successful join. This is a local check, not a remote VM probe. It does not install or launch a game.

After prerequisites pass, open the graphical client, join the configured server, and capture a screenshot showing the joined player in the world. Record that evidence on task `factorio-client-join` in board run `demo`. Supply the actual host/desktop details before attempting the join; the repository contains only an example VM configuration.

The next task is `factorio-desktop-adapter`: provide isolated screenshots and bounded keyboard/mouse actions. Workers must not receive RCON, server state, or world files. Connection remains unverified until the graphical join check succeeds.

Run check tests with `python3 -m unittest game.test_preflight`.

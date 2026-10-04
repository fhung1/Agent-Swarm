# Factorio graphical preflight

This optional legacy checker inspects graphical-client prerequisites; it does not prove a player joined or a swarm ran.

```sh
python3 -m unittest game.test_preflight
```

The current pilot uses a headless server with scripted characters and a separate graphical viewer. Follow [runtime setup](../factorio/README.md) and record an actual matching-client join for live acceptance.

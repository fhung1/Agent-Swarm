# Factorio runtime setup and preflight

This tooling is the first startup gate for the ten-worker demo. It does not claim that autonomous gameplay or a graphical-client join is verified. Use it with the integrated Factorio implementation checkout, which contains `config/factorio-pilot.json`, `factorio/mod/` and `src/factorio/`.

## Install the pinned headless server

The tested host is Linux x86_64 with Node 26.10.0, Bash, curl, xz/tar and sha256sum. Node tooling requires at least Node 22; use the tested version when reproducing results. The graphical Factorio client is a separate installation and must match base-game server version 2.0.77 and the bridge mod.

From the repository root:

```sh
bash factorio-demo/install.sh
```

The installer uses the [official versioned download endpoint](https://wiki.factorio.com/Download_API), downloads headless **2.0.77**, verifies the executable's reported version and installs under `~/.local/share/agent-swarm/factorio/2.0.77`. It preserves existing installations. The recorded archive digest is provenance, not an independently authenticated vendor checksum. Set `FACTORIO_INSTALL_DIR` to choose a fresh location; if customized, also set `FACTORIO_BIN` to its `factorio/bin/x64/factorio` executable.

## Check before starting the demo

Start SpacetimeDB as instructed by the shared board setup, then run:

```sh
node factorio-demo/preflight.mjs
```

Expected result: JSON with `"ok": true`. A nonzero exit and named failed check tells you what to fix. This checks configuration, ten-worker/base-game contract, database separation, binary version, bridge mod, free UDP game/TCP RCON ports and reachable board host. The port probes close immediately; they do not reserve ports for launch. Board TCP reachability alone does not prove a published database or successful authenticated subscriptions.

For a different checkout or already installed engine:

```sh
node factorio-demo/preflight.mjs --root /path/to/implementation-checkout --binary /path/to/factorio/bin/x64/factorio
```

Use `--skip-board` only to inspect game prerequisites before starting SpacetimeDB. A running game server will intentionally fail the available-port checks; stop it before a new launch, or use the existing world's normal attach workflow. Never reset an existing save to resolve a port conflict.

## Test production startup

After installing project dependencies in the implementation checkout:

```sh
node --test factorio-demo/preflight.test.mjs
node factorio-demo/check-runtime.mjs /path/to/implementation-checkout
```

The runtime check bundles and executes the actual `startWorld` implementation. It creates a disposable world and available local ports, starts/saves/restarts the server, verifies stable world identity, and rejects wrong runtime versions and changed save seeds. Successful checks clean up their files. On failure, the printed temporary artifact directory retains `world/server.log` for diagnosis; no existing world or board is modified. The core runtime must clean up its child server on failure.

## Current live-demo boundary

The complete user handoff must also include ten-worker launch, dashboard URL, graphical client join/spectate steps, expected production and pause/recovery checks. Those are release gates in `FACTORIO_IMPLEMENTATION_TASKS.md` and board task `factorio-live-demo-guide`. This preflight is not a substitute for them. The existing `factorio-acceptance/viewer.mjs` helper prepares a separate matching graphical-client mod directory; it does not install a purchased client or start workers.

## Verified startup fix awaiting core integration

The production RCON implementation originally sent a type-0 delimiter that Factorio rejected, making startup time out. `patches/rcon-delimiter.patch` changes the delimiter to a second type-2 command; the response with ID 3 terminates collection of the first command's response. The patch was verified against the real pinned engine in a disposable source copy: startup, save, restart/world identity, version mismatch and seed mismatch checks all passed.

The core implementation owner should apply the patch to `src/factorio/rcon.ts` (unless already fixed) and rerun `check-runtime.mjs`. This patch file does not modify the active implementation on its own. Do not treat a preflight pass as proof that the unfixed production runtime starts.

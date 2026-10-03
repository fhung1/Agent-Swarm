# One-client Factorio and Minecraft prototype on macOS

This local vision agent controls one foreground Factorio or Minecraft Java Edition client. It sends a resized screenshot to Claude, validates a short action plan, applies mouse/keyboard input, captures the result, and writes a local trace. It runs one client in one macOS graphical session. The model's `done` response is recorded as its claim; an operator must verify the game outcome on screen.

## Requirements

- A Mac with Node.js, npm, Swift command-line tools, and Factorio or Minecraft Java Edition installed. The helper was built on macOS 15.5 with Swift 6.1.2.
- The game client already open in a logged-in graphical session. For Minecraft, launch the game itself, beyond the launcher. Keep its window in the foreground while the agent runs. A borderless or full-screen window avoids clicking macOS window chrome.
- Screen Recording (called **Screen & System Audio Recording** on some macOS versions) and Accessibility permission for the terminal app running the commands. macOS may prompt on first capture or input attempt; grant permission in System Settings → Privacy & Security, then restart the terminal if needed.
- `ANTHROPIC_API_KEY` available in the shell or a local secret manager. This prototype uses the repo's existing Anthropic SDK and defaults to `claude-opus-5-5`; set `GAME_MODEL` to choose another image-capable model.

## Build and run

From the repository root:

```sh
npm install
npm run game:build
```

With the game visible and foreground, inspect the selected window without sending input:

```sh
./dist/game/macos-desktop window factorio
# Or, with Minecraft Java Edition open:
./dist/game/macos-desktop window minecraft
```

For an initial Factorio run, start from a safe game state and give the agent one visible UI goal:

```sh
GAME_GOAL='Open the inventory, then close it' GAME_MAX_STEPS=3 npm run game:run
```

Before starting a paid game run, set a version label, the verified USD-per-million-token rates for the exact model, and a per-run USD cap. The worker has no built-in provider prices. For cache-read and cache-write rates, use the provider's current rate card; do not copy rates from an old run.

For Minecraft Java Edition, start in a safe world and choose a short visual goal:

```sh
GAME_PRICING_VERSION=verified-card-2026-10 \
GAME_INPUT_USD_PER_MILLION="$VERIFIED_INPUT_RATE" \
GAME_CACHE_READ_USD_PER_MILLION="$VERIFIED_CACHE_READ_RATE" \
GAME_CACHE_WRITE_USD_PER_MILLION="$VERIFIED_CACHE_WRITE_RATE" \
GAME_OUTPUT_USD_PER_MILLION="$VERIFIED_OUTPUT_RATE" \
GAME_MAX_SPEND_USD="$GAME_RUN_CEILING" \
GAME=minecraft GAME_GOAL='Turn toward the visible tree and walk toward it' GAME_MAX_STEPS=5 npm run game:run
```

The rate and ceiling variables above must be set to decimal USD values with at most six fractional places. `GAME_PRICING_VERSION` is recorded with each run and must change when the verified rates change.

`GAME` defaults to `factorio`. Minecraft uses relative `look` actions for camera motion, simultaneous `keys` actions for movement with jump, crouch, or sprint, and `mouse_button` at the current crosshair for mining, attacking, or placing. The coordinate based mouse actions serve visible menus and inventory. The agent cannot type into chat or issue game commands. Minecraft camera response and cursor capture still need a live client check; start with small goals and watch the screen.

Watch the game while it runs. Press Ctrl+C to stop. The helper completes its current bounded action and releases its key or mouse button before the process ends. The terminal and helper must remain in the same logged-in macOS desktop session as the game.

| Setting | Default | Purpose |
| --- | --- | --- |
| `GAME` | `factorio` | `factorio` or `minecraft`; selects the game window and controls. |
| `GAME_GOAL` | required | One short, visually checkable goal, up to 500 characters. |
| `GAME_MODEL` | `AGENT_MODEL` or `claude-opus-5-5` | Anthropic model used for screenshots. |
| `GAME_MAX_STEPS` | `10` | Maximum screenshot/model cycles, from 1 to 100. |
| `GAME_MAX_TOKENS` | `30000` | Combined input/output token budget; preflight input count plus the maximum output must fit before a request. |
| `GAME_PRICING_VERSION` | required | Version label for the verified model rates. |
| `GAME_INPUT_USD_PER_MILLION` | required | Regular input price in USD per million tokens. |
| `GAME_CACHE_READ_USD_PER_MILLION` | required | Cached input read price in USD per million tokens. |
| `GAME_CACHE_WRITE_USD_PER_MILLION` | required | Cached input write price in USD per million tokens. |
| `GAME_OUTPUT_USD_PER_MILLION` | required | Output price in USD per million tokens. |
| `GAME_MAX_SPEND_USD` | required | Per-process run ceiling; an overrun or uncertain request stops the run. |

The agent creates `.game-runs/<run-id>/run.json`, `trace.jsonl`, full-resolution PNG captures, and resized JPEGs sent to the model. The directory is ignored by Git. Keep it private if the game UI shows personal information.

## Control boundary and current limits

- Input is allowed only while the selected game window is foreground. The helper checks the same window ID and size before every action. Moving focus or resizing the window stops input. Minecraft selection requires a Java/Minecraft client window whose title contains “Minecraft”; it excludes the launcher.
- The model receives the screenshot, goal, and its recent action history. It does not receive game memory, files, server telemetry, or shell access. Its response is parsed against an allowlist: up to four actions, each hold at most 600 ms, and at most 2 seconds of holds per sequence. Coordinates are normalized to 0–1000 within the captured window.
- The helper holds keys/buttons only inside one action, releases them on normal completion or Ctrl+C, and has no persistent held-key state. An independent child watcher records held inputs and releases them when the helper closes its pipe or is killed. EOF release is checked in dry-run mode; actual macOS input release still needs the live gameplay check.
- The single-client run records a versioned local rate card and persists a pessimistic spend reservation before each paid request. If a request is uncertain, it keeps that reservation; if observed usage exceeds it, the run stops. This legacy GUI worker has only a per-process ceiling and does not provide the shared global reservation needed for a multi-agent Mineflayer or Factorio swarm. It also does not publish game events to SpacetimeDB, control a second client, or manage a multiplayer server. The existing [libvirt VM fleet](../../vm_fleet/README.md) is separate and requires a Linux host.
- The code builds and its action validation has local tests. A live gameplay result still requires an installed client, macOS permissions, and a model API key. Minecraft camera and held-button behavior have not yet been verified in a live client.

The intended one-agent exit check and later multiplayer phases are in [the game-agent plan](../../GAME_AGENT_IMPLEMENTATION_PLAN.md).

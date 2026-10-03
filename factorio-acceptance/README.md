# Factorio swarm acceptance

Development task: `factorio-acceptance-review`. Implementations and test results are coordinated on **Development**; only game agents and their game objectives belong on **Factorio**. Both use the same message-board backend implementation.

## Required evidence

| Capability | Check | Evidence |
| --- | --- | --- |
| Setup | Follow documented setup from a clean checkout with a supported headless runtime. | Exact version, command and exit status. |
| Shared backend | Connect development and gameplay to different instances of the same module/client. | A gameplay message is visible only in its instance. |
| Ten agents | Start ten workers against one world. | Ten persisted distinct identities and ten controllable in-game actors. Registration alone is insufficient. |
| Graphical observation | Join the running headless server with a matching graphical Factorio client and required mod. | All ten agents are visible, individually identifiable characters in the same world; document server address, version/mod matching and how to find/follow the agents. |
| Cooperation | Give the agents a shared objective and competing subtasks. | Actual claims, progress messages, world-changing actions and results from multiple workers. |
| Action validation | Submit malformed/out-of-range actions and conflicting operations. | Refusals without inventory duplication, unauthorized entity changes or engine failure. |
| Restart | Stop and restart a worker during unfinished work. | Same saved identity, reconciled claim/action outcome and no duplicate completed action. |
| Connection loss | Drop the board or game connection during an action. | Worker waits/reconciles rather than executing an uncertain action twice. |
| Pause | Pause while workers are active. | New game actions stop; state inspection remains available; resume is deliberate. |
| Budgets | Reach a configured iteration/model budget. | Bounded shutdown or idle state; counters survive worker restart where documented. |
| Live dashboard | Observe gameplay while workers post. | History and new updates from multiple gameplay workers; no development tasks. |
| Completion | Run a cooperative milestone and a bounded attempt toward the configured victory condition. | Distinguish a smoke-test milestone, an agent's claim, and engine-confirmed victory. |

Use disposable databases and worlds for destructive tests. Do not republish or reset the user's board to run acceptance. Keep tokens, model credentials and RCON passwords out of board posts and committed reports.

Headless Factorio can be obtained from [the official download page](https://www.factorio.com/download). The initially available runtime in this workspace is 2.0.77. Test against its versioned API rather than assuming the latest experimental API matches it.

## Join graphically

Once the game server and bridge mod exist, use your **graphical** Factorio executable and the exact bridge mod folder that the server loaded:

```sh
node factorio-acceptance/viewer.mjs \
  --binary /path/to/graphical/factorio \
  --mod /path/to/server/bridge-mod \
  --address 127.0.0.1:34197 \
  --version 2.0.77 \
  --launch
```

Omit `--launch` to prepare/check the local client without opening it. The helper uses `.game-runs/factorio-viewer/mods` and leaves normal game mods and saves alone. For a changed bridge build, choose a fresh `--state-dir`. On another computer, copy the same bridge mod and use the game server's reachable address instead of `127.0.0.1`. The graphical client must match the server's Factorio version and enabled mods. This helper targets the base-game pilot plus its bridge mod, without Space Age or other gameplay mods.

The game connection uses UDP (default 34197). Do not connect the graphical client to the RCON port, board WebSocket port or dashboard port. In the game UI, **Multiplayer → Connect to address** is the equivalent connection flow once the matching mod is installed. See the official [multiplayer guide](https://wiki.factorio.com/Multiplayer) and [command-line reference](https://wiki.factorio.com/Command_line_parameters).

The helper cannot install a purchased graphical game client, prove a successful join without that client, or make agents run by itself. The gameplay server/workers must already be running. To check the helper's refusal and file-isolation behavior:

```sh
node --test factorio-acceptance/viewer.test.mjs
```

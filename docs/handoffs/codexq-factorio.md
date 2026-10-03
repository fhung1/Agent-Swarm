# Codexq Factorio runtime handoff

- Task: factorio-runtime-prep; push when finished.
- Status: runtime implementation and real-engine smoke complete; publishing immediately before next package.
- Worktree: /tmp/quant-factorio-runtime, based on fetched upstream main; shared dirty workspace preserved.
- Implemented: official pinned installer, isolated world CLI, declared starter/freeplay scenarios, ten scripted actors, base-only mod list/hash, world/history IDs, private RCON status and disposable engine check. Guide: factorio/README.md.
- Checks: `python3 factorio/check-runtime.py` PASS against actual 2.0.77: ten unique actors, 50 ore/20 coal/two furnaces, seed/IDs, advancing ticks, overwrite/port/hash refusals and clean stop. Installer succeeded. No model/board calls or graphical viewer claim.
- Remaining: bounded action bridge, durable worker/journal and gameplay-board integration, ten-agent production and remote graphical viewer acceptance. Parent F0 task remains dependent on generic-message-board integration.
- Coordination: HANDOFF.md locked by cancellation session; this distinct handoff is the interim entry for later incorporation. merge-fix offered standalone journal work; sent compatible suggested receipt metadata on the board.

## Bounded bridge and production milestone

- Task: factorio-bridge-prep; push when finished.
- Status: implementation/checks complete; publishing immediately.
- Work: validated TypeScript and Python operation encoding; Lua local observation, bounded walking/transfers, persistent exact-request receipts, actor serialization and pause admission. Real single-actor furnace test consumes fixture ore/fuel and collects five plates.
- Checks: three TypeScript contract tests and strict file typecheck PASS; runtime engine smoke PASS; production/replay/pause/save/restart engine check PASS. No provider, gameplay-board or graphical-client acceptance claimed.
- Next: integrate generic board and the pushed operation journal, implement durable independent rules workers and ten-agent reservation coordination. Full command vocabulary remains incomplete (mining, crafting, construction/pathfinding).

## Tailscale game binding

- Task: factorio-tailnet-bind; push when finished.
- Implemented: gameBind config selects a specific private/tailnet IPv4 UDP endpoint; loopback default and RCON always loopback. Wildcard/public/unavailable binding refuses before server launch.
- Check: actual 2.0.77 engine smoke with FACTORIO_CHECK_GAME_BIND=100.107.208.76; actors/resources/IDs, progress and clean stop verified; wildcard config refusal checked. Graphical client join pending.
- Deployment: merge-fix owns fresh live demo on UDP 34198/RCON27016 and ten-process launcher. No competing world remains running from this session.

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

## Independent live ten-worker acceptance

- Task: factorio-live-blackbox; push when finished.
- Status: actual final run3 independently verified; publishing read-only checker and documentation.
- Check: ten live worker processes, ten distinct recorded identities and owners, ten avatars with five plates each, fifty matched engine/board transfer receipts, expected source depletion, scope, contention and development separation all PASS. Checked directly against engine and database, not only launcher report.
- Added: factorio/verify-live.py; docs/factorio-live-verification.md. Viewer mod/checksum/report served from dedicated public artifact directory /tmp/factorio-viewer-public on Tailscale4180. Verified HTTP download, archive files and SHA-256; no private state served.
- Remaining release work: shared client/launcher owner must push final integration; graphical join must be confirmed by operator/client. Current ten-worker world and board are live, owned by merge-fix; this session does not modify their controls.

## Dashboard routing and interruption-resistant live session

- Tasks: factorio-tailnet-board and factorio-live-restart; push when finished.
- Findings: tailnet100.107.208.76:3000 served an unrelated Next.js application, so browser/SDK WebSocket subscriptions hung despite HTTP200. Live viewing game had also ended abruptly; its pending view tasks reported connection-refused blockers. Production evidence from run3 remains valid.
- Work in progress: dedicated validated tailnet TCP relay3001 to actual loopback SpacetimeDB3000; restarted4175 dashboard with correct remote URI. Real SDK and Chromium now receive live snapshots.
- Durability: user-manager services agent-swarm-db-relay, agent-swarm-board, and agent-swarm-factorio-demo4 preserve processes across assistant turn interruptions. Fresh run4 world preserves previous worlds, ten workers, fixed fixture grants and bounded60minute deadline23:56UTC/19:56Eastern.
- Checks: fresh run4 independent engine/board verification PASS (ten workers/identities/tasks, fifty plates and fifty matched receipts). Real Chromium shows LIVE data and current ten workers; SDK relay restart recovered same identity and fresh snapshot. Relay address/port refusal checks PASS.
- Publication: access fix prepared; waiting for codex-queue MERGE COMPLETE before direct-main push to avoid disrupting the explicitly coordinated merge.
- Next: push access/restart documentation after merge, preserve active user services and verify launcher/framework publication with owners.

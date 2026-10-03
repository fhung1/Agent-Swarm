# Factorio acceptance handoff

## 2026-10-03 — codex-board-worker

- Status: in progress; development task `factorio-acceptance-review` claimed.
- Core implementation is owned by `codex-factorio` in `../Agent-Swarm-factorio`; this checkout owns only `factorio-acceptance/`.
- Confirmed Factorio headless 2.0.77 at `/tmp/factorio-runtime/factorio/bin/x64/factorio`.
- Shared backend is available in the framework branch. Development and gameplay have distinct database instances. The shared board has atomic claims and expiring reservations, but does not have expiring task claims; reported this to the implementation owner.
- Next: agree the adapter contract, independently exercise real-engine behavior and failures, and report/fix gaps without overlapping the implementation owner's locks.

- User added graphical observation: ten visible identifiable characters, normal graphical client joins the same headless world. Sent requirement to core implementation owner and added acceptance criterion.

- Added graphical viewer helper, isolated mod preparation and exact version checks; three unit tests pass. Full GUI observation is pending a graphical client. Core game bridge is still being implemented by codex-factorio.

- Real-engine fixture passed on Factorio 2.0.77: ten distinct character entities; exactly-once mining effect; conflicting ID/foreign receipt refusal; pause/resume; save/restart preserves actor IDs, inventory and receipts. Report: `/tmp/factorio-engine-acceptance.json`. The fixture does not call models or shared boards.
- Fixed viewer mod list to explicitly disable bundled expansion mods after real Factorio testing showed omitted DLC defaults to enabled. Both viewer (3) and Python RCON framing (3) tests pass.
- Still pending: core worker/board integration, visible character labels/colors/walking, graphical-client join, autonomous full-game progress. Reported these separately on Development; no victory claim.

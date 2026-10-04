# Factorio operator dashboard handoff

## Started

Claimed `factorio-operator-run-dashboard`. The existing Factorio board showed shared tasks/messages and a separate legacy local page had pause/resume, but the supported `dashboard/board-server.mjs` + `dashboard/board-app.ts` had no live Factorio status or game controls. Working in `/tmp/codex-scout-factorio-operator-dashboard` from `origin/main` at `638c422`.

## Scope and findings

- The game exposes authoritative `status` and a fixed `control(paused)` method over loopback RCON through `factorio/status.py`.
- Inference launch plans are saved under `WORLD/inference/RUN/plan.json` and include actor/worker/task mappings. Board sessions/tasks provide last-seen and task status.
- The supported Factorio board server can be reached through a private tailnet. Pause/resume therefore needs an operator secret; control remains disabled until `FACTORIO_CONTROL_TOKEN` is configured.

## Work in progress

- Added fixed `--pause` and `--resume` commands to `factorio/status.py`.
- Added live game status and authenticated pause/resume APIs to `dashboard/board-server.mjs`. The status endpoint returns only run metadata matching the connected world's world/history IDs.
- Added a Factorio control room with game tick, paused state, world identity, actors and inventories, shared chests, rocket count, saved run limits, worker task status, and participant last-seen times. Engine status remains visible during message-board reconnects.
- Documented local/tailnet setup and the tab-only operator token. Controls remain disabled unless the server has a 32+ character `FACTORIO_CONTROL_TOKEN`; the browser does not persist it.

## Checks and next steps

- `npm run typecheck` — passed.
- `npx --yes node@24 scripts/check-factorio.ts` — passed, 8 files.
- `python3 -m py_compile factorio/status.py`, `python3 factorio/status.py --help`, Node syntax check, and `git diff --check` — passed.
- Esbuild browser bundle — passed.
- HTTP smoke with a disposable fake bridge — passed for projected game/run data, absent/wrong-token rejection, strict payload and content-type validation, and authenticated pause/resume routing.
- Browser/visual acceptance is unavailable in this environment because Chrome/Chromium is not installed; the repository's browser harness uses Chrome DevTools Protocol.

Implementation commit `813a912` is pushed to `main`. Next: close `factorio-operator-run-dashboard` with its check summary and release all task locks.

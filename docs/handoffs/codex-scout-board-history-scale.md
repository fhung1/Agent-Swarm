# Board history scaling handoff

## Started

Claimed `board-history-scale` after confirming its board details: the board dashboard replicated full task/message/lock/priority history and sorted all messages while rendering only 100. Working in `/tmp/codex-scout-board-history-scale`, started at `307ed73` and rebased onto `origin/main` through `2d41f0e`.

## Plan

- Keep workers on their existing full-history client behavior.
- Let browser clients subscribe to a rolling 30-day window, with unresolved tasks and active locks retained.
- Reapply the window on a timer so a long-running dashboard does not accumulate rows from its initial cutoff.
- Cap rendered lists at 100 and replace full-history sorting with top-row selection.
- Run message-board and dashboard checks, then commit and push.

## Current status

The browser client now supports optional rolling history subscriptions. Its default remains full-history for workers. The development and multi-board dashboards request a 30-day window; open, claimed, and blocked tasks stay visible, task priority rows follow the same task scope, and expired locks are excluded. Subscription windows refresh hourly without reconnecting the socket. Board lists render at most 100 items using top-row selection rather than sorting the entire message history. Added a disposable-database check for window expiry and active-task/priority/lock retention.

## Checks and constraints

- `npm run typecheck` passes.
- `npm run check:message-board` passes, including the new rolling-window integration check across disposable SpacetimeDB module instances. It verifies old completed tasks and messages fall out, a recent priority change brings its task back into view, and active tasks and locks remain visible.
- Esbuild bundles for `dashboard/dev-app.ts` and `dashboard/live-board.ts` pass.
- `git diff --check` passes.
- `npm run check:dashboard` could not start because this environment has no Chrome/Chromium executable (`Install Chrome/Chromium or set CHROME_PATH`). Both board dashboard bundles compile; browser acceptance remains unverified here.

## Result

Commit `eec32905bfeb662c82f427a899c55a9312735056` was pushed to `main` as `eec3290`.

Checks: `npm run typecheck`, `npm run check:message-board`, both board-dashboard esbuild bundles, and `git diff --check` passed. `npm run check:dashboard` could not launch because Chrome/Chromium is unavailable in this environment.

Next: finish the board task with the pushed hash and checks, release remaining locks, and continue with an unclaimed board task while the watcher stays active.

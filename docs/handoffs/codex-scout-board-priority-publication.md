# Board priority publication handoff

## Started

Claimed `board-priority-atomic-publication` to publish the checked `setTaskPriority` timestamp fix from commit `0bbf023` in `/tmp/agent-swarm-supervision-work`. Working from current `origin/main` at `2791d1d` in `/tmp/codex-scout-board-priority-publication`.

## Plan

- Cherry-pick only the board-priority fix onto current main, preserving unrelated pending commits in the source checkout.
- Run module typecheck and message-board integration checks.
- Push the result and record it on both publication and source tasks.

## Current status

Source commit inspected; it changes `coord/src/index.ts` so priority updates also advance the parent task timestamp. Cherry-picked onto current `main` as `56e4126`.

## Checks

- `npm run typecheck` passes.
- `npm run check:message-board` passes, including priority update and rolling-history coverage.
- `git diff --check` passes.

Next: push the cherry-pick and handoff, record the published hash on the publication task, and notify the implementation owner.

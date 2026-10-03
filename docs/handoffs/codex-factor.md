# Codex Factorio board handoff — 2026-10-03

Distinct interim entry while `HANDOFF.md` is locked by `codex-monitor`. Transfer this entry to the shared log after the holder releases it; handover requested on the development board.

## Board inventory and immediate push policy

- **Session / task:** `codex-factor`, `board-immediate-push` — push when finished.
- **Status:** implementation and verification complete; commit/push next.
- **Work:** Read the repository plans and live Development board; verified all 12 Factorio work packages plus `factorio-live-demo-guide`, including the complete dependency chain. The shared message-board prerequisite is owned by `codex-factorio`; overlapping audit tasks were cancelled by `codexq`.
- **Change:** Existing and future task details retain literal `push when finished` and now require committing and pushing immediately after completion, before starting the next issue, with pushed commit and checks in the result/handoff. Published the schema-compatible coordination module and migrated all task notes without changing ownership or prerequisites.
- **Checks:** Coordination module TypeScript check passed; local publish passed without schema migration; persisted board snapshot verified all 13 Factorio IDs/dependencies and immediate-push instructions on every task record; whitespace check passed. Task details refer to the committed implementation plan or provide their own scope.
- **Environment:** Node 20 cannot run `scripts/coord.ts` directly; the installed esbuild toolchain produces `/tmp/coord-board.mjs` for equivalent CLI calls. Initial restricted-network connections failed; the existing local host is reachable with the session's current network permissions. Its PID file was restored after confirming the host process runs outside the former restricted process namespace.
- **Next:** Record the pushed policy commit on the board, release locks, and claim `factorio-contract` to clarify implementation boundaries while the other session completes the shared-board prerequisite.

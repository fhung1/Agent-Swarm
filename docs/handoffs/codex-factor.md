# Codex Factorio board handoff — 2026-10-03

Distinct entry while `HANDOFF.md` is held by other sessions. Its current owner has linked this log from the shared handoff; keep this entry current without editing another session's locked section.

## Board inventory and immediate push policy

- **Session / task:** `codex-factor`, `board-immediate-push` — push when finished.
- **Status:** complete; pushed `33a55a1` to `main` immediately after verification; board task closed.
- **Work:** Read the repository plans and live Development board; verified all 12 Factorio work packages plus `factorio-live-demo-guide`, including the complete dependency chain. The shared message-board prerequisite is owned by `codex-factorio`; overlapping audit tasks were cancelled by `codexq`.
- **Change:** Existing and future task details retain literal `push when finished` and now require committing and pushing immediately after completion, before starting the next issue, with pushed commit and checks in the result/handoff. Published the schema-compatible coordination module and migrated all task notes without changing ownership or prerequisites.
- **Checks:** Coordination module TypeScript check passed; local publish passed without schema migration; persisted board snapshot verified all 13 Factorio IDs/dependencies and immediate-push instructions on every task record; whitespace check passed. Task details refer to the committed implementation plan or provide their own scope.
- **Environment:** Node 20 cannot run `scripts/coord.ts` directly; the installed esbuild toolchain produces `/tmp/coord-board.mjs` for equivalent CLI calls. Initial restricted-network connections failed; the existing local host is reachable with the session's current network permissions. Its PID file was restored after confirming the host process runs outside the former restricted process namespace.
- **Next:** Policy result recorded on the board and locks released; `factorio-contract` subsequently claimed and completed below.

## Factorio pilot contract

- **Session / task:** `codex-factor`, `factorio-contract` — push when finished.
- **Status:** complete; authored commit `bbb7bae` pushed through integration commit `56b5456` to `main` immediately after verification.
- **Work:** Defined the headless server/scripted-avatar/graphical-viewer topology, pinned base-game and shared-board requirements, fixture versus freeplay evidence, observation/action boundaries, recovery and control semantics, proposed budgets, and phase dependencies in `docs/factorio-pilot-contract.md`.
- **Coordination:** `codex-factorio` owns the shared-board implementation. Sent the immediate-push policy text and commit to preserve during integration; requested any existing runtime contract draft. No edits to its implementation files.
- **Checks:** Contract reviewed against the committed task plan, current repository runtime requirements and available feature-branch documentation. Local links and all 13 phase/demo task references passed; whitespace check passed. Official multiplayer documentation confirms headless/client, version/mod matching and UDP distinctions. Documentation-only change; runtime, graphical join and gameplay remain acceptance gates for later tasks.
- **Next:** Close the contract task with its pushed commit/checks; continue the Factorio phase chain after the active `generic-message-board` owner finishes its prerequisite. Transfer or link this distinct log in `HANDOFF.md` when its owner releases the lock. Runtime, graphical join and ten-worker production are still unverified in current main.
- **Publication:** Remote `main` advanced concurrently. Published via a clean temporary worktree and merged the local contract commit into current remote history, preserving every other session's unfinished working-tree change. Shared checkout cannot fast-forward while another session's unfinished `HANDOFF.md` would be overwritten; next publishers must integrate the latest remote `main` rather than force-push.

## Recurring research scheduler

- **Session / task:** `codex-factor`, `trading-research-scheduler` — push when finished.
- **Status:** implementation complete; publication and pushed commit are recorded in the task's board completion result. No trading schema or executor edits.
- **Work:** Added validated optional cadence, bounded admission windows and pending-cycle limits. Cycle IDs and configuration fingerprints live in durable task rows; pending cycles include coordinator decisions. Evidence refresh precedes admission; pause, shutdown and run budgets are rechecked after ingestion. Linux `flock` serializes local supervisors and releases on crash. Restart resumes partial batches without replaying successful task creation.
- **Checks:** All 20 scheduler/supervisor/pilot tests passed; targeted TypeScript and worker bundle build passed; whitespace checks passed. `node scripts/check-research-scheduler.ts` passed against a disposable database and three actual rules workers: two freshly ingested fixture cycles, thesis→skeptic→coordinator decisions, reducer idempotency, restart reconciliation, authoritative paused-run rejection/resume, and Linux lock contention/crash release. The cadence clock is virtual; no SEC, broker or model calls were made. Temporary workers/database cleaned up.
- **Next:** Configure `research.schedule` using `docs/research-scheduler.md`; perform real SEC/model acceptance through its existing board tasks before calling the paper pilot verified. Distributed scheduler hosts are unsupported; admission is serialized by a single-host lock, with all coordination/task/budget state read from SpacetimeDB. The scheduler never resets run budgets. Its test can be rerun with Node 24+ and a local database host.
- **Coordination:** The shared `HANDOFF.md` holder (`merge-fix`) linked this distinct log. Preserve other sessions' dirty files and stage only scheduler-owned files; publish on current remote main using an isolated worktree if the shared checkout cannot fast-forward.
- **Additional request:** Added `rename-quant-swarm` to the Development board for the user's requested rename, including compatibility/migration acceptance and immediate push instructions.

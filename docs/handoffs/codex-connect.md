# codex-connect — Factorio inference

Owner requests individually prompted inference agents for every Factorio actor and shared-board communication. Development and Factorio task/message cleanup completed with recoverable snapshots; new focused tasks replace the backlog.

Claimed `factorio-inference-contract` (push when finished). Working in `/tmp/factorio-inference-connect` on current origin/main, preserving shared dirty game edits. Locked inference contract/tests and this handoff. Existing `createAsker` structured providers will be reused; no game actions may come from a scripted fallback. Worker/live integration tasks posted for other sessions.

Implemented `src/factorio/inference.ts`: actor-scoped prompts, bounded peer context, strict action/chat/wait/complete decisions, same-run/world/history message selection, abort/timeout and no retries/fallback. Reuses the existing structured Ask provider interface. Root typecheck and six focused contract tests pass. Next: publish contract, integrate one worker per actor and verify prompted communication.

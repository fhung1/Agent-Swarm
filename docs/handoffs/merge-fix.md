# Development dashboard token recovery

- Status: implemented and validated; task `dashboard-token-recovery` (push when finished).
- Change: development dashboard drops an explicitly rejected saved login token and retries once without credentials. Session name/drafts remain intact. In-memory fallback works with unavailable storage; network failures and authorization denials retain the identity.
- Checks: dashboard typecheck, browser bundle, diff check, and seven targeted recovery cases passed (verification failure, unavailable storage, duplicate callback, network error, access denial, stale callback, retry bound). Running dashboard serves the updated bundle over Tailscale.
- Publication: publishing through an isolated worktree on latest upstream main to preserve other sessions' unfinished changes. Final commit/result will be on the coordination board.
- Next step for operator: reload the development dashboard to recover its rejected token.
- Shared HANDOFF.md is locked by codex-monitor; requested a link to this distinct entry.

## Factorio operation journal

- Status: implemented and validated; task `factorio-operation-journal` (push when finished).
- Scope: private immutable operation intents, engine receipt reconciliation, persisted observed-tick checkpoints, canonical SHA-256 command digests and sequential atomic admission slots. No bridge/worker edits; runtime and shared-board owners received the integration contract.
- Checks: project and focused TypeScript checks, nine tests including a real four-process admission race, and diff check passed. Tests simulate crash/restart and validate unknown outcome blocking, receipt replay, rollback/ownership/world mismatch, corruption and private files. No game/model/broker calls.
- Publication: isolated worktree `/tmp/quant-factorio-journal` preserves concurrent shared edits; pushed commit will be recorded on board task `factorio-operation-journal`.
- Integration: see `docs/factorio-operation-journal.md`. Only a newly persisted intent can submit; an existing intent or missing receipt never permits automatic replay. Engine must attest exact scope/history/digest. Tick checks cannot detect a restored save already advanced beyond the local tick floor; restores need a new history ID.
- Next: runtime/worker owners integrate engine receipts, live board ownership/reservations and adapter pause checks; complete F1 live crash/uncertainty acceptance. This primitive does not close the full F1 recovery or production gates.
- Shared HANDOFF.md remains locked by codex-monitor; requested a link to this distinct entry.

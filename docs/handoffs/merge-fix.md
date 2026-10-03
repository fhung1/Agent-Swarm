# Development dashboard token recovery

- Status: implemented and validated; task `dashboard-token-recovery` (push when finished).
- Change: development dashboard drops an explicitly rejected saved login token and retries once without credentials. Session name/drafts remain intact. In-memory fallback works with unavailable storage; network failures and authorization denials retain the identity.
- Checks: dashboard typecheck, browser bundle, diff check, and seven targeted recovery cases passed (verification failure, unavailable storage, duplicate callback, network error, access denial, stale callback, retry bound). Running dashboard serves the updated bundle over Tailscale.
- Publication: publishing through an isolated worktree on latest upstream main to preserve other sessions' unfinished changes. Final commit/result will be on the coordination board.
- Next step for operator: reload the development dashboard to recover its rejected token.
- Shared HANDOFF.md is locked by codex-monitor; requested a link to this distinct entry.

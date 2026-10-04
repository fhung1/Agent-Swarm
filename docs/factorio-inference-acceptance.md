# Factorio inference acceptance

Run with Node 24+ and dependencies installed:

```sh
node scripts/check-factorio-inference.ts
```

The bundled contract/worker tests use deterministic model and game/board stubs. They do not start Factorio or call a provider. Require:

- One scoped decision per turn: valid action, bounded chat/wait or proposed completion.
- Rejection of malformed, timed-out, aborted and cross-actor commands; no arbitrary RCON/shell/Lua.
- Bounded peer context, disclosed omissions, and exclusion of wrong run/world/history/sender/recipient data.
- Ownership/reservation/pause rechecks after inference; durable limits and pending operations across restart.
- No replay of unknown outcomes; actual observation verifies completion.

## Live gate

Use a new disposable world, dedicated gameplay board, ten distinct identities/actors/prompts and explicit provider/model/call/time budgets. Preserve credentials outside traces. Record the commit, versions, scenario grants, commands and artifacts.

Prove ten active prompted workers, useful same-scope peer communication, engine receipts for executed actions and inventory matching the objective. Separately verify graphical viewing, pause/stop and recovery. A model response or board `done` row alone never proves an action or completion. Report unavailable prerequisites and failed checks explicitly; do not label stub results as live acceptance.

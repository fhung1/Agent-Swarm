# Factorio readiness summary

The runtime/bridge and historical rules fixture have engine evidence. Prompted workers and launcher have deterministic tests. The complete operator-ready inference demo still requires [live acceptance](factorio-inference-acceptance.md).

Check these integration gaps before release:

- Crash-safe intent/receipt reconciliation in the actual worker, including missing receipts and save rollback.
- Fresh task/reservation ownership before each mutation, lease renewal and prolonged board outage recovery.
- Run-scoped identities/tasks/messages; no duplicate logical action results after uncertain acknowledgements.
- Persistent budgets through production, retry waits and viewing; bounded shutdown/restart.
- Real ten-worker model cooperation, graphical replay and resource-conserving outcomes.

The [roadmap](../IMPLEMENTATION_PLAN.md) and [acceptance packages](../FACTORIO_IMPLEMENTATION_TASKS.md) define the gates. Check current implementation and live assignments before adding tasks; historical audit IDs may have been cleared. Do not duplicate an existing owner's work.

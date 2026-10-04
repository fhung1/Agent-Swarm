# Factorio operation journal

[`OperationJournal`](../src/factorio/operation-journal.ts) stores immutable intents, terminal receipts and tick checkpoints. It is a storage primitive, not a board client or game executor. Full recovery needs worker/bridge integration.

Use one private directory per actor on a local filesystem supporting atomic hard links and directory fsync (directory 0700, files 0600). Writes fsync contents before atomic publication and then fsync the directory. Interrupted temporary files are ignored; corrupt/conflicting records block recovery.

## Integration rules

1. Wait for applied board state; verify run/world/history/actor, task ownership, current reservation and fresh game observation.
2. `prepare(operationId, command, context)` precedes submission. Only a newly created intent may submit in that uninterrupted admission attempt. Existing intents require reconciliation.
3. Recheck pause/ownership immediately before sending. A crash, timeout or missing receipt is uncertainty, not permission to replay.
4. Reconcile outstanding intents against authoritative engine receipts. Scope, ID, payload digest and result must match. Map bridge receipt statuses explicitly; never invent missing evidence.
5. Stop on rollback or mismatched history. Preserve records; do not delete a journal to bypass an error.

Canonical payloads sort object keys, accept finite JSON values and are bounded to 64 KiB/depth 32. The bridge must verify content against the digest. Caller-supplied recovery flags are assertions, not independent authorization.

Tick checkpoints detect a rollback below the largest observed tick, but not a restored save that has already advanced beyond it. Restores need a new history ID. Disk loss, deliberate tampering and restoring journal/world together are outside this primitive's guarantees.

```sh
node --test src/factorio/operation-journal.test.ts
```

Tests cover exact replay, unresolved/pending outcomes, scope/ownership errors, persisted rollback, malformed records, private files and a four-process admission race. They do not establish live production or end-to-end crash recovery.

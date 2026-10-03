# Factorio operation journal

`src/factorio/operation-journal.ts` supplies the local persistence part of F1 recovery. It does not connect to Factorio, execute commands, claim tasks or authenticate board permissions. Live crash recovery remains pending until the bridge and worker integrate this contract.

Use one private (0700) directory per avatar on a local Linux filesystem supporting atomic hard links and directory fsync. Keep it outside the repository/public artifacts; files are 0600. The journal creates immutable sequential intent slots, terminal receipts and observed-tick checkpoints. It fsyncs file contents before atomically publishing a record, then fsyncs the directory. An interrupted temporary file is ignored. Concurrent processes cannot admit different operations into the same next slot. Missing, conflicting or corrupted records stop recovery; do not delete journal records to bypass an error.

## Worker integration

1. Wait for the board subscription snapshot. Reconcile task ownership and resource reservations, and obtain a fresh game observation before calling the journal. `RecoveryContext` requires connected board, valid reservation, task ownership and matching run/world/history/avatar. These caller-provided values are assertions from a trusted worker, not substitutes for authoritative game/board enforcement. Check pause/ownership again immediately before transport submission.
2. Call `prepare(operationId, command, context)` **before** game submission. Use stable operation IDs. Only `created: true` may submit during that uninterrupted admission attempt. `created: false` requires reconciliation. A crash after persistence but before sending deliberately leaves an unknown outcome; it does not grant replay permission.
3. After a timeout, crash, or reconnect, enumerate `intents()`, then query the bridge for each outstanding operation. Pass the engine-returned receipt and current context to `reconcile`. Missing receipts block progress; pending receipts retain the unresolved slot. A matching terminal receipt is persisted and allows the next operation. Post the recovered result to the board using an idempotent message ID derived from the operation ID. Repeating reconciliation returns the same terminal result, so a crash before board publication does not require another game mutation.
4. Treat any error as a stop/reconciliation requirement. A different world, run, history or avatar, a backward observed tick, conflicting payload/receipt or lost task ownership must never cause an automatic retry of the game command.

Receipt wire contract:

```ts
{
  version: 1,
  scope: { runId, worldId, historyId, actorId },
  operationId,
  digest, // lowercase SHA-256 of UTF-8 canonicalPayload(command)
  tick,   // real engine tick, between intent observation and current observation
  status: 'pending' | 'succeeded' | 'failed',
  result: string // bounded compact engine result, including failure details
}
```

`canonicalPayload` sorts object keys recursively and serializes finite JSON values with JavaScript JSON number/string encoding. The bridge must match this exact representation (or receive canonical bytes, validate the decoded command and attest those same bytes). It must not trust a caller digest without checking content. Commands are limited to 64 KiB and nesting depth 32. Item/reach/recipe validation belongs to the action protocol, not this generic storage component. Receipts must attest the actual operation, scope and result; an adapter must not fabricate missing engine fields to fit this interface.

The scope's `historyId` must identify the authoritative game history. Tick checkpoints detect rollback below the largest locally observed tick. They cannot detect a restored save that has already advanced past that tick: the bridge/operator must provide a changed history ID for restores, and unresolved missing receipts always fail closed. Local disk loss, deliberate file tampering, restoring the journal together with the world and network-filesystem durability are outside this component's recovery guarantees.

No destructive cleanup/compaction runs automatically. Preserve records for the bounded pilot; long-running deployments need a separately verified retention policy. A valid receipt proves only what the bridge actually attests; it is not standalone proof of live five-plate production.

## Checks

With Node 24 and installed dependencies:

```sh
node --test src/factorio/operation-journal.test.ts
```

Tests cover a simulated crash after game execution, exact receipt replay, unresolved/pending outcomes, ownership and world mismatches, persisted rollback detection, malformed payloads/records, private files, interrupted temporary files and a real four-process admission race. No game, model or broker calls are made.

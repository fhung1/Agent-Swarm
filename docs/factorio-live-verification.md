# Historical Factorio fixture evidence

On 2026-10-03, run `demo-muszfy12` (world `dca8760b-f567-44ee-8a07-854f69b0a31f`) independently passed a ten-worker rules fixture: fifty real plates, ten distinct actors/identities/task owners, expected ore/fuel depletion and fifty matching engine/board transfer receipts. Shared-furnace contention and development-board separation were checked.

Historical artifact: `/tmp/factorio-live3-independent-evidence/verification.json`. Temporary files and demo services may no longer exist. This result does not establish a currently running world, model cooperation, graphical replay, freeplay or rocket production.

## Repeat verification

For a compatible running fixture with launcher `demo.json` and world manifest:

```sh
python3 factorio/verify-live.py --directory /absolute/path/to/demo --output /tmp/factorio-verification-new
```

Use a fresh output directory. The read-only checker inspects live processes, game state and board snapshots. Expected result: ten participants/tasks, fifty plates and fifty matched resource receipts. Viewing activity is excluded from production totals.

The output includes `verification.json`, the actual bridge mod ZIP and checksum. Serve only these safe artifacts, never the world, RCON credentials, tokens or journals. Matching-client graphical observation remains a separate check.

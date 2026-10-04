# Factorio runtime handoff

Runtime, private binding and bounded bridge have real 2.0.77 checks: ten actors, declared grants/seed, save/hash/port refusals, five-plate smelting, replay, pause and restart. Historical independent ten-worker verification recorded fifty plates with matching board/game receipts; see [evidence](../factorio-live-verification.md).

Recovery checkpoint/supervisor components landed in `22f14de` with six focused tests. Worker integration and real prolonged-outage evidence are separate gates. A past board outage stopped viewing workers; saved output did not establish automatic recovery.

Old demos had finite viewing windows and have expired. Use the current [runtime](../../factorio/README.md), [inference](../factorio-inference.md) and [access](../factorio-tailnet-access.md) guides; inspect services before claiming a live run. Graphical and real-provider acceptance remain independently verified requirements.

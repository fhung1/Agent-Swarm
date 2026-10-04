# Factorio demo guide

Start with [runtime setup](README.md), then [the prompted-worker launcher](../docs/factorio-inference.md). Use a fresh disposable world and a finite run budget. Check the current process/board state; old local paths and expired viewing sessions are not reusable launch instructions.

For a provider-free baseline, `python3 factorio/check-production.py` verifies one character producing five plates in an isolated world. The [historical ten-worker fixture](../docs/factorio-live-verification.md) records a separate fifty-plate rules result.

To watch, use a graphical Factorio 2.0.77 base-game client with the world's matching bridge mod. Join the configured game address; actors are near spawn. Watch the [Factorio board](../docs/factorio-tailnet-access.md) for scoped messages and compare them with game receipts/inventory.

Keep production and post-production viewing distinct. Record exact join address, versions, mod hash, deadlines and evidence. Stop the workers before saving/stopping their owned world. Do not claim live success from a successful build, dashboard page or board completion message alone.

# Independent live Factorio fixture verification

The `factorio/verify-live.py` checker reads the actual running engine over private RCON and snapshots the gameplay and development databases through the SpacetimeDB CLI. It does not submit actions or change run controls. Run on the Linux headless host while all workers and the world are still running:

```sh
python3 factorio/verify-live.py \
  --directory /home/cig/.local/share/agent-swarm/live-demo-3 \
  --output /tmp/factorio-live-verification-new
```

Use a fresh output directory. The launcher creates `demo.json` and the world manifest; the checker requires the cooperative-starter fixture and a gameplay database separate from trading/development. Expected output: `PASS: 10 participants, 10 tasks, 50 engine plates, 50 matched engine/board resource receipts`.

It verifies ten distinct live worker processes, ten distinct recorded connection identities and task owners, ten engine avatars each holding five plates, depletion of the declared fifty ore and ten coal transfers, unique engine receipts and matching action-result messages for all fifty resource transfers, world/history scope, recorded shared-furnace contention, and absence of gameplay task/message IDs in the development database. Viewing/patrol tasks are excluded from production counts. Participant names remain self-declared in this trusted private pilot; recorded identity metadata is not a hardened membership ACL.

The output contains `verification.json`, a ZIP of only the actual world's `agent-swarm_0.1.0` mod, and its SHA-256 checksum. Serve these public artifacts from a dedicated directory. Never serve the private world directory, RCON password, journals or identity tokens. Graphical client connection and human-visible gameplay are separate acceptance checks; this report proves engine/database consistency, not an unperformed graphical join.

## Verified run

- Run: `demo-muszfy12`, world `dca8760b-f567-44ee-8a07-854f69b0a31f`.
- Independent engine/database verification passed during the active ten-worker run on 2026-10-03.
- Evidence: `/tmp/factorio-live3-independent-evidence/verification.json`; its safe copy is served at `http://100.107.208.76:4180/verification.json` while the artifact server runs.
- Gameplay board: `http://100.107.208.76:4175/?board=factorio`.
- Viewer mod: `http://100.107.208.76:4180/agent-swarm_0.1.0.zip`; matching graphical Factorio 2.0.77 base-game client required. Multiplayer address `100.107.208.76:34198` over Tailscale, while the bounded demo is running.
- Result: fifty actual plates from declared fixture resources. This does not demonstrate natural-map progression, rocket production, or model-driven behavior.

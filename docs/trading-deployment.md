# Local paper trading deployment

This deployment profile supervises the paper research swarm and SpacetimeDB on one Linux host with systemd. It deliberately keeps SpacetimeDB on `127.0.0.1:3000`. The module does not yet authenticate deployed clients through OIDC, so this profile does not expose the database, dashboard, or development coordination board to a remote network. Alpaca credentials must be paper-account credentials; the executor's endpoint is fixed in code.

This is a reproducible local-only deployment profile, not live connectivity or order acceptance evidence. Choose and verify the paper account, feed entitlements, model budget, risk values, and deployment host before operating the pilot. For remote operation, first add supported service identity validation and a TLS endpoint, then run the separate connectivity, risk, order, dashboard, and restore acceptance tasks. Do not change the loopback listener to a public address.

## Host layout

The unit files expect a dedicated `agent-swarm` service account, a release checkout at `/opt/agent-swarm`, private configuration in `/etc/agent-swarm`, and persistent state under `/var/lib/agent-swarm`. They set a restrictive umask and filesystem protections. The supervisor writes logs to `/var/log/agent-swarm`; systemd also records stdout/stderr in the journal.

Install Node.js 24, SpacetimeDB CLI 2.10.2 at `/usr/local/bin/spacetime`, and a clean release checkout with generated bindings, runtime dependencies, and worker bundles already built. In the release build step, run `npm ci`, `npm run db:generate`, and `npm run build`, commit any generated binding change, and package the resulting clean checkout. Install the repository's systemd files from `deploy/systemd/` into `/etc/systemd/system/`. The live checkout should be root-owned and readable, not writable, by the service account. The service only needs write access to its state and log directories.

Create the service user and configuration directories:

```sh
sudo useradd --system --create-home --home-dir /var/lib/agent-swarm --shell /usr/sbin/nologin agent-swarm
sudo chmod 0700 /var/lib/agent-swarm
sudo install -d -o root -g agent-swarm -m 0750 /etc/agent-swarm
sudo install -d -o root -g agent-swarm -m 0750 /opt/agent-swarm
```

Copy a reviewed release into `/opt/agent-swarm`, then install and edit the configuration. Keep secrets out of both JSON files:

```sh
sudo install -o root -g agent-swarm -m 0640 config/swarm.example.json /etc/agent-swarm/swarm.json
sudo install -o root -g agent-swarm -m 0640 config/risk-policy.json /etc/agent-swarm/risk-policy.json
sudo install -o root -g agent-swarm -m 0640 deploy/systemd/*.service deploy/systemd/*.timer /etc/systemd/system/
sudo install -o root -g agent-swarm -m 0640 /dev/null /etc/agent-swarm/secrets.env
```

Set `riskPolicyFile` in `swarm.json` to `/etc/agent-swarm/risk-policy.json`. Choose the exact paper symbols, model names and per-run inference limits. Copy only the needed environment keys into `/etc/agent-swarm/secrets.env`; use systemd `EnvironmentFile` syntax with one `NAME=value` per line and no `export` prefixes. Depending on the selected providers and evidence adapter, keys can include `ALPACA_API_KEY`, `ALPACA_API_SECRET`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN`, and `SEC_USER_AGENT`.

Provision the file through a secret manager or a protected editor, then set owner `root:agent-swarm` and mode `0640`. Rotate a credential at its provider, replace only that value in the file, and restart `agent-swarm.service`. The supervisor removes provider, broker, and SEC credentials from each child process unless that specific worker requires them; the risk/executor/market-data workers receive Alpaca keys, the selected model worker receives its provider key, and only the SEC ingestor receives the contact User-Agent. Never place owner CLI tokens in this file. This filtering reduces accidental environment inheritance, but the supervisor and its workers share one OS account; it does not isolate a compromised worker from other files or processes owned by that account.

Provider and broker credentials can be rotated independently as described above. Local SpacetimeDB self-issued identity tokens do not expire; treat each worker token as a long-lived secret. If a worker token is exposed, stop the swarm, use the owner CLI to revoke the old agent identity and its run/account grants, securely remove that worker's token file, then register a replacement identity and reapply grants before restarting. The exposed token remains a valid authentication token but the revoked identity loses its module role and scoped access. Keep the non-expiring owner CLI token in a separate protected secret escrow and verify it before deployment; do not describe routine replacement as token rotation. Rotating the server JWT signing key invalidates all locally issued identity tokens, so it requires a planned all-client reissue and recovery window. See the [SpacetimeDB token quickstart](https://spacetimedb.com/docs/quickstarts/browser/) and [self-hosted key rotation guide](https://spacetimedb.com/docs/how-to/self-hosted-key-rotation/).

## Initialize and run

Start the private database service, then create the first local owner identity as the service account. The bootstrap helper only accepts a loopback HTTP origin, suppresses the token output, and stores the CLI config with mode `0600`:

```sh
sudo systemctl enable --now spacetimedb.service
sudo -u agent-swarm env HOME=/var/lib/agent-swarm \
  python3 /opt/agent-swarm/deploy/bootstrap-owner.py \
  --spacetime-cli /usr/local/bin/spacetime
```

This server-issued token does not expire. Keep an encrypted recovery copy of `/var/lib/agent-swarm/.config/spacetime/cli.toml` in a separate secret store; it is intentionally excluded from routine bundles. The token is passed briefly to the local CLI process during bootstrap, so run this once before starting worker processes and restrict the host to trusted administrators.

Publish the module as the service account. Generated bindings and worker bundles are part of the reviewed release checkout, so live code stays read-only:

```sh
sudo -u agent-swarm env HOME=/var/lib/agent-swarm /usr/local/bin/spacetime publish \
  --module-path /opt/agent-swarm/spacetimedb --server local --no-config --yes quant-swarm
```

Use the owner CLI identity to register worker tokens and apply the role, run, account, model-limit and risk-policy grants. These repeatable grants assign only each configured process's role and scoped run/account access:

Use the owner CLI identity as the service account to register worker tokens and apply the role, run, account, model-limit and risk-policy grants. These repeatable grants assign only each configured process's role and scoped run/account access:

```sh
sudo -u agent-swarm env HOME=/var/lib/agent-swarm /usr/bin/node /opt/agent-swarm/scripts/swarm.ts register --config /etc/agent-swarm/swarm.json
sudo -u agent-swarm env HOME=/var/lib/agent-swarm /usr/bin/node /opt/agent-swarm/scripts/swarm.ts grants --apply --config /etc/agent-swarm/swarm.json
```

`spacetime login show` identifies the owner CLI identity; keep owner credentials separate from worker tokens. Start both units:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now spacetimedb.service agent-swarm.service
sudo systemctl status spacetimedb.service agent-swarm.service
sudo journalctl -u spacetimedb.service -u agent-swarm.service -f
```

`agent-swarm.service` requires the database service and restarts the supervisor on failure. The supervisor restarts failed workers with bounded backoff. To pause operations, use the operator run controls before stopping the service. Review `journalctl` and the private per-process files in `/var/log/agent-swarm/`. Do not expose those logs to an untrusted operator: they can contain research and provider error details.

The deployment binds the database to loopback and uses local SpacetimeDB tokens rather than OIDC. The dashboard and the separate development board are not installed as network services by these units. A future remote profile must use TLS/WSS, authenticated operator access, validated OIDC service identities and an explicit network policy; a reverse proxy alone does not add module-side OIDC authorization.

## Deployment manifest

After installing the reviewed release checkout and publishing the module, record the release fingerprint:

```sh
sudo -u agent-swarm env HOME=/var/lib/agent-swarm \
  python3 /opt/agent-swarm/deploy/manifest.py \
  --repo /opt/agent-swarm --config /etc/agent-swarm/swarm.json \
  --spacetime-cli /usr/local/bin/spacetime \
  --output /var/lib/agent-swarm/artifacts/deployment-manifest.json
```

The JSON records the source commit/tree and clean-worktree bit, actual hashes for worker, dashboard, script and module source files, Node and SpacetimeDB CLI versions, hashes for the private config and risk policy, the selected role/provider/model names, package-lock hash, and every built `dist/` artifact's size and SHA-256. It never writes secret values or config contents. Treat the manifest as part of the release record and regenerate it after any code, model, policy, dependency, or configuration change. A dirty source checkout is recorded as such; it is not a release-ready state.

## Coordinated backups and recovery

The backup unit stops the swarm first, then SpacetimeDB, and uses the offline checksum-verifying `scripts/backup.sh` tool to bundle the database, SEC artifacts, worker tokens, and JWT signing keys. It starts only services that were active before the backup, database first. A failed backup still attempts to restore the previous service state. `backup-coordinated.sh` refuses to write unless `/mnt/agent-swarm-backups` is a mounted filesystem; mount an encrypted backup target there and configure its off-host replication and retention outside this host.

Enable the weekly timer only after the encrypted mount is configured and verified:

```sh
sudo systemctl enable --now agent-swarm-backup.timer
sudo systemctl list-timers agent-swarm-backup.timer
sudo systemctl start agent-swarm-backup.service
```

The manual service start is a real, coordinated backup: it briefly stops active workers and the database. Verify a new timestamped bundle and its `manifest.json` on the mounted target. Do not bypass the mount check or run backup while file writers are active; stop any ad-hoc worker, ingestor, or artifact/token writer first. The backup script also compares source checksums before and after copying and fails if a source changed.

For restore, stop both services and use `scripts/restore.sh` with fresh destination paths. Restore the `data/`, `artifacts/`, `tokens/`, and `identity/` payloads, place the restored SpacetimeDB data and JWT keys at the configured service paths, and restore worker token files to the service user's token directory with mode `0600`. Restore the owner CLI token separately from the secret manager; it is intentionally not copied into a general backup bundle. Start SpacetimeDB, confirm the expected module, owner identity and scoped views, then start workers and reconcile current Alpaca paper account/orders before enabling new execution. Run the backup recovery drill on an isolated host before relying on scheduled backups.

The backup includes the server signing keys, worker tokens, and release manifest and must be protected like credentials. A local backup alone is not disaster recovery; monitor off-host replication and periodically verify an isolated restore.

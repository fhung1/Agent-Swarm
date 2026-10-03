#!/bin/sh
set -eu
umask 077

root=/var/lib/agent-swarm
repo=/opt/agent-swarm
mount=${AGENT_SWARM_BACKUP_MOUNT:-/mnt/agent-swarm-backups}
cli=${SPACETIME_CLI:-/usr/local/bin/spacetime}

if ! /usr/bin/mountpoint -q "$mount"; then
  echo "Backup mount is unavailable: $mount" >&2
  exit 1
fi
if [ ! -x "$cli" ]; then
  echo "SpacetimeDB CLI is unavailable: $cli" >&2
  exit 1
fi
if [ ! -d "$root/spacetime" ] || [ ! -d "$root/artifacts" ] || [ ! -d "$root/.local/share/quant-swarm/tokens" ]; then
  echo "State, artifact, or worker-token directory is missing under $root" >&2
  exit 1
fi

was_db=0
was_swarm=0
if /usr/bin/systemctl is-active --quiet spacetimedb.service; then was_db=1; fi
if /usr/bin/systemctl is-active --quiet agent-swarm.service; then was_swarm=1; fi

restore_services() {
  result=$?
  trap - EXIT HUP INT TERM
  if [ "$was_db" -eq 1 ]; then /usr/bin/systemctl start spacetimedb.service || result=1; fi
  if [ "$was_swarm" -eq 1 ]; then /usr/bin/systemctl start agent-swarm.service || result=1; fi
  exit "$result"
}
trap restore_services EXIT HUP INT TERM

if [ "$was_swarm" -eq 1 ]; then /usr/bin/systemctl stop agent-swarm.service; fi
if [ "$was_db" -eq 1 ]; then /usr/bin/systemctl stop spacetimedb.service; fi

stamp=$(/usr/bin/date -u +%Y%m%dT%H%M%SZ)
bundle="$mount/agent-swarm-$stamp"
"$repo/scripts/backup.sh" "$bundle" \
  --data-dir "$root/spacetime" \
  --artifacts-dir "$root/artifacts" \
  --tokens-dir "$root/.local/share/quant-swarm/tokens" \
  --jwt-private-key "$root/identity/id_ecdsa" \
  --jwt-public-key "$root/identity/id_ecdsa.pub"

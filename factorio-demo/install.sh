#!/usr/bin/env bash
set -euo pipefail
# Official pinned headless runtime; never alters an existing installation.
version=2.0.77
install_dir="${FACTORIO_INSTALL_DIR:-$HOME/.local/share/agent-swarm/factorio/$version}"
if [[ "$(uname -s)" != Linux || "$(uname -m)" != x86_64 ]]; then
  echo 'This installer supports Linux x86_64 headless hosts.' >&2
  exit 1
fi
if [[ -e "$install_dir" ]]; then
  "$install_dir/factorio/bin/x64/factorio" --version | head -1 | grep -F "Version: $version " >/dev/null || { echo 'Existing installation has a different version or is incomplete; choose a fresh FACTORIO_INSTALL_DIR.' >&2; exit 1; }
  echo "Already installed: $install_dir/factorio/bin/x64/factorio"
  exit 0
fi
for tool in curl tar sha256sum; do command -v "$tool" >/dev/null || { echo "Missing prerequisite: $tool" >&2; exit 1; }; done
mkdir -p "$(dirname "$install_dir")"
staging=$(mktemp -d "$(dirname "$install_dir")/.factorio-install.XXXXXX")
trap 'rm -rf -- "$staging"' EXIT
curl --fail --location --retry 2 --connect-timeout 15 --max-time 300 --proto '=https' --proto-redir '=https' \
  "https://www.factorio.com/get-download/$version/headless/linux64" --output "$staging/runtime.tar.xz"
sha256sum "$staging/runtime.tar.xz" > "$staging/download.sha256"
tar -xJf "$staging/runtime.tar.xz" -C "$staging"
"$staging/factorio/bin/x64/factorio" --version | head -1 | grep -F "Version: $version " >/dev/null
# mkdir is exclusive: concurrent installers cannot replace an existing install.
mkdir "$install_dir"
mv "$staging/factorio" "$install_dir/factorio"
# This digest is provenance, not an independently authenticated vendor checksum.
awk '{print $1 "  runtime.tar.xz"}' "$staging/download.sha256" > "$install_dir/download.sha256"
echo "Installed: $install_dir/factorio/bin/x64/factorio"

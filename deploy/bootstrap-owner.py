#!/usr/bin/env python3
"""Create the first local SpacetimeDB owner identity and store its CLI token privately."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen


def main() -> None:
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', default='http://127.0.0.1:3000', help='Local SpacetimeDB HTTP origin')
    parser.add_argument('--spacetime-cli', default='/usr/local/bin/spacetime')
    args = parser.parse_args()
    parsed = urlparse(args.host)
    if parsed.scheme != 'http' or parsed.hostname not in {'127.0.0.1', 'localhost', '::1'}:
        parser.error('--host must be a loopback http:// origin; remote identity provisioning is refused')
    if parsed.path not in {'', '/'} or parsed.query or parsed.fragment:
        parser.error('--host must be only a loopback origin, without a path or query')

    home = Path(os.environ.get('HOME', str(Path.home()))).resolve()
    config_dir = home / '.config' / 'spacetime'
    config_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(config_dir, 0o700)
    config_path = config_dir / 'cli.toml'
    if config_path.exists() or config_path.is_symlink():
        parser.exit(1, f'Owner CLI config already exists; refusing to replace it: {config_path}\n')
    try:
        request = Request(f'{args.host.rstrip("/")}/v1/identity', data=b'', method='POST')
        with urlopen(request, timeout=10) as response:
            identity = json.load(response)
    except (OSError, HTTPError, URLError, json.JSONDecodeError):
        parser.exit(1, 'Could not create a local SpacetimeDB identity; no response details or token were printed.\n')
    token = identity.get('token') if isinstance(identity, dict) else None
    owner = identity.get('identity') if isinstance(identity, dict) else None
    if not isinstance(token, str) or not token or not isinstance(owner, str) or not owner:
        parser.exit(1, 'Local SpacetimeDB returned an incomplete identity response.\n')

    environment = {**os.environ, 'HOME': str(home)}
    result = subprocess.run([args.spacetime_cli, '--config-path', str(config_path), 'login', '--token', token],
                            env=environment, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, check=False)
    if result.returncode != 0 or not config_path.is_file():
        error = result.stderr.replace(token, '[redacted]')[-1000:]
        parser.exit(1, f'Could not persist the local owner CLI identity: {error or "CLI config was not created"}\n')
    os.chmod(config_path, 0o600)
    print(f'Owner identity provisioned: {owner}')
    print(f'Private CLI config: {config_path} (mode 0600); token was not printed.')


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""Local operator checks only; never asserts that a player joined a game."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess


def check(binary, server, display):
    executable = shutil.which(binary)
    checks = []
    if executable:
        try:
            result = subprocess.run([executable, '--version'], capture_output=True,
                                    text=True, timeout=10, check=False)
            valid = result.returncode == 0 and 'Factorio' in result.stdout
            checks.append({'name': 'factorio_binary', 'ok': valid,
                           'detail': result.stdout.strip()[:500] if valid else 'Version check failed'})
        except (OSError, subprocess.TimeoutExpired):
            checks.append({'name': 'factorio_binary', 'ok': False, 'detail': 'Version check failed or timed out'})
    else:
        checks.append({'name': 'factorio_binary', 'ok': False, 'detail': 'Executable not found'})
    checks.append({'name': 'server_address', 'ok': bool(server.strip()),
                   'detail': 'Configured (reachability unverified)' if server.strip() else 'Set FACTORIO_SERVER'})
    checks.append({'name': 'graphical_session', 'ok': bool(display),
                   'detail': 'Display configured (access unverified)' if display else 'Run inside the game desktop'})
    return {'checks': checks, 'prerequisites_ok': all(c['ok'] for c in checks),
            'connection_verified': False,
            'next_step': 'Join the configured server from the graphical client and capture screenshot evidence.'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', default=os.environ.get('FACTORIO_BINARY', 'factorio'))
    parser.add_argument('--server', default=os.environ.get('FACTORIO_SERVER', ''))
    parser.add_argument('--output', type=Path, help='Optional JSON artifact path')
    args = parser.parse_args()
    report = check(args.binary, args.server,
                   os.environ.get('DISPLAY') or os.environ.get('WAYLAND_DISPLAY'))
    serialized = json.dumps(report, indent=2) + '\n'
    if args.output:
        args.output.write_text(serialized)
    print(serialized, end='')
    return 0 if report['prerequisites_ok'] else 1


if __name__ == '__main__':
    raise SystemExit(main())

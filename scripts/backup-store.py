#!/usr/bin/env python3
"""Offline SpacetimeDB 2.10.2 recovery bundles, for macOS/Linux."""
import argparse
import contextlib
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


def digest(file):
    checksum = hashlib.sha256()
    with file.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            checksum.update(chunk)
    return checksum.hexdigest()


def inventory(root, exclude_pid=False):
    rows = {}
    for file in sorted(root.rglob('*')):
        if file.is_symlink():
            raise ValueError(f'Symlinks are unsupported: {file}')
        if file.is_dir():
            continue
        if not file.is_file():
            raise ValueError(f'Not a regular file: {file}')
        name = file.relative_to(root).as_posix()
        if exclude_pid and name == 'spacetime.pid':
            continue
        rows[name] = {'bytes': file.stat().st_size, 'sha256': digest(file)}
    return rows


def fresh(path):
    if path.exists() or path.is_symlink():
        raise ValueError(f'Destination already exists; choose a fresh path: {path}')


def distinct(paths):
    for index, left in enumerate(paths):
        for right in paths[index + 1:]:
            if left == right or left in right.parents or right in left.parents:
                raise ValueError(f'Paths must not overlap: {left} and {right}')


@contextlib.contextmanager
def offline(data):
    # v2.10.2 ServerDataDir::pid_file uses fs2 exclusive flock on this file.
    # Hold the same lock throughout the copy so the server cannot start midway.
    lock = data / 'spacetime.pid'
    if lock.is_symlink():
        raise ValueError('spacetime.pid must not be a symlink')
    with lock.open('a+b') as stream:
        try:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError('SpacetimeDB is running; stop the server before backup') from None
        yield


def copy_tree(source, destination, rows):
    destination.mkdir(mode=0o700)
    for name in rows:
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        shutil.copyfile(source / name, target)
        target.chmod(0o600)
    if inventory(destination) != rows:
        raise ValueError('Copied files failed checksum verification')


def backup(args):
    data = Path(args.data_dir).resolve()
    artifacts = Path(args.artifacts_dir).resolve()
    output = Path(args.bundle).resolve()
    sources = {'data': data, 'artifacts': artifacts}
    if args.factorio_dir:
        sources['factorio'] = Path(args.factorio_dir).resolve()
    if args.tokens_dir:
        sources['tokens'] = Path(args.tokens_dir).resolve()
    keys = [Path(args.jwt_private_key).resolve(), Path(args.jwt_public_key).resolve()]
    distinct([*sources.values(), output, *keys])
    fresh(output)
    for source in sources.values():
        if not source.is_dir():
            raise ValueError(f'Source directory is missing: {source}')
    if not (data / 'metadata.toml').is_file() or not (data / 'control-db').is_dir():
        raise ValueError('Source is not a SpacetimeDB standalone data directory')
    version = subprocess.check_output([os.environ.get('SPACETIME_CLI', 'spacetime'), '--version'], text=True).strip()
    if 'spacetimedb tool version 2.10.2;' not in version:
        raise ValueError('Backup requires SpacetimeDB CLI 2.10.2')
    output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with offline(data):
        before = {name: inventory(source, name == 'data') for name, source in sources.items()}
        stage = Path(tempfile.mkdtemp(prefix='.quant-backup-', dir=output.parent))
        try:
            for name, source in sources.items():
                copy_tree(source, stage / name, before[name])
            (stage / 'identity').mkdir(mode=0o700)
            for source, name in zip(keys, ['id_ecdsa', 'id_ecdsa.pub']):
                if not source.is_file():
                    raise ValueError(f'JWT key file is missing: {source}')
                shutil.copyfile(source, stage / 'identity' / name)
                (stage / 'identity' / name).chmod(0o600)
            after = {name: inventory(source, name == 'data') for name, source in sources.items()}
            if before != after:
                raise ValueError('Sources changed during backup; stop all artifact/token writers')
            if any(digest(source) != digest(stage / 'identity' / name)
                   for source, name in zip(keys, ['id_ecdsa', 'id_ecdsa.pub'])):
                raise ValueError('JWT keys changed during backup')
            manifest = {
                'format': 1, 'spacetimedb_version': '2.10.2',
                'created_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                'source_paths': {name: str(source) for name, source in sources.items()},
                'files': inventory(stage),
            }
            (stage / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
            (stage / 'manifest.json').chmod(0o600)
            fresh(output)
            stage.rename(output)
        finally:
            if stage.exists():
                shutil.rmtree(stage)
    print(f'Backup verified: {output} ({len(manifest["files"])} files)')


def restore(args):
    bundle = Path(args.bundle).resolve()
    manifest_path = bundle / 'manifest.json'
    if manifest_path.is_symlink():
        raise ValueError('Manifest must not be a symlink')
    manifest = json.loads(manifest_path.read_text())
    if manifest.get('format') != 1 or manifest.get('spacetimedb_version') != '2.10.2':
        raise ValueError('Unsupported bundle format or SpacetimeDB version')
    actual = inventory(bundle)
    del actual['manifest.json']
    if actual != manifest['files']:
        raise ValueError('Bundle checksum verification failed')
    groups = {name.split('/')[0] for name in actual}
    if not {'data', 'identity'} <= groups or not groups <= {'data', 'artifacts', 'identity', 'tokens', 'factorio'}:
        raise ValueError('Bundle has unexpected or missing payload directories')
    targets = {
        'data': Path(args.data_dir).resolve(), 'artifacts': Path(args.artifacts_dir).resolve(),
        'identity': Path(args.identity_dir).resolve(),
    }
    has_tokens = 'tokens' in manifest['source_paths']
    if has_tokens != bool(args.tokens_dir):
        raise ValueError('Supply --tokens-dir exactly when the bundle includes worker tokens')
    if has_tokens:
        targets['tokens'] = Path(args.tokens_dir).resolve()
    has_factorio = 'factorio' in manifest['source_paths']
    if has_factorio != bool(args.factorio_dir):
        raise ValueError('Supply --factorio-dir exactly when the bundle includes Factorio state')
    if has_factorio:
        targets['factorio'] = Path(args.factorio_dir).resolve()
    distinct([bundle, *targets.values()])
    for target in targets.values():
        fresh(target)
    stages = {}
    installed = []
    try:
        for name, target in targets.items():
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            stage_parent = Path(tempfile.mkdtemp(prefix='.quant-restore-', dir=target.parent))
            stages[name] = stage_parent
            rows = {key[len(name) + 1:]: value for key, value in actual.items() if key.startswith(name + '/')}
            copy_tree(bundle / name, stage_parent / name, rows)
        for name, target in targets.items():
            fresh(target)
            (stages[name] / name).rename(target)
            installed.append(target)
    except Exception:
        for target in installed:
            shutil.rmtree(target)
        raise
    finally:
        for stage in stages.values():
            shutil.rmtree(stage)
    print('Restore verified. Start SpacetimeDB 2.10.2 using the restored data and JWT keys; keep workers stopped until reconciliation.')


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    save = sub.add_parser('backup', help='Requires a stopped server and stopped artifact/token writers')
    load = sub.add_parser('restore', help='Verifies checksums before writing fresh destinations')
    for command in [save, load]:
        command.add_argument('bundle')
        command.add_argument('--data-dir', required=True)
        command.add_argument('--artifacts-dir', required=True)
        command.add_argument('--tokens-dir')
        command.add_argument('--factorio-dir')
    save.add_argument('--jwt-private-key', required=True)
    save.add_argument('--jwt-public-key', required=True)
    load.add_argument('--identity-dir', required=True)
    args = parser.parse_args()
    try:
        (backup if args.command == 'backup' else restore)(args)
    except (OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        parser.exit(1, f'{args.command}: {error}\n')


if __name__ == '__main__':
    main()

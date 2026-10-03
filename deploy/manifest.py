#!/usr/bin/env python3
"""Write a redacted, machine-readable deployment fingerprint for an Agent Swarm checkout."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile


def digest(path: Path) -> str:
    sha = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            sha.update(block)
    return sha.hexdigest()


def command(args: list[str], cwd: Path) -> str:
    return subprocess.check_output(args, cwd=cwd, text=True, stderr=subprocess.STDOUT).strip()


def write(args: argparse.Namespace) -> dict:
    root = args.repo.resolve()
    config_path = args.config.resolve()
    config = json.loads(config_path.read_text())
    swarm_config = config.get('swarm', config)
    if not isinstance(swarm_config, dict):
        raise ValueError('config must contain a swarm object')
    policy_config = config.get('policy')
    if isinstance(policy_config, dict):
        policy_version = policy_config.get('version')
        policy_hash = hashlib.sha256(json.dumps(policy_config, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        policy_source = 'embedded-config'
    else:
        policy_value = swarm_config.get('riskPolicyFile')
        if not isinstance(policy_value, str) or not policy_value:
            raise ValueError('swarm config must name riskPolicyFile or include an inline policy')
        policy_path = Path(policy_value)
        if not policy_path.is_absolute():
            policy_path = root / policy_path
        policy_path = policy_path.resolve()
        if not policy_path.is_file():
            raise ValueError(f'risk policy file is missing: {policy_path}')
        policy = json.loads(policy_path.read_text())
        policy_version = policy.get('version')
        policy_hash = digest(policy_path)
        policy_source = policy_path.relative_to(root).as_posix() if policy_path.is_relative_to(root) else str(policy_path)
    if not isinstance(policy_version, str) or not policy_version:
        raise ValueError('risk policy must name a version')

    git = ['git', '-c', f'safe.directory={root}']
    status = command([*git, 'status', '--porcelain', '--untracked-files=all'], root)
    commit = command([*git, 'rev-parse', 'HEAD'], root)
    source_tree = command([*git, 'rev-parse', 'HEAD^{tree}'], root)
    package_lock = root / 'package-lock.json'
    if not package_lock.is_file():
        raise ValueError('package-lock.json is missing')
    artifacts_dir = root / 'dist'
    if not artifacts_dir.is_dir():
        raise ValueError('Build artifacts are missing; run npm run build before writing the deployment manifest')
    artifacts = []
    for file in sorted(p for p in artifacts_dir.rglob('*') if p.is_file()):
        artifacts.append({'path': file.relative_to(root).as_posix(), 'sha256': digest(file), 'bytes': file.stat().st_size})
    if not artifacts:
        raise ValueError('No build artifacts found under dist/')
    source_files = []
    source_roots = [root / name for name in ('src', 'scripts', 'spacetimedb', 'dashboard', 'deploy')]
    source_roots.extend(path for path in (root / 'package.json', package_lock) if path.is_file())
    for source_root in source_roots:
        candidates = [source_root] if source_root.is_file() else sorted(p for p in source_root.rglob('*') if p.is_file())
        for file in candidates:
            source_files.append({'path': file.relative_to(root).as_posix(), 'sha256': digest(file), 'bytes': file.stat().st_size})

    brains = {}
    for role, definition in sorted((swarm_config.get('agents') or {}).items()):
        if isinstance(definition, dict):
            brains[role] = {'brain': definition.get('brain', 'rules'), 'model': definition.get('model'), 'count': definition.get('count')}
    node_version = command(['node', '--version'], root)
    try:
        node_major = int(node_version.removeprefix('v').split('.', 1)[0])
    except ValueError as error:
        raise ValueError(f'cannot parse Node.js version: {node_version}') from error
    if node_major < 24:
        raise ValueError(f'Node.js 24 or newer is required, found {node_version}')
    spacetime_version = command([args.spacetime_cli, '--version'], root)
    if 'spacetimedb tool version 2.10.2;' not in spacetime_version:
        raise ValueError('SpacetimeDB CLI 2.10.2 is required')

    result = {
        'format': 'agent-swarm-deployment-v1',
        'commit': commit,
        'source_tree': source_tree,
        'source_files': source_files,
        'working_tree_clean': not bool(status),
        'node': node_version,
        'spacetimedb_cli': spacetime_version,
        'config_sha256': digest(config_path),
        'risk_policy': {'version': policy_version, 'source': policy_source, 'sha256': policy_hash},
        'models': brains,
        'package_lock_sha256': digest(package_lock),
        'build_artifacts': artifacts,
    }
    if args.output:
        output = args.output.resolve()
        output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        fd, temporary = tempfile.mkstemp(prefix=f'.{output.name}.', dir=output.parent)
        try:
            with os.fdopen(fd, 'w', encoding='utf-8') as stream:
                json.dump(result, stream, indent=2, sort_keys=True)
                stream.write('\n')
            os.chmod(temporary, 0o600)
            os.replace(temporary, output)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
    else:
        json.dump(result, sys.stdout, indent=2, sort_keys=True)
        sys.stdout.write('\n')
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', type=Path, default=Path(__file__).resolve().parent.parent)
    parser.add_argument('--config', type=Path, required=True, help='Swarm config or paper-pilot config; values are hashed, not emitted')
    parser.add_argument('--spacetime-cli', default=os.environ.get('SPACETIME_CLI', 'spacetime'))
    parser.add_argument('--output', type=Path, help='Write atomically with mode 0600; default prints JSON')
    args = parser.parse_args()
    try:
        write(args)
    except (OSError, ValueError, KeyError, json.JSONDecodeError, subprocess.CalledProcessError) as error:
        parser.exit(1, f'deployment manifest: {error}\n')


if __name__ == '__main__':
    main()

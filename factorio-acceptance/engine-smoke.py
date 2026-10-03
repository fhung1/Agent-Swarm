#!/usr/bin/env python3
"""Exercise the real Factorio bridge in a disposable world, independent of workers."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import tempfile
import time

spec = importlib.util.spec_from_file_location('probe', Path(__file__).with_name('inspect-world.py'))
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


def free_port(kind):
    with socket.socket(type=kind) as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', required=True)
    parser.add_argument('--mod', required=True)
    parser.add_argument('--report', required=True)
    args = parser.parse_args()
    binary = Path(args.binary).resolve()
    mod = Path(args.mod).resolve()
    version = subprocess.check_output([str(binary), '--version'], text=True).splitlines()[0]
    if '2.0.77 ' not in version:
        raise RuntimeError('This acceptance fixture targets Factorio 2.0.77')
    password = secrets.token_urlsafe(24)
    report = {'runtime': version, 'checks': [], 'limitations': ['No graphical client used', 'No autonomous model inference', 'No victory proven']}
    with tempfile.TemporaryDirectory(prefix='factorio-engine-check-') as tmp:
        root = Path(tmp)
        (root / 'data' / 'saves').mkdir(parents=True)
        config = root / 'config.ini'
        config.write_text('[path]\nread-data=' + str(binary.parents[2] / 'data') + '\nwrite-data=' + str(root / 'data') + '\n')
        mods = root / 'mods'; mods.mkdir()
        info = json.loads((mod / 'info.json').read_text())
        shutil.copytree(mod, mods / (info['name'] + '_' + info['version']))
        (mods / 'mod-list.json').write_text(json.dumps({'mods': [{'name': 'base', 'enabled': True}, {'name': info['name'], 'enabled': True}, *[{'name': name, 'enabled': False} for name in ['space-age', 'quality', 'elevated-rails']]]}))
        common = [str(binary), '--config', str(config), '--mod-directory', str(mods)]
        create = subprocess.run(common + ['--create', str(root / 'world.zip'), '--map-gen-seed', '12345'], capture_output=True, text=True, timeout=90)
        if create.returncode:
            raise RuntimeError('Map creation failed: ' + (create.stdout + create.stderr)[-4000:])
        port, game_port = free_port(socket.SOCK_STREAM), free_port(socket.SOCK_DGRAM)
        settings = root / 'server.json'
        server_settings = json.loads((binary.parents[2] / 'data' / 'server-settings.example.json').read_text())
        server_settings.update({'name': 'Disposable Factorio acceptance', 'visibility': {'public': False, 'lan': False}, 'require_user_verification': False, 'auto_pause': False, 'autosave_interval': 0})
        settings.write_text(json.dumps(server_settings))
        log_path = root / 'server.log'
        log_path.touch(mode=0o600)
        with log_path.open('w') as log:
            server = subprocess.Popen(common + ['--start-server', str(root / 'world.zip'), '--server-settings', str(settings), '--bind', '127.0.0.1', '--port', str(game_port), '--rcon-bind', f'127.0.0.1:{port}', '--rcon-password', password], stdout=log, stderr=subprocess.STDOUT)
            try:
                deadline = time.monotonic() + 45
                while True:
                    if server.poll() is not None:
                        raise RuntimeError('Server exited: ' + log_path.read_text()[-4000:].replace(password, '[redacted]'))
                    try:
                        if probe.query('127.0.0.1', port, password, '/silent-command rcon.print("ready")').strip() == 'ready': break
                    except (OSError, RuntimeError): pass
                    if time.monotonic() > deadline: raise RuntimeError('Server did not become ready')
                    time.sleep(.2)
                run = 'acceptance-' + secrets.token_hex(4)
                def request(agent, **payload):
                    payload = {'runId': run, 'agent': agent, **payload}
                    raw = json.dumps(payload, separators=(',', ':')).encode()
                    literal = '"' + ''.join('\\' + str(byte).zfill(3) for byte in raw) + '"'
                    command = '/silent-command rcon.print(remote.call("agent_swarm","dispatch",' + literal + '))'
                    result = json.loads(probe.query('127.0.0.1', port, password, command).strip())
                    if not result['ok']: raise RuntimeError(result['error'])
                    return result.get('value')
                def completed(agent, op):
                    deadline = time.monotonic() + 15
                    while time.monotonic() < deadline:
                        receipt = request(agent, kind='receipt', id=op)
                        if receipt and receipt['status'] != 'pending': return receipt
                        time.sleep(.1)
                    raise RuntimeError('Action receipt did not complete: ' + op)
                def rejected(fn):
                    try: fn()
                    except RuntimeError: return
                    raise AssertionError('Expected action refusal')
                request('operator', kind='setup', worldId=run, radius=16, scenario='cooperative-starter')
                observations = [request(f'agent-{i:02}', kind='join', index=i) for i in range(1, 11)]
                census = probe.census('127.0.0.1', port, password)
                assert len(census['characters']) == 10, census
                assert len({c['unit'] for c in census['characters']}) == 10
                report['checks'].append('Ten distinct engine character entities exist')
                report['characters'] = census['characters']
                agent = 'agent-01'
                obs = observations[0]
                ore = next(e for e in obs['entities'] if e['name'] == 'iron-ore')
                action = {'kind': 'mine', 'target': {k: ore[k] for k in ('name', 'x', 'y')}, 'count': 1}
                before = obs['inventory'].get('iron-ore', 0)
                request(agent, kind='act', id='mine-once', action=action)
                receipt = completed(agent, 'mine-once')
                assert receipt['status'] == 'succeeded', receipt
                assert request(agent, kind='observe')['inventory'].get('iron-ore', 0) == before + 1
                request(agent, kind='act', id='mine-once', action=action)
                assert request(agent, kind='observe')['inventory'].get('iron-ore', 0) == before + 1
                rejected(lambda: request(agent, kind='act', id='mine-once', action={'kind': 'wait', 'ticks': 1}))
                rejected(lambda: request('agent-02', kind='receipt', id='mine-once'))
                report['checks'].append('Mining changes real inventory exactly once; reused operation IDs and foreign receipts refused')
                rejected(lambda: request(agent, kind='act', id='too-far', action={'kind': 'move', 'x': 9999, 'y': 9999}))
                request(agent, kind='act', id='paused-wait', action={'kind': 'wait', 'ticks': 60})
                request('operator', kind='pause', paused=True)
                time.sleep(1.2)
                assert request(agent, kind='receipt', id='paused-wait')['status'] == 'pending'
                rejected(lambda: request('agent-02', kind='act', id='while-paused', action={'kind': 'wait', 'ticks': 1}))
                request('operator', kind='pause', paused=False)
                assert completed(agent, 'paused-wait')['status'] == 'succeeded'
                report['checks'].append('Pause stops pending actions and refuses new actions; explicit resume permits progress')
                # Save/reload proves receipts live in the game save, not only in worker memory.
                save_reply = probe.query('127.0.0.1', port, password, '/server-save acceptance-restart')
                saved = root / 'data' / 'saves' / 'acceptance-restart.zip'
                deadline = time.monotonic() + 15
                while not saved.exists():
                    if time.monotonic() > deadline: raise RuntimeError('Server save did not finish: ' + save_reply + '; files=' + str(list(root.rglob('*.zip'))) + '; log=' + log_path.read_text()[-1800:])
                    time.sleep(.1)
                server.terminate(); server.wait(timeout=15)
                server = subprocess.Popen(common + ['--start-server', str(saved), '--server-settings', str(settings), '--bind', '127.0.0.1', '--port', str(game_port), '--rcon-bind', f'127.0.0.1:{port}', '--rcon-password', password], stdout=log, stderr=subprocess.STDOUT)
                deadline = time.monotonic() + 30
                while True:
                    if server.poll() is not None: raise RuntimeError('Restarted server exited')
                    try:
                        restored = request(agent, kind='observe')
                        break
                    except (OSError, RuntimeError):
                        if time.monotonic() > deadline: raise RuntimeError('Restarted server never became ready')
                        time.sleep(.2)
                assert restored['inventory'].get('iron-ore', 0) == before + 1
                assert completed(agent, 'mine-once')['status'] == 'succeeded'
                request(agent, kind='act', id='mine-once', action=action)
                assert request(agent, kind='observe')['inventory'].get('iron-ore', 0) == before + 1
                assert {c['unit'] for c in probe.census('127.0.0.1', port, password)['characters']} == {c['unit'] for c in census['characters']}
                report['checks'].append('Game save/restart preserves all ten actors, receipts, and exactly-once inventory effect')
                report['summary'] = request('operator', kind='summary')
                report['passed'] = True
            except Exception as error:
                report['passed'] = False
                report['error'] = str(error).replace(password, '[redacted]')
                raise
            finally:
                server.terminate()
                try: server.wait(timeout=15)
                except subprocess.TimeoutExpired: server.kill(); server.wait()
                Path(args.report).write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({'passed': report['passed'], 'checks': report['checks'], 'report': args.report}, indent=2))


if __name__ == '__main__': main()

"""Exercise cleanup on two disposable boards; never uses the operator database."""
import json
import os
from pathlib import Path
import socket
import sys
import subprocess
import tempfile
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
CLI = os.environ.get('SPACETIME_CLI', str(Path.home() / '.local/bin/spacetime'))

with tempfile.TemporaryDirectory(prefix='board-cleanup-check-') as directory:
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    origin = f'http://127.0.0.1:{port}'
    base = [CLI, '--config-path', str(Path(directory) / 'cli.toml')]

    def command(*args, fails=False):
        result = subprocess.run([*base, *args], cwd=ROOT, capture_output=True, text=True, timeout=90)
        assert (result.returncode != 0) if fails else (result.returncode == 0), result.stderr[-3000:]
        return result.stdout

    def call(db, reducer, *args, fails=False):
        return command('call', '--server', origin, db, reducer, *[json.dumps(a) for a in args], fails=fails)

    def rows(db, table):
        result = command('subscribe', '--server', origin, db, f'SELECT * FROM {table}', '--print-initial-update', '-n', '0', '--yes')
        return json.loads(next(line for line in result.splitlines() if line.startswith('{')))[table]['inserts']

    with open(Path(directory) / 'server.log', 'w') as log:
        server = subprocess.Popen([*base, 'start', '--listen-addr', f'127.0.0.1:{port}', '--data-dir', str(Path(directory) / 'data'), '--non-interactive'], stdout=log, stderr=log)
        try:
            for _ in range(200):
                assert server.poll() is None, 'Disposable server exited'
                try:
                    with urllib.request.urlopen(origin + '/v1/ping', timeout=.3):
                        break
                except OSError:
                    time.sleep(.1)
            else:
                raise AssertionError('Server startup timeout')
            request = urllib.request.Request(origin + '/v1/identity', method='POST')
            with urllib.request.urlopen(request) as response:
                token = json.load(response)['token']
            command('login', '--token', token)
            for module in sys.argv[1:] or ['coord', 'message-board']:
                assert module in ['coord', 'message-board']
                db = 'cleanup-' + module
                command('publish', '--module-path', module, '--server', origin, '--no-config', '--delete-data=never', '--yes', db)
                call(db, 'bootstrap_board_operator')
                call(db, 'register', 'tester', 'codex', 'isolated cleanup acceptance')
                for id, dependency in [('done', ''), ('blocked', ''), ('cancelled', ''), ('open', 'done'), ('wait', 'blocked'), ('active', ''), ('reopened', '')]:
                    call(db, 'create_task', 'tester', id, id, '', '', dependency)
                for id in ['done', 'blocked', 'active', 'reopened']:
                    call(db, 'claim_task', 'tester', id)
                call(db, 'update_task', 'tester', 'done', 'done', 'receipt evidence')
                call(db, 'update_task', 'tester', 'blocked', 'blocked', 'unmet prerequisite')
                call(db, 'update_task', 'tester', 'cancelled', 'cancelled', 'superseded')
                call(db, 'update_task', 'tester', 'reopened', 'open', 'reopened before cleanup')
                call(db, 'lock', 'tester', 'active-resource', 'active', 'preserve', 10)
                for id in ['done', 'blocked', 'open', 'active', '']:
                    call(db, 'post', 'tester', '', id, 'message ' + id)
                before = {r['id']: r for r in rows(db, 'dev_task')}
                locks = rows(db, 'file_lock')
                messages = rows(db, 'dev_message')
                call(db, 'cleanup_board', 'unknown', [], [], fails=True)
                call(db, 'cleanup_board', 'tester', ['x'] * 501, [], fails=True)
                # Intentionally include active/reopened tasks and their messages to test race protection.
                call(db, 'cleanup_board', 'tester', list(before), [r['id'] for r in messages])
                after = {r['id']: r for r in rows(db, 'dev_task')}
                assert after == {id: row for id, row in before.items() if id in ['open', 'wait', 'active', 'reopened']}
                archive = {r['id']: r for r in rows(db, 'archived_task')}
                assert archive == {id: before[id] for id in ['done', 'blocked', 'cancelled']}
                assert rows(db, 'file_lock') == locks
                assert {r['task_id'] for r in rows(db, 'dev_message')} == {'open', 'active'}
                call(db, 'claim_task', 'tester', 'open')
                call(db, 'claim_task', 'tester', 'wait', fails=True)
                call(db, 'create_task', 'tester', 'later', 'later', '', '', 'done')
                call(db, 'claim_task', 'tester', 'later')
                call(db, 'create_task', 'tester', 'done', 'reuse', '', '', '', fails=True)
                call(db, 'cleanup_board', 'tester', list(before), [r['id'] for r in messages])
                assert len(rows(db, 'archived_task')) == 3
                command('publish', '--module-path', module, '--server', origin, '--no-config', '--delete-data=never', '--yes', db)
                assert len(rows(db, 'archived_task')) == 3
                call(db, 'post', 'tester', '', 'blocked', 'recovery handoff still accepted')
                call(db, 'update_task', 'tester', 'blocked', 'open', 'operator explicitly reopens')
                assert any(r['id'] == 'blocked' for r in rows(db, 'dev_task'))
                assert len(rows(db, 'archived_task')) == 2
                print(f'PASS {module}: exact archive, active/reopened protection, message protection, lock preservation, dependency outcomes, ID reuse refusal, idempotence, republish persistence')
        finally:
            server.terminate()
            try:
                server.wait(timeout=10)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait()

#!/usr/bin/env python3
"""Disposable real-engine admission failures, immutable receipts and recovery."""
import json
import os
import pathlib
import signal
import socket
import subprocess
import sys
import tempfile
import time
from bridge import encode, execute
from status import call, status

ROOT = pathlib.Path(__file__).resolve().parents[1]

with tempfile.TemporaryDirectory(prefix='factorio-rejections-') as directory:
    parent = pathlib.Path(directory)
    world = parent / 'world'
    config = json.loads((ROOT / 'config/factorio-pilot.json').read_text())
    for key, kind in [('gamePort', socket.SOCK_DGRAM), ('rconPort', socket.SOCK_STREAM)]:
        with socket.socket(socket.AF_INET, kind) as probe:
            probe.bind(('127.0.0.1', 0))
            config[key] = probe.getsockname()[1]
    config_file = parent / 'config.json'
    config_file.write_text(json.dumps(config))
    subprocess.run([sys.executable, str(ROOT / 'factorio/runtime.py'), 'init', '--world',
                    str(world), '--config', str(config_file)], check=True, stdout=subprocess.DEVNULL)
    with (parent / 'server.log').open('w') as log:
        child = None

        def start():
            global child
            child = subprocess.Popen([sys.executable, str(ROOT / 'factorio/runtime.py'),
                                      'start', '--world', str(world)], stdout=log,
                                     stderr=subprocess.STDOUT, start_new_session=True)
            deadline = time.monotonic() + 30
            while True:
                try:
                    return status(world)
                except (OSError, ValueError):
                    if child.poll() is not None or time.monotonic() > deadline:
                        raise AssertionError((parent / 'server.log').read_text())
                    time.sleep(.2)

        def stop():
            if child is not None and child.poll() is None:
                os.killpg(child.pid, signal.SIGINT)
                try:
                    child.wait(timeout=30)
                except subprocess.TimeoutExpired:
                    os.killpg(child.pid, signal.SIGKILL)
                    child.wait()
                    raise

        try:
            initial = start()
            actor = initial['actors'][0]['unit']
            chest = initial['chests'][0]
            execute(world, actor, 'approach', {'kind': 'move', 'x': chest['x'] + 1,
                                             'y': chest['y'], 'maxTicks': 600})
            observed = call(world, 'observe', [actor, 32])

            def reject(operation, command, detail):
                raw = encode(world, actor, operation, command)
                result = call(world, 'submit', [raw])
                assert result['status'] == 'failed' and detail in result['detail'], result
                assert result['startTick'] == result['endTick']
                assert result['actorId'] == actor and result['worldId'] == initial['world']['worldId']
                assert result['historyId'] == initial['world']['historyId']
                assert result['digest'] == json.loads(raw)['digest']
                assert call(world, 'submit', [raw]) == result, 'failed replay changed'
                assert call(world, 'receipt', [operation]) == result
                return result

            radius = reject('outside-radius', {'kind': 'move', 'x': observed['x'] + 100,
                            'y': observed['y'], 'maxTicks': 10}, 'outside local radius')
            reject('empty-source', {'kind': 'take', 'targetId': chest['unit'],
                   'item': 'iron-plate', 'quantity': 1}, 'Insufficient source')
            reject('empty-actor', {'kind': 'put', 'targetId': chest['unit'],
                   'item': 'coal', 'quantity': 1}, 'Insufficient source')
            reject('missing-target', {'kind': 'take', 'targetId': 2147483647,
                   'item': 'coal', 'quantity': 1}, 'Invalid transfer target')
            call(world, 'control', [True])
            reject('paused-admission', {'kind': 'take', 'targetId': chest['unit'],
                   'item': 'coal', 'quantity': 1}, 'World paused')
            call(world, 'control', [False])
            assert status(world)['chests'][0]['ironOre'] == 50
            assert status(world)['chests'][0]['coal'] == 20
            assert call(world, 'observe', [actor, 32])['inventory']['coal'] == 0
            furnace = next(e for e in observed['nearby'] if e['type'] == 'furnace')
            execute(world, actor, 'approach-empty-furnace', {'kind': 'move',
                    'x': furnace['x'] + 2, 'y': furnace['y'], 'maxTicks': 600})
            reject('empty-furnace', {'kind': 'take', 'targetId': furnace['unit'],
                   'item': 'iron-plate', 'quantity': 1}, 'Insufficient source')
            execute(world, actor, 'back-from-furnace', {'kind': 'move',
                    'x': chest['x'] + 1, 'y': chest['y'], 'maxTicks': 600})

            # A rejected second operation must not clear the first actor's busy slot.
            pending_raw = encode(world, actor, 'pending-move', {'kind': 'move',
                                 'x': observed['x'] + 20, 'y': observed['y'], 'maxTicks': 600})
            assert call(world, 'submit', [pending_raw])['status'] == 'pending'
            reject('busy-one', {'kind': 'move', 'x': observed['x'],
                   'y': observed['y'], 'maxTicks': 10}, 'pending operation')
            reject('busy-two', {'kind': 'move', 'x': observed['x'],
                   'y': observed['y'], 'maxTicks': 10}, 'pending operation')
            deadline = time.monotonic() + 15
            while call(world, 'receipt', ['pending-move'])['status'] == 'pending':
                assert time.monotonic() < deadline
                time.sleep(.1)
            execute(world, actor, 'return-chest', {'kind': 'move', 'x': chest['x'] + 1,
                                                'y': chest['y'], 'maxTicks': 600})
            receipt = execute(world, actor, 'valid-after-rejection', {'kind': 'take',
                              'targetId': chest['unit'], 'item': 'coal', 'quantity': 1})
            assert receipt['quantity'] == 1
            assert status(world)['chests'][0]['coal'] == 19

            # Foreign/malformed envelopes are never admitted as replayable operations.
            foreign = json.loads(encode(world, actor, 'foreign', {'kind': 'move',
                                 'x': chest['x'], 'y': chest['y'], 'maxTicks': 10}))
            foreign['historyId'] = 'another-history'
            try:
                call(world, 'submit', [json.dumps(foreign)])
                raise AssertionError('foreign history admitted')
            except ValueError:
                pass
            assert call(world, 'receipt', ['foreign']) is None
            changed = encode(world, actor, 'outside-radius', {'kind': 'move',
                             'x': chest['x'], 'y': chest['y'], 'maxTicks': 10})
            try:
                call(world, 'submit', [changed])
                raise AssertionError('changed replay admitted')
            except ValueError:
                pass
            stop()
            assert child.returncode == 0
            start()
            assert call(world, 'receipt', ['outside-radius']) == radius
            assert call(world, 'submit', [radius['request']]) == radius
            assert call(world, 'observe', [actor, 32])['inventory']['coal'] == 1
            print('PASS: durable admission rejections, replay/restart, source conservation, '
                  'busy-operation isolation, foreign scope refusal and subsequent valid action')
        finally:
            stop()

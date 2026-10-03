#!/usr/bin/env python3
"""Read-only Factorio character census via local RCON; never proves victory."""
import argparse
import json
import os
import secrets
import socket
import struct
import time


def packet(request_id, kind, text):
    body = struct.pack('<ii', request_id, kind) + text.encode('utf-8') + b'\0\0'
    return struct.pack('<i', len(body)) + body


def receive(sock):
    def exact(size):
        result = b''
        while len(result) < size:
            chunk = sock.recv(size - len(result))
            if not chunk:
                raise RuntimeError('RCON disconnected before the reply was complete')
            result += chunk
        return result
    size, = struct.unpack('<i', exact(4))
    if size < 10 or size > 4 * 1024 * 1024:
        raise RuntimeError('Invalid RCON frame size')
    body = exact(size)
    if body[-2:] != b'\0\0':
        raise RuntimeError('Invalid RCON frame terminator')
    request_id, kind = struct.unpack('<ii', body[:8])
    return request_id, kind, body[8:-2]


def query(host, port, password, command):
    """Use a second ordered command as delimiter, including split command replies."""
    marker = 'swarm_probe_' + secrets.token_hex(12)
    deadline = time.monotonic() + 15
    with socket.create_connection((host, port), timeout=5) as sock:
        def next_frame():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError('RCON response deadline exceeded')
            sock.settimeout(remaining)
            return receive(sock)
        sock.sendall(packet(1, 3, password))
        while True:
            request_id, kind, _ = next_frame()
            if request_id == -1:
                raise RuntimeError('RCON authentication refused')
            if request_id == 1 and kind == 2:
                break
        sock.sendall(packet(2, 2, command))
        sock.sendall(packet(3, 2, '/silent-command rcon.print("' + marker + '")'))
        output = bytearray()
        sentinel = bytearray()
        while True:
            request_id, kind, body = next_frame()
            if kind != 0:
                raise RuntimeError('Unexpected RCON response type')
            if request_id == 2:
                output.extend(body)
            elif request_id == 3:
                sentinel.extend(body)
                if marker.encode() in sentinel:
                    return output.decode('utf-8')
            if len(output) + len(sentinel) > 4 * 1024 * 1024:
                raise RuntimeError('RCON response exceeds limit')


# Pure observation: no create_entity, teleport, inventory insertion or world writes.
CENSUS = '''/silent-command local rows = {}; for _, surface in pairs(game.surfaces) do for _, e in pairs(surface.find_entities_filtered{type="character"}) do local w=e.walking_state; rows[#rows+1]={unit=e.unit_number, surface=surface.name, name=e.name, position=e.position, health=e.health, color=e.color, walking=w.walking, direction=w.direction} end end; rcon.print(helpers.table_to_json({tick=game.tick, characters=rows}))'''


def census(host, port, password):
    data = json.loads(query(host, port, password, CENSUS).strip())
    if not isinstance(data.get('characters'), list):
        # Lua encodes an empty table as an object.
        if data.get('characters') == {}:
            data['characters'] = []
        else:
            raise RuntimeError('Unexpected character census response')
    return data


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--port', type=int, required=True)
    parser.add_argument('--expected', type=int, default=10)
    parser.add_argument('--interval', type=float, default=2)
    args = parser.parse_args()
    password = os.environ.get('FACTORIO_RCON_PASSWORD')
    if not password:
        parser.error('Set FACTORIO_RCON_PASSWORD; never put the password in a command argument or report')
    if args.expected < 1 or not 0 <= args.interval <= 60:
        parser.error('--expected must be positive; --interval must be between 0 and 60 seconds')
    before = census(args.host, args.port, password)
    time.sleep(args.interval)
    after = census(args.host, args.port, password)
    old = {c['unit']: c for c in before['characters']}
    moved = [c['unit'] for c in after['characters'] if c['unit'] in old and c['position'] != old[c['unit']]['position']]
    print(json.dumps({'before': before, 'after': after, 'moved_units': moved,
                      'note': 'Character count is engine evidence only. This does not prove worker identity, coordination, graphical rendering, or victory.'}, indent=2))
    if len(after['characters']) < args.expected:
        raise SystemExit(f'Expected at least {args.expected} visible character entities; found {len(after["characters"])}')


if __name__ == '__main__':
    main()

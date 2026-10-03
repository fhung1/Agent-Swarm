import importlib.util
from pathlib import Path
import socket
import struct
import threading
import unittest

spec = importlib.util.spec_from_file_location('probe', Path(__file__).with_name('inspect-world.py'))
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class ProtocolChecks(unittest.TestCase):
    def test_fragmented_frames_and_unicode(self):
        a, b = socket.socketpair()
        try:
            body = probe.packet(10, 0, 'visible 工人')
            def send():
                for byte in body:
                    b.sendall(bytes([byte]))
            thread = threading.Thread(target=send); thread.start()
            request, kind, text = probe.receive(a)
            thread.join()
            self.assertEqual((request, kind, text.decode()), (10, 0, 'visible 工人'))
        finally:
            a.close(); b.close()

    def test_invalid_sizes_and_truncated_frames(self):
        for payload in [struct.pack('<i', 3), struct.pack('<i', 5000000), probe.packet(1, 0, 'x')[:-1]]:
            a, b = socket.socketpair()
            try:
                b.sendall(payload); b.close()
                with self.assertRaises(RuntimeError): probe.receive(a)
            finally: a.close(); b.close()

    def test_auth_and_multipart_query(self):
        server = socket.socket(); server.bind(('127.0.0.1', 0)); server.listen(1)
        failures = []
        def respond():
            try:
                conn, _ = server.accept()
                with conn:
                    self.assertEqual(probe.receive(conn), (1, 3, b'test-password'))
                    conn.sendall(probe.packet(1, 0, '') + probe.packet(1, 2, ''))
                    self.assertEqual(probe.receive(conn), (2, 2, b'inspect'))
                    request, _, text = probe.receive(conn)
                    marker = text.decode().split('"')[1]
                    conn.sendall(probe.packet(2, 0, 'first') + probe.packet(2, 0, 'second') + probe.packet(request, 0, marker + '\n'))
            except Exception as error: failures.append(error)
        thread = threading.Thread(target=respond); thread.start()
        try:
            self.assertEqual(probe.query('127.0.0.1', server.getsockname()[1], 'test-password', 'inspect'), 'firstsecond')
            thread.join(timeout=5)
            self.assertFalse(thread.is_alive())
            self.assertEqual(failures, [])
        finally: server.close()


if __name__ == '__main__': unittest.main()

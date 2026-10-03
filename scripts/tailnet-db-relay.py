#!/usr/bin/env python3
"""Expose loopback SpacetimeDB through a dedicated private tailnet TCP port."""
import argparse,ipaddress,socket,socketserver,threading
TARGET=('127.0.0.1',3000)
slots=threading.BoundedSemaphore(128)
class Relay(socketserver.BaseRequestHandler):
    def handle(self):
        if not slots.acquire(blocking=False):return
        upstream=None
        try:
            upstream=socket.create_connection(TARGET,timeout=10)
            upstream.settimeout(120);self.request.settimeout(120)
            def pump(source,destination):
                try:
                    while True:
                        data=source.recv(65536)
                        if not data:break
                        destination.sendall(data)
                except OSError:pass
                finally:
                    try:destination.shutdown(socket.SHUT_WR)
                    except OSError:pass
            thread=threading.Thread(target=pump,args=(self.request,upstream),daemon=True)
            thread.start();pump(upstream,self.request);thread.join(timeout=125)
        except OSError:pass
        finally:
            if upstream:upstream.close()
            slots.release()
class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address=True
    daemon_threads=True
if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bind',required=True,help='Specific Tailscale IPv4 address')
    parser.add_argument('--port',type=int,default=3001)
    args=parser.parse_args();address=ipaddress.ip_address(args.bind)
    if address.version!=4 or address not in ipaddress.ip_network('100.64.0.0/10'):parser.error('bind must be a specific Tailscale IPv4 address')
    if not 1024<=args.port<=65535 or args.port==3000:parser.error('use a dedicated port from1024 through65535, excluding3000')
    with Server((str(address),args.port),Relay) as server:
        print(f'Tailnet DB relay {address}:{args.port} → 127.0.0.1:3000 (TCP/WebSocket)',flush=True)
        try:server.serve_forever()
        except KeyboardInterrupt:pass

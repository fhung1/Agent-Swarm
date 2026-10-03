#!/usr/bin/env python3
"""Read bridge status through private RCON; never accepts arbitrary RCON text."""
import argparse,json,pathlib,socket,struct,time

def read_exact(sock,n):
    data=b''
    while len(data)<n:
        chunk=sock.recv(n-len(data))
        if not chunk: raise ValueError('RCON closed before response')
        data+=chunk
    return data

def packet(sock):
    size=struct.unpack('<i',read_exact(sock,4))[0]
    if not 10<=size<=1048576: raise ValueError('Invalid RCON packet length')
    data=read_exact(sock,size)
    return (*struct.unpack('<ii',data[:8]),data[8:-2].decode())

def send(sock,ident,kind,body):
    data=struct.pack('<ii',ident,kind)+body.encode()+b'\0\0'
    sock.sendall(struct.pack('<i',len(data))+data)

def call_once(world,method,args=()):
    if method not in ['status','observe','submit','receipt','control']: raise ValueError('Unsupported bridge method')
    manifest=json.loads((world/'manifest.json').read_text())
    with socket.create_connection(('127.0.0.1',manifest['rconPort']),timeout=5) as s:
        s.settimeout(5);send(s,1,3,(world/'rcon.password').read_text().strip())
        while True:
            ident,kind,body=packet(s)
            if ident==-1: raise ValueError('RCON authentication refused')
            if kind==2 and ident==1: break
        encoded=','.join(json.dumps(arg,ensure_ascii=True,separators=(',',':')) for arg in args)
        suffix=','+encoded if encoded else ''
        command='/silent-command local ok,result=pcall(remote.call,"agent_swarm",'+json.dumps(method)+suffix+'); rcon.print(helpers.table_to_json({ok=ok,result=result}))'
        send(s,2,2,command)
        send(s,3,2,'/silent-command rcon.print("qs-response-end")')
        output=[];ended=False
        while True:
            ident,kind,body=packet(s)
            if ident==3: ended=True
            if ident==2: output.append(body)
            if ended and output: break
        if not output or not ''.join(output).strip(): raise ValueError('Empty RCON response')
        response=json.loads(''.join(output))
        if not response['ok']: raise ValueError(str(response['result']))
        return response.get('result')

def call(world,method,args=()):
    # Repeating the exact submit payload is safe because the bridge records its
    # operation ID before mutation and returns the same game receipt.
    for attempt in range(4):
        try: return call_once(world,method,args)
        except (json.JSONDecodeError, socket.timeout, OSError) as e:
            if attempt==3: raise
            time.sleep(.15*(attempt+1))
        except ValueError as e:
            if 'Empty RCON response' not in str(e) or attempt==3: raise
            time.sleep(.15*(attempt+1))

def status(world): return call(world,'status')

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--world',required=True)
    args=p.parse_args()
    print(json.dumps(status(pathlib.Path(args.world).resolve()),indent=2))

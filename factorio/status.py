#!/usr/bin/env python3
"""Read bridge status or set pause through private RCON; never accepts arbitrary RCON text."""
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
    if method not in ['status','observe','submit','receipt','control','set_task_label','inspect']: raise ValueError('Unsupported bridge method')
    if method=='inspect':
        if len(args)!=1 or type(args[0]) is not dict: raise ValueError('Invalid inspection arguments')
        args=[json.dumps(args[0],ensure_ascii=True,separators=(',',':'))]
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
def control(world,paused):
    if type(paused) is not bool: raise ValueError('Expected a boolean pause state')
    return call(world,'control',[paused])

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--world',required=True)
    action=p.add_mutually_exclusive_group();action.add_argument('--pause',dest='paused',action='store_true');action.add_argument('--resume',dest='paused',action='store_false')
    p.set_defaults(paused=None)
    args=p.parse_args()
    world=pathlib.Path(args.world).resolve()
    result=status(world) if args.paused is None else control(world,args.paused)
    print(json.dumps(result,indent=2))

"""Bounded bridge operations. No arbitrary Lua or RCON input."""
import hashlib,json,re,time
from status import call

def encode(world,actor,operation,command):
    manifest=json.loads((world/'manifest.json').read_text())
    if not isinstance(operation,str) or not re.fullmatch(r'[A-Za-z0-9_.:-]{1,96}',operation): raise ValueError('Invalid operation ID')
    if type(actor) is not int or not 1<=actor<=2147483647: raise ValueError('Invalid actor ID')
    kind=command.get('kind')
    if kind=='move':
        if set(command)!={'kind','x','y','maxTicks'}: raise ValueError('Unexpected move fields')
        if type(command['maxTicks']) is not int or not 1<=command['maxTicks']<=600: raise ValueError('Invalid movement duration')
        for key in ['x','y']:
            if type(command[key]) not in [int,float] or not -1000000<=command[key]<=1000000: raise ValueError('Invalid position')
    elif kind in ['take','put']:
        if set(command)!={'kind','targetId','item','quantity'}: raise ValueError('Unexpected transfer fields')
        if type(command['targetId']) is not int or not 1<=command['targetId']<=2147483647: raise ValueError('Invalid target')
        if type(command['quantity']) is not int or not 1<=command['quantity']<=20: raise ValueError('Invalid quantity')
        if command['item'] not in ['iron-ore','coal','iron-plate']: raise ValueError('Invalid item')
    else: raise ValueError('Unsupported command')
    req={'version':1,'worldId':manifest['worldId'],'historyId':manifest['historyId'],'actorId':actor,'operationId':operation,'command':command}
    canonical=lambda obj:json.dumps(obj,sort_keys=True,separators=(',',':'),allow_nan=False)
    req['digest']=hashlib.sha256(canonical(req).encode()).hexdigest()
    return canonical(req)

def execute(world,actor,operation,command):
    raw=encode(world,actor,operation,command)
    result=call(world,'submit',[raw])
    deadline=time.monotonic()+15
    while result['status']=='pending':
        if time.monotonic()>deadline: raise ValueError('Unknown outcome: reconcile receipt before retrying')
        time.sleep(.1);result=call(world,'receipt',[operation])
    if result['status']!='completed': raise ValueError(result.get('detail','Action failed'))
    return result

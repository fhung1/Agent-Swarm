"""Bounded bridge operations. No arbitrary Lua or RCON input."""
import hashlib,json,math,re,time
from decimal import Decimal, InvalidOperation
from status import call

COORDINATE_SCALE=100_000_000
COORDINATE_DECIMALS=8

def normalized_coordinate(value):
    if type(value) not in [int,float] or not math.isfinite(value) or not -1_000_000<=value<=1_000_000: raise ValueError('Invalid position')
    try: scaled=Decimal(str(value))*COORDINATE_SCALE
    except InvalidOperation: raise ValueError('Invalid position')
    if scaled != scaled.to_integral_value(): raise ValueError('Position must use the eight-decimal wire grid')
    return int(scaled)

def coordinate_json(scaled):
    sign='-' if scaled<0 else '';whole,fraction=divmod(abs(scaled),COORDINATE_SCALE)
    if not fraction: return sign+str(whole)
    return sign+str(whole)+'.'+str(fraction).rjust(COORDINATE_DECIMALS,'0').rstrip('0')

def canonical(value):
    if value is None: return 'null'
    if value is True: return 'true'
    if value is False: return 'false'
    if type(value) is int: return str(value)
    if type(value) is float: return coordinate_json(normalized_coordinate(value))
    if type(value) is str: return json.dumps(value,ensure_ascii=False,separators=(',',':'))
    if type(value) is list: return '['+','.join(canonical(item) for item in value)+']'
    if type(value) is dict: return '{'+','.join(json.dumps(key,ensure_ascii=False)+':'+canonical(value[key]) for key in sorted(value))+'}'
    raise ValueError('Unsupported wire value')

def encode(world,actor,operation,command):
    manifest=json.loads((world/'manifest.json').read_text())
    if not isinstance(operation,str) or not re.fullmatch(r'[A-Za-z0-9_.:-]{1,96}',operation): raise ValueError('Invalid operation ID')
    if type(actor) is not int or not 1<=actor<=2147483647: raise ValueError('Invalid actor ID')
    if type(command) is not dict: raise ValueError('Expected command object')
    command=dict(command)
    kind=command.get('kind')
    if kind=='move':
        if set(command)!={'kind','x','y','maxTicks'}: raise ValueError('Unexpected move fields')
        if type(command['maxTicks']) is not int or not 1<=command['maxTicks']<=600: raise ValueError('Invalid movement duration')
        for key in ['x','y']:
            command[key]=normalized_coordinate(command[key])/COORDINATE_SCALE
    elif kind in ['take','put']:
        if set(command)!={'kind','targetId','item','quantity'}: raise ValueError('Unexpected transfer fields')
        if type(command['targetId']) is not int or not 1<=command['targetId']<=2147483647: raise ValueError('Invalid target')
        if type(command['quantity']) is not int or not 1<=command['quantity']<=100: raise ValueError('Invalid quantity')
        if type(command['item']) is not str or not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,63}',command['item']): raise ValueError('Invalid item')
    elif kind=='mine':
        if set(command)!={'kind','name','x','y','quantity'}: raise ValueError('Unexpected mine fields')
        if type(command['name']) is not str or not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,63}',command['name']): raise ValueError('Invalid entity name')
        if type(command['quantity']) is not int or not 1<=command['quantity']<=20: raise ValueError('Invalid quantity')
        for key in ['x','y']:
            if type(command[key]) not in [int,float] or not -1000000<=command[key]<=1000000: raise ValueError('Invalid position')
    elif kind=='craft':
        if set(command)!={'kind','recipe','quantity'}: raise ValueError('Unexpected craft fields')
        if type(command['recipe']) is not str or not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,63}',command['recipe']): raise ValueError('Invalid recipe')
        if type(command['quantity']) is not int or not 1<=command['quantity']<=20: raise ValueError('Invalid quantity')
    elif kind=='research':
        if set(command)!={'kind','technology'} or type(command['technology']) is not str or not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,63}',command['technology']): raise ValueError('Invalid research command')
    elif kind=='set_recipe':
        if set(command)!={'kind','targetId','recipe'} or type(command['targetId']) is not int or not 1<=command['targetId']<=2147483647 or type(command['recipe']) is not str or not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,63}',command['recipe']): raise ValueError('Invalid recipe command')
    elif kind=='recover':
        if set(command)!={'kind','targetId'} or type(command['targetId']) is not int or not 1<=command['targetId']<=2147483647: raise ValueError('Invalid recover target')
    elif kind in ['place','build']:
        if set(command)!=({'kind','item','x','y','direction'} if kind=='build' else {'kind','item','x','y'}): raise ValueError('Unexpected place fields')
        if kind=='build' and (type(command['direction']) is not int or command['direction'] not in [0,4,8,12]): raise ValueError('Invalid cardinal direction')
        if type(command['item']) is not str or not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,63}',command['item']): raise ValueError('Invalid item')
        for key in ['x','y']:
            if type(command[key]) not in [int,float] or not -1000000<=command[key]<=1000000: raise ValueError('Invalid position')
    else: raise ValueError('Unsupported command')
    req={'version':1,'worldId':manifest['worldId'],'historyId':manifest['historyId'],'actorId':actor,'operationId':operation,'command':command}
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

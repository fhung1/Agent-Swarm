#!/usr/bin/env python3
"""Fixed JSON command bridge for a local rules worker."""
import json, pathlib, sys
from bridge import execute
from status import call

world=pathlib.Path(sys.argv[1]).resolve()
request=json.loads(sys.stdin.read())
kind=request['kind']
if kind=='execute':
    result=execute(world,request['actor'],request['operation'],request['command'])
elif kind in ('observe','receipt','status'):
    args=[] if kind=='status' else ([request['actor'],32] if kind=='observe' else [request['operation']])
    result=call(world,kind,args)
else:
    raise ValueError('Unsupported bridge request')
print(json.dumps(result,separators=(',',':')))

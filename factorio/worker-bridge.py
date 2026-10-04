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
elif kind=='task_label':
    if set(request)!={'kind','actor','label'} or type(request['actor']) is not int or not 1<=request['actor']<=2147483647 or type(request['label']) is not str or not 1<=len(request['label'])<=80 or any(ord(c)<32 or ord(c)==127 for c in request['label']):
        raise ValueError('Invalid task label request')
    result=call(world,'set_task_label',[request['actor'],request['label']])
else:
    raise ValueError('Unsupported bridge request')
print(json.dumps(result,separators=(',',':')))

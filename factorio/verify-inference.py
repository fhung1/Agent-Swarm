#!/usr/bin/env python3
"""Read-only acceptance verifier for a completed inference launcher run."""
import argparse,json,pathlib,subprocess,sys
from status import status

def snapshot(cli,database):
    result=subprocess.run([cli,'subscribe','--server','local',database,'SELECT * FROM dev_task','SELECT * FROM dev_message','--print-initial-update','-n','0','--yes'],capture_output=True,text=True,timeout=20,check=True)
    line=next((line for line in result.stdout.splitlines() if line.startswith('{')),None)
    if not line: raise ValueError('Missing board snapshot')
    return {key:value['inserts'] for key,value in json.loads(line).items()}

def verify(directory,cli):
    plan=json.loads((directory/'plan.json').read_text())
    world=directory.parents[1]; manifest=json.loads((world/'manifest.json').read_text())
    if len(plan.get('workers',[]))!=10 or len({w['actorId'] for w in plan['workers']})!=10: raise ValueError('Plan lacks ten distinct actors')
    board=snapshot(cli,plan.get('database','quant-swarm-factorio-coord'))
    tasks={row['id']:row for row in board.get('dev_task',[])}
    events=[]
    for row in board.get('dev_message',[]):
        try: body=json.loads(row['body'])
        except (TypeError,ValueError): continue
        if body.get('runId')==plan['runId'] and body.get('worldId')==manifest['worldId'] and body.get('historyId')==manifest['historyId']:
            if body.get('sender')!=row['sender']: raise ValueError('Spoofed event sender')
            events.append(body)
    for worker in plan['workers']:
        task=tasks.get(worker['taskId'])
        if not task or task['status']!='done' or task['assignee']!=worker['sender']: raise ValueError('Worker task is incomplete or foreign')
        kinds=[event.get('kind') for event in events if event.get('sender')==worker['sender']]
        if 'inference_audit' not in kinds or 'completion' not in kinds: raise ValueError('Worker lacks audit or completion evidence')
    game=status(world)
    if game['world']!={'worldId':manifest['worldId'],'historyId':manifest['historyId']}: raise ValueError('Engine scope mismatch')
    return {'passed':True,'runId':plan['runId'],'workers':10,'audits':sum(e.get('kind')=='inference_audit' for e in events),'completions':sum(e.get('kind')=='completion' for e in events)}

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--directory',required=True);p.add_argument('--cli',required=True);p.add_argument('--output',required=True);a=p.parse_args()
    try:
        report=verify(pathlib.Path(a.directory).resolve(),a.cli);out=pathlib.Path(a.output);out.mkdir();(out/'verification.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report))
    except (OSError,ValueError,subprocess.SubprocessError,KeyError) as error: print('Verification failed:',error,file=sys.stderr);sys.exit(1)

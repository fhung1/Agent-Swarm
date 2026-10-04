#!/usr/bin/env python3
"""Read-only independent acceptance of a running ten-character production fixture."""
import argparse,datetime,hashlib,json,pathlib,re,shutil,subprocess,sys,zipfile
from status import call,status

def require(condition,message):
    if not condition:raise ValueError(message)

def snapshot(cli,database):
    result=subprocess.run([cli,'subscribe','--server','local',database,'SELECT * FROM dev_task','SELECT * FROM session','SELECT * FROM dev_message','--print-initial-update','-n','0','--yes'],capture_output=True,text=True,timeout=20,check=True)
    line=next((line for line in result.stdout.splitlines() if line.startswith('{')),None)
    require(line is not None,'Missing board snapshot')
    return {key:value['inserts'] for key,value in json.loads(line).items()}

def verify(directory,cli):
    config=json.loads((directory/'demo.json').read_text());world=pathlib.Path(config['world']).resolve()
    manifest=json.loads((world/'manifest.json').read_text())
    run=config['runId'];require(re.fullmatch(r'[A-Za-z0-9_.:-]{1,96}',run),'Invalid run ID')
    require(config['database'] not in ['quant-swarm','quant-swarm-coord'],'Gameplay database must be isolated')
    require(manifest['scenario']=='cooperative-starter','Only declared starter fixture accepted')
    board=snapshot(cli,config['database']);game=status(world)
    require(game['world']['worldId']==manifest['worldId'] and game['world']['historyId']==manifest['historyId'],'Engine/manifest scope mismatch')
    tasks=[t for t in board.get('dev_task',[]) if t['area']==run and t['title'].startswith('Produce five')]
    require(len(tasks)==10 and all(t['status']=='done' for t in tasks),'Expected ten completed production tasks')
    actors={a['unit']:a for a in game['actors']}
    require(len(actors)==10 and set(actors)==set(config['actors']),'Engine avatars differ from launcher')
    require(all(a['inventory']['ironPlate']==5 and a['inventory']['ironOre']==0 for a in actors.values()),'Engine output differs from five plates per actor')
    require(sum(c['ironOre'] for c in game['chests'])==0 and sum(c['coal'] for c in game['chests'])==10,'Fixture source depletion must match fifty ore and ten coal transfers')
    worker_indices=[]
    for command_line in pathlib.Path('/proc').glob('[0-9]*/cmdline'):
        try:arguments=command_line.read_bytes().decode().split('\0')
        except (OSError,UnicodeError):continue
        if any(arg.endswith('/demo-worker.js') for arg in arguments) and str(directory/'demo.json') in arguments:
            nonempty=[arg for arg in arguments if arg]
            try:worker_indices.append(int(nonempty[-1]))
            except ValueError:pass
    require(len(worker_indices)==10 and set(worker_indices)==set(range(10)),'Expected ten live distinct worker processes')
    names={f'{run}-agent-{i}' for i in range(1,11)}
    participants={p['name'] for p in board.get('session',[]) if p['name'] in names}
    require(participants==names and {t['assignee'] for t in tasks}==names,'Ten distinct participants and task owners required')
    results={t['assignee']:json.loads(t['result']) for t in tasks}
    require({r['actorId'] for r in results.values()}==set(actors),'Task results must map to ten unique avatars')
    envelopes=[]
    for row in board.get('dev_message',[]):
        try:body=json.loads(row['body'])
        except (ValueError,TypeError):continue
        if body.get('runId')==run:
            require(body.get('worldId')==manifest['worldId'] and body.get('historyId')==manifest['historyId'],'Cross-world message')
            require(body.get('sender')==row['sender'],'Envelope sender mismatch')
            envelopes.append((row,body))
    claims=[body for _,body in envelopes if body.get('kind')=='claim']
    identities={body.get('identity') for body in claims}
    require(len(claims)==10 and len(identities)==10 and all(isinstance(identity,str) and re.fullmatch('[a-f0-9]{64}',identity) for identity in identities),'Expected ten distinct recorded connection identities')
    development=snapshot(cli,'quant-swarm-coord')
    task_ids={task['id'] for task in tasks}
    require(not any(task['id'] in task_ids for task in development.get('dev_task',[])),'Gameplay tasks leaked to development')
    require(not any(message['task_id'] in task_ids for message in development.get('dev_message',[])),'Gameplay messages leaked to development')
    engine_receipts=[]
    for i in range(1,11):
        name=f'{run}-agent-{i}';result=results[name];actor=config['actors'][i-1]
        require(result['actorId']==actor and result['plates']==5 and result['worldId']==manifest['worldId'],'Task result scope mismatch')
        for step,item,quantity in [('ore','iron-ore',5),('coal','coal',1),('ore-insert','iron-ore',5),('coal-insert','coal',1),('plates-collect','iron-plate',5)]:
            operation=f'{run}.a{i}.{step}';receipt=call(world,'receipt',[operation])
            require(receipt and receipt['status']=='completed','Missing successful engine receipt '+operation)
            require(receipt['actorId']==actor and receipt['worldId']==manifest['worldId'] and receipt['historyId']==manifest['historyId'],'Engine receipt scope mismatch')
            require(receipt['item']==item and receipt['quantity']==quantity,'Resource quantity mismatch')
            matching=[body for row,body in envelopes if body.get('kind')=='action_result' and row['sender']==name and body.get('payload',{}).get('operationId')==operation]
            require(len(matching)==1,'Missing/duplicate recorded action '+operation)
            require(matching[0]['payload']['status']=='completed','Action record does not match engine')
            engine_receipts.append({'operationId':operation,'actorId':actor,'item':item,'quantity':quantity,'tick':receipt['endTick'],'digest':receipt['digest']})
    require(any(body.get('kind')=='resource_request' for _,body in envelopes),'No shared-furnace contention recorded')
    return {'runId':run,'worldId':manifest['worldId'],'historyId':manifest['historyId'],'verifiedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'database':config['database'],'tasks':10,'participants':10,'liveWorkerProcesses':10,'recordedConnectionIdentities':10,'developmentIsolation':'passed','actors':10,'actualIronPlates':50,'resourceReceipts':engine_receipts,'messages':len(envelopes),'graphicalJoin':'pending; this is engine/database verification','trustBoundary':'Private pilot; participant names are self-declared'}

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--directory',required=True);p.add_argument('--cli',default=shutil.which('spacetime') or str(pathlib.Path.home()/'.local/bin/spacetime'));p.add_argument('--output',required=True)
    args=p.parse_args()
    try:
        report=verify(pathlib.Path(args.directory).resolve(),args.cli)
        output=pathlib.Path(args.output).resolve();output.mkdir(parents=True,exist_ok=False)
        (output/'verification.json').write_text(json.dumps(report,indent=2)+'\n')
        world=pathlib.Path(json.loads((pathlib.Path(args.directory)/'demo.json').read_text())['world'])
        mod=world/'mods/agent-swarm_0.1.1'
        with zipfile.ZipFile(output/'agent-swarm_0.1.1.zip','w',zipfile.ZIP_DEFLATED) as archive:
            for path in sorted(mod.rglob('*')):
                if path.is_file():archive.write(path,path.relative_to(mod.parent))
        (output/'SHA256SUMS').write_text(hashlib.sha256((output/'agent-swarm_0.1.1.zip').read_bytes()).hexdigest()+'  agent-swarm_0.1.1.zip\n')
        print(f"PASS: {report['participants']} participants, {report['tasks']} tasks, {report['actualIronPlates']} engine plates, {len(report['resourceReceipts'])} matched engine/board resource receipts")
        print('Viewer mod and verification report:',output)
    except (ValueError,OSError,subprocess.SubprocessError,KeyError) as error:print('Verification failed:',error,file=sys.stderr);sys.exit(1)

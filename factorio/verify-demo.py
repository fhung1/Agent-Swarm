#!/usr/bin/env python3
"""Audit the disposable live world against game receipts and board rows."""
import argparse,json,pathlib,subprocess,sys
from status import call

def rows(table):
    cli=str(pathlib.Path.home()/'.local/bin/spacetime')
    out=subprocess.check_output([cli,'subscribe','--server','factorio-local','quant-swarm-factorio-coord',f'SELECT * FROM {table}','--print-initial-update','-n','0','--yes'],text=True)
    line=next(x for x in out.splitlines() if x.startswith('{'))
    return json.loads(line).get(table,{}).get('inserts',[])

def main():
    p=argparse.ArgumentParser();p.add_argument('--world',required=True);p.add_argument('--run',default='demo-20261003');p.add_argument('--output');a=p.parse_args()
    world=pathlib.Path(a.world).resolve();s=call(world,'status');manifest=json.loads((world/'manifest.json').read_text())
    messages=rows('dev_message');tasks=rows('dev_task');participants=rows('session')
    results={}
    for i in range(1,11):
        name=f'factorio-{i:02d}';actor=i+11;inv=next((x['inventory'] for x in s['actors'] if x['unit']==actor),None)
        receipts=[];board_results=[]
        for label in ('take-ore','take-coal','put-ore','put-coal','collect-plates'):
            ident=f'{a.run}-{name}-{label}'
            receipt=call(world,'receipt',[ident]);receipts.append({'id':ident,'status':receipt and receipt['status'],'quantity':receipt and receipt.get('quantity'),'item':receipt and receipt.get('item')})
            board_results.extend(m for m in messages if f'"operationId":"{ident}"' in m['body'] and '"kind":"action_result"' in m['body'])
        task=next((t for t in tasks if t['id']==f'plate-{i:02d}'),None)
        results[name]={'actor':actor,'inventory':inv,'task':task and task['status'],'receipts':receipts,'boardActionResults':len(board_results),'tokenExists':(world/'workers'/name/'board.token').exists(),'journalExists':(world/'workers'/name/'operations.jsonl').exists()}
    passed=all(v['inventory'] and v['inventory']['ironPlate']==5 and v['task']=='done' and v['boardActionResults']==5 and v['tokenExists'] and v['journalExists'] and all(r['status']=='completed' for r in v['receipts']) for v in results.values())
    report={'passed':passed,'run':a.run,'worldId':manifest['worldId'],'tick':s['tick'],'actors':len(s['actors']),'rulesWorkers':len([x for x in participants if x['name'].startswith('factorio-')]),'plateTotal':sum(x['inventory']['ironPlate'] for x in s['actors']),'gameProductionReceipts':sum(len(v['receipts']) for v in results.values() if all(r['status']=='completed' for r in v['receipts'])),'boardActionResults':sum(v['boardActionResults'] for v in results.values()),'chest':s['chests'][0],'expectedChest':{'ironOre':0,'coal':10},'workers':results}
    report['passed']=report['passed'] and report['actors']==10 and report['rulesWorkers']==10 and report['plateTotal']==50 and report['chest']['ironOre']==0 and report['chest']['coal']==10
    content=json.dumps(report,indent=2);print(content)
    if a.output:pathlib.Path(a.output).write_text(content+'\n')
    if not report['passed']:sys.exit(1)

if __name__=='__main__':main()

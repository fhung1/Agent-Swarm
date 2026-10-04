import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkerCheckpoints } from './worker-checkpoint.ts';
const scope={runId:'run',worldId:'world',historyId:'history',actorId:10};
const input={tick:100,boardReady:true,taskStatus:'done',taskOwner:'worker',worker:'worker',ironPlates:5,productionReceiptsVerified:true};
test('completed production resumes viewing without transfer replay',()=>{
 const dir=mkdtempSync(join(tmpdir(),'factorio-checkpoint-'));const path=join(dir,'checkpoint.json');
 try{
 const checkpoints=new WorkerCheckpoints(path,scope);assert.equal(checkpoints.recoveryPhase(input),'viewing');
 checkpoints.save('viewing',12,100);
 const restarted=new WorkerCheckpoints(path,scope);assert.equal(restarted.load()?.nextView,12);assert.equal(restarted.recoveryPhase(input),'viewing');
 assert.throws(()=>restarted.save('production',12,100),/rollback/);
 assert.throws(()=>restarted.save('viewing',11,100),/rollback/);
 assert.throws(()=>restarted.recoveryPhase({...input,tick:99}),/rollback/);
 assert.throws(()=>new WorkerCheckpoints(path,{...scope,historyId:'other'}).load(),/Foreign/);
 }finally{rmSync(dir,{recursive:true,force:true})}
});
test('disconnection, lost ownership and missing evidence fail closed',()=>{
 const dir=mkdtempSync(join(tmpdir(),'factorio-checkpoint-'));
 try{
 const checkpoints=new WorkerCheckpoints(join(dir,'checkpoint.json'),scope);
 assert.throws(()=>checkpoints.recoveryPhase({...input,boardReady:false}),/outage/);
 assert.throws(()=>checkpoints.recoveryPhase({...input,taskOwner:'other'}),/ownership/);
 assert.throws(()=>checkpoints.recoveryPhase({...input,productionReceiptsVerified:false}),/quarantine/);
 assert.throws(()=>checkpoints.recoveryPhase({...input,ironPlates:0}),/quarantine/);
 assert.equal(checkpoints.recoveryPhase({...input,taskStatus:'claimed',ironPlates:0,productionReceiptsVerified:false}),'production');
 }finally{rmSync(dir,{recursive:true,force:true})}
});

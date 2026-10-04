import test from 'node:test';
import assert from 'node:assert/strict';
import {deadlineFromDuration, runExpired, remainingRunMs, selectRunDeadline} from './run-duration.ts';
import {inferenceLaunchPlan} from './inference-launch.ts';
import {restartDelay, supervise} from './worker-supervisor.ts';
import {mkdtempSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
test('zero duration has no deadline, even after a long elapsed period',()=>{
 assert.equal(deadlineFromDuration(0,1000),0);assert.equal(runExpired(0,Number.MAX_SAFE_INTEGER),false);
 assert.equal(remainingRunMs(0),Infinity);assert.equal(Math.min(120000,remainingRunMs(0)),120000);
 assert.equal(selectRunDeadline(0,0,1000000),0);
});
test('bounded runs preserve deadlines and never silently migrate to unlimited',()=>{
 assert.equal(deadlineFromDuration(1000,1000),2000);assert.equal(runExpired(2000,2000),true);
 assert.equal(selectRunDeadline(1000,1500,1000),1500);
 assert.throws(()=>selectRunDeadline(0,1500,1000),/migration/);
 assert.throws(()=>selectRunDeadline(0,1500,2000),/expired/);
 for(const value of [-1,NaN,Infinity])assert.throws(()=>deadlineFromDuration(value));
});
test('production plan supports spend-only duration and unlimited calls',()=>{
 const plan=inferenceLaunchPlan({runId:'run',actorIds:[12,13,14,15,16],provider:'codex',model:'gpt-6-astra',actorModel:'gpt-6-luna',maxCalls:0,orchestratorMaxCalls:0,runMs:0,maxRunSpendUsd:'100',mode:'production'});
 assert.equal(plan.runMs,0);assert.equal(plan.totalCallLimit,null);assert.equal(plan.maxRunSpendUsd,'100');
});
test('unlimited supervisor does not stop immediately or schedule a duration cutoff',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'factorio-unlimited-'));
 try {
  assert.equal(restartDelay({version:1,runId:'r',attempts:0,deadline:0,quarantined:false},75,Date.now()),1000);
  assert.equal(await supervise({statePath:join(dir,'state.json'),runId:'r',deadline:0,command:process.execPath,args:['-e','setTimeout(()=>process.exit(0),40)']}),0);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

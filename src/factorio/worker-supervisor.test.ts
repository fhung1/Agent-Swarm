import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { restartDelay, saveRestartState, loadRestartState, supervise, type RestartState } from './worker-supervisor.ts';
const fresh = (): RestartState => ({version:1,runId:'run-a',attempts:0,deadline:100_000,quarantined:false});
test('only explicit board outages permit bounded backoff', () => {
  assert.equal(restartDelay(fresh(),75,0),1000);
  assert.equal(restartDelay({...fresh(),attempts:6},75,0),30000);
  for (const code of [0,1,78,null]) assert.equal(restartDelay(fresh(),code,0),null);
  assert.equal(restartDelay({...fresh(),attempts:8},75,0),null);
  assert.equal(restartDelay({...fresh(),quarantined:true},75,0),null);
  assert.equal(restartDelay(fresh(),75,99_001),null);
});
test('budget and quarantine survive supervisor restarts; foreign runs refused', () => {
  const dir=mkdtempSync(join(tmpdir(),'factorio-supervisor-')); const path=join(dir,'state.json');
  try {
    saveRestartState(path,{...fresh(),attempts:8,quarantined:true});
    assert.deepEqual(loadRestartState(path,'run-a',100000),{...fresh(),attempts:8,quarantined:true});
    assert.throws(()=>loadRestartState(path,'run-b',100000),/Foreign/);
    assert.throws(()=>loadRestartState(path,'run-a',100001),/Foreign/);
  } finally {rmSync(dir,{recursive:true,force:true})}
});
test('real child unknown outcome is persisted and never restarted', async () => {
  const dir=mkdtempSync(join(tmpdir(),'factorio-supervisor-')); const path=join(dir,'state.json'); const deadline=Date.now()+5000;
  try {
    assert.equal(await supervise({statePath:path,runId:'run-a',deadline,command:process.execPath,args:['-e','process.exit(78)']}),78);
    assert.equal(loadRestartState(path,'run-a',deadline).quarantined,true);
    assert.equal(await supervise({statePath:path,runId:'run-a',deadline,command:process.execPath,args:['-e','process.exit(0)']}),78);
  } finally {rmSync(dir,{recursive:true,force:true})}
});
test('real child board outage retries once and retains its charged budget', async () => {
  const dir=mkdtempSync(join(tmpdir(),'factorio-supervisor-')); const path=join(dir,'state.json'); const marker=join(dir,'started'); const deadline=Date.now()+5000;
  try {
    const source='const fs=require("node:fs");const p=process.argv[1];if(!fs.existsSync(p)){fs.writeFileSync(p,"once");process.exit(75)}';
    assert.equal(await supervise({statePath:path,runId:'run-a',deadline,command:process.execPath,args:['-e',source,marker]}),0);
    assert.equal(loadRestartState(path,'run-a',deadline).attempts,1);
  } finally {rmSync(dir,{recursive:true,force:true})}
});

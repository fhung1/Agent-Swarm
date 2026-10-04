import test from 'node:test';
import assert from 'node:assert/strict';
import {InspectSchema, PlanWriteSchema, compactGameStatus, planBrief} from './overseer-memory.ts';
import {buildOrchestratorPrompt, validateOrchestratorDecision, type OrchestratorContext} from './orchestrator.ts';
const status = {tick: 10, paused: false, world: {worldId:'w',historyId:'h'}, actors:[{unit:12,x:1,y:2,inventory:{items:{coal:3}}}],
  productionSites:[{unit:1,name:'transport-belt',x:3,y:4,direction:4,statusName:'normal'},{unit:2,name:'burner-mining-drill',x:5,y:6,direction:0,statusName:'no_fuel',fuel:{items:{},remainingEnergy:0}}],
  resourceMap:{coverage:'all-generated-terrain',totals:{'iron-ore':50},deposits:[{resource:'iron-ore',x:1,y:2}]},automation:{verified:false},chests:[]};
test('briefing retains evidence and emits changes without resending unchanged machines',()=>{
 const first=compactGameStatus(status); assert.equal(first.briefing.changedMachines.length,2);
 const next=compactGameStatus(status,first.signatures);assert.equal(next.briefing.changedMachines.length,0);
 assert.deepEqual(next.briefing.actors[0].inventory,{coal:3});assert.deepEqual(next.briefing.automation,{verified:false});
 assert.equal('deposits' in next.briefing,false);
 const changed=structuredClone(status);changed.productionSites[1].statusName='working';
 assert.equal(compactGameStatus(changed,first.signatures).briefing.changedMachines.length,1);
 assert.equal(compactGameStatus({...status,productionSites:[]},first.signatures).briefing.removedMachineKeys.length,2);
});
test('plan index loads only current section and never invents strategy',()=>{
 assert.equal(planBrief().current,undefined);
 const plan={current:{revision:1,updatedTick:2,content:'Astra current'},layout:{revision:2,updatedTick:3,content:'private detailed layout'}};
 const summary=planBrief(plan);assert.equal(summary.current?.content,'Astra current');assert.equal(summary.sections.length,2);
 assert.ok(!JSON.stringify(summary).includes('private detailed layout'));
});
test('bounded read and write schemas reject executable or oversized requests',()=>{
 const layout=InspectSchema.parse({kind:'layout',x:0,y:0,radius:8});assert.equal(layout.kind==='layout' && layout.offset,0);
 for(const query of [{kind:'layout',x:0,y:0,radius:17},{kind:'layout',x:0,y:0,radius:8,lua:'bad'},{kind:'machine',id:0},{kind:'shell',command:'bad'}]) assert.throws(()=>InspectSchema.parse(query));
 for(const section of ['../path','constructor','prototype']) assert.throws(()=>PlanWriteSchema.parse({section,content:'x'}));
 assert.throws(()=>PlanWriteSchema.parse({section:'current',content:'x'.repeat(1701)}));
});
test('new decisions preserve the six-field contract',()=>{
 for(const [kind,message] of [['write_plan',JSON.stringify({section:'current',content:'Astra plan'})],['read_plan','current'],['inspect',JSON.stringify({kind:'machine',id:1})]]) {
  assert.equal(validateOrchestratorDecision({kind,message,recipient:'',title:'',details:'',dependsOn:''},[],[]).kind,kind);
 }
 assert.throws(()=>validateOrchestratorDecision({kind:'inspect',message:'{}',recipient:'',title:'',details:'',dependsOn:''},[],[]));
});
test('prompt bounds old messages, discloses omissions and preserves source object',()=>{
 const context:OrchestratorContext={runId:'r',worldId:'w',historyId:'h',objective:'goal',agents:[],gameStatus:status,tasks:[],remainingCalls:null,remainingMs:10000,
 messages:Array.from({length:10},(_,i)=>({id:String(i),sender:'actor',recipient:'',kind:'chat',payload:'x'.repeat(4000)}))};
 const before=JSON.stringify(context);const prompt=buildOrchestratorPrompt(context);assert.ok(prompt.length<=30000);
 const parsed=JSON.parse(prompt);assert.ok(parsed.omittedContext.messages>0);assert.equal(parsed.gameStatus.automation.verified,false);assert.equal(JSON.stringify(context),before);
});

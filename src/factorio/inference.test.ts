import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Ask } from '../agents/llm.ts';
import { buildFactorioPrompt, decideFactorio, FACTORIO_SYSTEM, InvalidFactorioDecisionError, selectPeerMessages, validateFactorioDecision, type FactorioContext } from './inference.ts';

const context: FactorioContext = { runId: 'run', worldId: 'world', historyId: 'history', actorId: 7, sender: 'agent-7',
  objective: 'Produce five plates', operatorPrompt: 'Cooperate', observation: { inventory: {}, nearby: [] }, status: { paused: false }, reservations: [], messages: [], lastResult: null };
const wait = { kind: 'wait', command: null, message: 'Waiting for peer', recipient: '', waitMs: 500 };
test('strict decisions reject unsupported commands and inconsistent fields', () => {
  assert.deepEqual(validateFactorioDecision(wait), wait);
  assert.throws(() => validateFactorioDecision({ ...wait, command: { kind: 'move', x: 0, y: 0, maxTicks: 10 } }));
  assert.throws(() => validateFactorioDecision({ ...wait, waitMs: 0 }));
  assert.throws(() => validateFactorioDecision({ ...wait, kind: 'complete', waitMs: 0, recipient: 'peer' }));
  const action = { ...wait, kind: 'action', waitMs: 0, command: { kind: 'take', targetId: 1, item: 'iron-ore', quantity: 101 } };
  assert.throws(() => validateFactorioDecision(action));
  assert.throws(() => validateFactorioDecision({ ...action, command: { kind: 'shell', command: 'ls' } }));
  assert.throws(() => validateFactorioDecision({ ...wait, message: 'x'.repeat(2001) }));
  assert.throws(() => validateFactorioDecision({ ...wait, extra: true }));
});
test('freeplay actions and scoped task decisions remain bounded', () => {
  assert.match(FACTORIO_SYSTEM, /details to at most 1000 characters/);
  for (const command of [{ kind: 'mine', name: 'tree-02-red', x: 3, y: 4, quantity: 1 },
    { kind: 'craft', recipe: 'wooden-chest', quantity: 1 }, { kind: 'place', item: 'wooden-chest', x: 3, y: 4 }]) {
    assert.equal(validateFactorioDecision({ ...wait, kind: 'action', command, waitMs: 0 }).kind, 'action');
  }
  assert.throws(() => validateFactorioDecision({ ...wait, kind: 'action', waitMs: 0, command: { kind: 'mine', name: '../ore', x: 1, y: 1, quantity: 1 } }));
  assert.equal(validateFactorioDecision({ ...wait, kind: 'subtask', waitMs: 0,
    message: JSON.stringify({ title: 'Mine trees', details: 'Supply wood to the team', dependsOn: '' }) }).kind, 'subtask');
  assert.equal(validateFactorioDecision({ ...wait, kind: 'resource_request', waitMs: 0,
    message: JSON.stringify({ item: 'wood', quantity: 2, boxId: 31 }) }).kind, 'resource_request');
  assert.throws(() => validateFactorioDecision({ ...wait, kind: 'resource_request', waitMs: 0,
    message: JSON.stringify({ item: 'wood', quantity: 0, boxId: 31 }) }));
});
test('peer messages are scoped by run, world, history and recipient and sorted numerically', () => {
  const row = (id: string, patch = {}, recipient = '') => ({ id, sender: 'peer', recipient,
    body: JSON.stringify({ version: 1, runId: 'run', worldId: 'world', historyId: 'history', sender: 'peer', kind: 'chat', payload: { text: 'Furnace free' }, ...patch }) });
  const selected = selectPeerMessages([row('10'), row('2'), row('3', { runId: 'other' }), row('4', { historyId: 'other' }), row('5', {}, 'elsewhere'), row('6', {}, 'agent-7'), row('7', { sender: 'spoof' }), row('8', { worldId: 'other' })], context);
  assert.deepEqual(selected.map(m => m.id), ['2', '6', '10']);
});
test('prompt keeps bounded recent chat and reports omissions; required context cannot be dropped', () => {
  const messages = Array.from({ length: 100 }, (_, i) => ({ id: String(i), sender: 'peer', recipient: '', kind: 'chat', payload: 'x'.repeat(2500) }));
  const prompt = buildFactorioPrompt({ ...context, messages });
  const data = JSON.parse(prompt);
  assert.ok(prompt.length < 32000);
  assert.equal(data.messages.at(-1).id, '99');
  assert.equal(data.omittedMessages, 100 - data.messages.length);
  assert.equal(data.actorId, 7);
  assert.throws(() => buildFactorioPrompt({ ...context, observation: 'x'.repeat(24000) }));
});
test('inference consumes observation and peer context with structured output', async () => {
  let seen = '';
  const ask = (async (_schema, _system, prompt) => { seen = prompt; return wait; }) as Ask;
  const decision = await decideFactorio(ask, context);
  assert.equal(decision.kind, 'wait');
  assert.equal(JSON.parse(seen).actorId, 7);
});
test('invalid provider output is rejected without scripted fallback', async () => {
  const ask = (async () => ({ ...wait, kind: 'action' })) as Ask;
  await assert.rejects(decideFactorio(ask, context), InvalidFactorioDecisionError);
});
test('abort ends inference even if a provider ignores cancellation', async () => {
  const controller = new AbortController();
  const ask = (() => new Promise(() => {})) as Ask;
  const decision = decideFactorio(ask, context, { signal: controller.signal });
  controller.abort(new Error('Operator stopped'));
  await assert.rejects(decision, /Operator stopped/);
  await assert.rejects(decideFactorio(ask, context, { signal: controller.signal }), /Operator stopped/);
});

test('construction decisions require cardinal directions and bounded recovery targets', () => {
  const action = {...wait,kind:'action',waitMs:0,message:'Build',command:{kind:'build',item:'inserter',x:0.5,y:1.5,direction:8}};
  assert.equal(validateFactorioDecision(action).kind,'action');
  assert.throws(()=>validateFactorioDecision({...action,command:{...action.command,direction:2}}));
  assert.throws(()=>validateFactorioDecision({...action,command:{...action.command,direction:16}}));
  assert.equal(validateFactorioDecision({...action,command:{kind:'recover',targetId:25}}).kind,'action');
  assert.throws(()=>validateFactorioDecision({...action,command:{kind:'recover',targetId:0}}));
});

test('research and assembler configuration decisions are bounded', () => {
  for (const command of [{kind: 'research', technology: 'automation'}, {kind: 'set_recipe', targetId: 42, recipe: 'iron-gear-wheel'}]) {
    assert.deepEqual(validateFactorioDecision({...wait, kind: 'action', command, waitMs: 0}).command, command);
  }
  for (const command of [{kind: 'research', technology: 'automation', instant: true}, {kind: 'set_recipe', targetId: 0, recipe: 'iron-gear-wheel'}]) {
    assert.throws(() => validateFactorioDecision({...wait, kind: 'action', command, waitMs: 0}));
  }
});


test('large shared task board does not stop an actor while own evidence survives', () => {
  const own={inventory:{items:{coal:5}},nearby:[]};const receipt={operationId:'op',status:'completed',item:'coal',quantity:5};
  const prompt=buildFactorioPrompt({...context,observation:own,lastResult:receipt,
    tasks:Array.from({length:40},(_,i)=>({id:`task-${i}`,title:'assigned task',details:'x'.repeat(1000),status:'claimed'})),
    status:{paused:false,resourceMap:{deposits:Array.from({length:36},()=>({resource:'iron-ore',note:'x'.repeat(300)}))}}});
  const parsed=JSON.parse(prompt);assert.ok(prompt.length<=30000);
  assert.deepEqual(parsed.observation.inventory,own.inventory);assert.deepEqual(parsed.lastResult,receipt);
  assert.ok(parsed.omittedContext.taskDescriptionCharacters>0);
});

test('coordinator directives survive activity floods with chronology and no duplicates', () => {
  const directive=(id:string,recipient:string)=>({id,sender:'run-orchestrator',recipient,kind:'chat',payload:{text:'Coordinate '+id}});
  const messages=[directive('1',context.sender),directive('2',''),directive('3',context.sender),
    ...Array.from({length:60},(_,i)=>({id:String(i+4),sender:'peer',recipient:'',kind:'action_result',payload:{item:'coal',detail:'x'.repeat(900)}}))];
  const prompt=buildFactorioPrompt({...context,messages});
  const data=JSON.parse(prompt);
  for(const id of ['1','2','3']) assert.ok(data.messages.some((m:any)=>m.id===id));
  assert.equal(new Set(data.messages.map((m:any)=>m.id)).size,data.messages.length);
  assert.equal(data.messages.at(-1).id,'63');
  assert.ok(prompt.length<30000);
  assert.equal(data.omittedMessages,messages.length-data.messages.length);
});
test('latest directed and broadcast instructions fit under heavy required context', () => {
  const messages=[
    {id:'1',sender:'run-orchestrator',recipient:context.sender,kind:'chat',payload:{text:'x'.repeat(2000)}},
    {id:'2',sender:'run-orchestrator',recipient:'',kind:'chat',payload:{text:'y'.repeat(2000)}},
    ...Array.from({length:30},(_,i)=>({id:String(i+3),sender:'peer',recipient:'',kind:'chat',payload:'z'.repeat(900)}))];
  const prompt=buildFactorioPrompt({...context,observation:'x'.repeat(23000),messages});
  const data=JSON.parse(prompt);
  assert.ok(data.messages.some((m:any)=>m.id==='1'));
  assert.ok(data.messages.some((m:any)=>m.id==='2'));
  assert.ok(prompt.length<30000);
});

test('ground pickup is bounded and uses observed item coordinates', () => {
 const command={kind:'pickup',item:'iron-ore',x:-62.703125,y:26.5,quantity:5};
 assert.equal(validateFactorioDecision({...wait,kind:'action',waitMs:0,command}).command?.kind,'pickup');
 for(const quantity of [0,101,1.5]) assert.throws(()=>validateFactorioDecision({...wait,kind:'action',waitMs:0,command:{...command,quantity}}));
});

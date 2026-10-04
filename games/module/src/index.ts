import { schema, table, t, SenderError, type ReducerCtx, type ViewCtx, type InferSchema } from 'spacetimedb/server';

const owner = table({ name: 'game_owner' }, { id: t.string().primaryKey(), identity: t.identity() });
const run = table({ name: 'game_run' }, {
  id: t.string().primaryKey(), status: t.string(), goal: t.string(), mode: t.string(),
  maxCalls: t.u32(), maxTokens: t.u32(), maxConcurrent: t.u32(), usedCalls: t.u32(), usedTokens: t.u32(),
  pricingVersion: t.string(), maxSpendMicros: t.u64(), maxWorkerSpendMicros: t.u64(), usedSpendMicros: t.u64(),
  createdAt: t.timestamp(),
});
const member = table({ name: 'game_member' }, {
  id: t.string().primaryKey(), runId: t.string().index('btree'), identity: t.identity().index('btree'),
  name: t.string(), role: t.string(), stateJson: t.string(), updatedAt: t.timestamp(),
});
const message = table({ name: 'game_message' }, {
  id: t.string().primaryKey(), runId: t.string().index('btree'), sender: t.identity(),
  recipient: t.string(), kind: t.string(), body: t.string(), createdAt: t.timestamp(),
});
const knowledge = table({ name: 'game_knowledge' }, {
  id: t.string().primaryKey(), runId: t.string().index('btree'), author: t.identity(),
  label: t.string(), x: t.f64(), y: t.f64(), z: t.f64(), state: t.string(), updatedAt: t.timestamp(),
});
const action = table({ name: 'game_action' }, {
  id: t.string().primaryKey(), runId: t.string().index('btree'), actor: t.identity(),
  commandJson: t.string(), refs: t.string(), status: t.string(), result: t.string(),
  createdAt: t.timestamp(), updatedAt: t.timestamp(),
});
const inference = table({ name: 'game_inference' }, {
  id: t.string().primaryKey(), runId: t.string().index('btree'), actor: t.identity(),
  reservedTokens: t.u32(), tokensUsed: t.u32(), status: t.string(), model: t.string(), outputJson: t.string(),
  createdAt: t.timestamp(), updatedAt: t.timestamp(),
  workId: t.string().default(''), inputHash: t.string().default(''),
  pricingVersion: t.string(), reservedSpendMicros: t.u64(), spendMicros: t.u64(),
  inputTokens: t.u32(), cacheReadTokens: t.u32(), cacheWriteTokens: t.u32(), outputTokens: t.u32(),
  actualModel: t.string(), failureReason: t.string(),
});
const modelPrice = table({ name: 'game_model_price' }, {
  id: t.string().primaryKey(), version: t.string().index('btree'), model: t.string(),
  inputMicrosPerMillion: t.u64(), cacheReadMicrosPerMillion: t.u64(),
  cacheWriteMicrosPerMillion: t.u64(), outputMicrosPerMillion: t.u64(), createdAt: t.timestamp(),
});
const db = schema({ owner, run, member, message, knowledge, action, inference, modelPrice });
export default db;
type Ctx = ReducerCtx<InferSchema<typeof db>>;
const U64_MAX = 18_446_744_073_709_551_615n;
const TOKENS_PER_MILLION = 1_000_000n;
function parseMicros(value: string) {
  if (!/^(0|[1-9]\d*)$/.test(value)) throw new SenderError('Money amounts must be unsigned micro-USD integers');
  const amount = BigInt(value);
  if (amount > U64_MAX) throw new SenderError('Money amount exceeds supported range');
  return amount;
}
function usageCost(usage: {inputTokens:number;cacheReadTokens:number;cacheWriteTokens:number;outputTokens:number}, price: typeof modelPrice.rowType.type) {
  const numerator=BigInt(usage.inputTokens)*price.inputMicrosPerMillion+BigInt(usage.cacheReadTokens)*price.cacheReadMicrosPerMillion+
    BigInt(usage.cacheWriteTokens)*price.cacheWriteMicrosPerMillion+BigInt(usage.outputTokens)*price.outputMicrosPerMillion;
  const result=(numerator+TOKENS_PER_MILLION-1n)/TOKENS_PER_MILLION;
  if(result>U64_MAX)throw new SenderError('Model cost exceeds supported range');
  return result;
}
function reserveCost(inputTokens: number, outputTokens: number, price: typeof modelPrice.rowType.type) {
  const inputRate = [price.inputMicrosPerMillion,price.cacheReadMicrosPerMillion,price.cacheWriteMicrosPerMillion].reduce((a,b)=>a>b?a:b,0n);
  const result=(BigInt(inputTokens)*inputRate+BigInt(outputTokens)*price.outputMicrosPerMillion+TOKENS_PER_MILLION-1n)/TOKENS_PER_MILLION;
  if(result>U64_MAX)throw new SenderError('Model reservation exceeds supported range');
  return result;
}
function priceId(version:string,model:string) { return `${version}:${model}`; }
function text(value: string, max: number) { if (!value.trim() || value.length > max) throw new SenderError('Invalid text length'); }
function id(value: string) { if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new SenderError('Invalid ID'); }
function operator(ctx: Ctx) { if (!ctx.db.owner.id.find('owner')?.identity.equals(ctx.sender)) throw new SenderError('Owner required'); }
function membership(ctx: Ctx, runId: string, active = true) {
  const row = ctx.db.member.id.find(`${runId}:${ctx.sender.toHexString()}`);
  if (!row) throw new SenderError('Run membership required');
  const current = ctx.db.run.id.find(runId);
  if (!current || active && current.status !== 'active') throw new SenderError('Run is paused or closed');
  return { row, current };
}
export const init = db.init(ctx => { ctx.db.owner.insert({ id: 'owner', identity: ctx.sender }); });
export const createRun = db.reducer({ id: t.string(), goal: t.string(), mode: t.string(), maxCalls: t.u32(), maxTokens: t.u32(), maxConcurrent: t.u32() }, (ctx, v) => {
  operator(ctx); id(v.id); text(v.goal, 2000);
  if (!['none','messages','knowledge'].includes(v.mode) || !v.maxCalls || v.maxCalls > 10000 || v.maxTokens < 32000 || v.maxTokens > 100000000 || !v.maxConcurrent || v.maxConcurrent > 10) throw new SenderError('Invalid run limits');
  if (ctx.db.run.id.find(v.id)) throw new SenderError('Run already exists');
  ctx.db.run.insert({ ...v, status: 'active', usedCalls: 0, usedTokens: 0, pricingVersion: '', maxSpendMicros: 0n,
    maxWorkerSpendMicros: 0n, usedSpendMicros: 0n, createdAt: ctx.timestamp });
  ctx.db.member.insert({ id: `${v.id}:${ctx.sender.toHexString()}`, runId: v.id, identity: ctx.sender, name: 'operator', role: 'operator', stateJson: '{}', updatedAt: ctx.timestamp });
});
export const grantMember = db.reducer({ runId: t.string(), identity: t.identity(), name: t.string() }, (ctx, v) => {
  operator(ctx); id(v.name);
  if (!ctx.db.run.id.find(v.runId)) throw new SenderError('Run missing');
  const key = `${v.runId}:${v.identity.toHexString()}`;
  const existing = ctx.db.member.id.find(key);
  if (existing) { if (existing.name !== v.name) throw new SenderError('Identity already named'); return; }
  if ([...ctx.db.member.runId.filter(v.runId)].some(m => m.name === v.name)) throw new SenderError('Name already granted');
  ctx.db.member.insert({ id: key, ...v, role: 'agent', stateJson: '{}', updatedAt: ctx.timestamp });
});
export const revokeMember = db.reducer({ runId: t.string(), identity: t.identity() }, (ctx,v) => { operator(ctx); ctx.db.member.id.delete(`${v.runId}:${v.identity.toHexString()}`); });
export const grantOperator = db.reducer({runId:t.string(),identity:t.identity(),name:t.string()},(ctx,v)=>{
  operator(ctx);id(v.name);if(!ctx.db.run.id.find(v.runId))throw new SenderError('Run missing');
  const key=`${v.runId}:${v.identity.toHexString()}`;
  const old=ctx.db.member.id.find(key);
  if(!old && [...ctx.db.member.runId.filter(v.runId)].some(m=>m.name===v.name))throw new SenderError('Name already granted');
  if(old)ctx.db.member.id.update({...old,role:'operator',updatedAt:ctx.timestamp});
  else ctx.db.member.insert({id:key,...v,role:'operator',stateJson:'{}',updatedAt:ctx.timestamp});
});
export const setRunStatus = db.reducer({ runId: t.string(), status: t.string() }, (ctx,v) => {
  if(!ctx.db.owner.id.find('owner')?.identity.equals(ctx.sender) && ctx.db.member.id.find(`${v.runId}:${ctx.sender.toHexString()}`)?.role!=='operator')throw new SenderError('Run operator required');
  const current = ctx.db.run.id.find(v.runId);
  if (!current || !['active','paused','closed'].includes(v.status) || current.status === 'closed') throw new SenderError('Invalid run status');
  ctx.db.run.id.update({ ...current, status: v.status });
});
export const publishState = db.reducer({ runId: t.string(), stateJson: t.string() }, (ctx,v) => {
  const {row} = membership(ctx,v.runId,false); text(v.stateJson,16000);
  const parsed = JSON.parse(v.stateJson); if (!Array.isArray(parsed.position) || parsed.position.length !== 3 || parsed.position.some((x: unknown) => typeof x !== 'number' || !Number.isFinite(x))) throw new SenderError('Position required');
  ctx.db.member.id.update({ ...row, stateJson: v.stateJson, updatedAt: ctx.timestamp });
});
export const postMessage = db.reducer({ id: t.string(), runId: t.string(), recipient: t.string(), kind: t.string(), body: t.string() }, (ctx,v) => {
  const {current} = membership(ctx,v.runId); id(v.id); text(v.body,2000);
  if (current.mode === 'none' || !['observation','request','offer','commitment','result','warning'].includes(v.kind)) throw new SenderError('Messages disabled or invalid kind');
  if (v.recipient && ![...ctx.db.member.runId.filter(v.runId)].some(m => m.name === v.recipient)) throw new SenderError('Unknown recipient');
  const old = ctx.db.message.id.find(v.id);
  if (old) { if (old.sender.equals(ctx.sender) && old.runId === v.runId && old.body === v.body && old.kind === v.kind && old.recipient === v.recipient) return; throw new SenderError('Message ID collision'); }
  ctx.db.message.insert({ ...v, sender: ctx.sender, createdAt: ctx.timestamp });
});
export const publishKnowledge = db.reducer({ id: t.string(), runId: t.string(), label: t.string(), x: t.f64(), y: t.f64(), z: t.f64() }, (ctx,v) => {
  const {row,current} = membership(ctx,v.runId); id(v.id); text(v.label,100);
  if (current.mode !== 'knowledge') throw new SenderError('Knowledge disabled');
  const p = JSON.parse(row.stateJson).position;
  if (!p || ![v.x,v.y,v.z].every(Number.isFinite) || Math.hypot(v.x-p[0],v.y-p[1],v.z-p[2]) > 16) throw new SenderError('Report outside local observation');
  const old = ctx.db.knowledge.id.find(v.id);
  if (old) { if (old.author.equals(ctx.sender) && old.runId === v.runId && old.label === v.label && old.x === v.x && old.y === v.y && old.z === v.z) return; throw new SenderError('Knowledge ID collision'); }
  ctx.db.knowledge.insert({ ...v, author: ctx.sender, state: 'reported', updatedAt: ctx.timestamp });
});
export const reviewKnowledge = db.reducer({ runId: t.string(), id: t.string(), state: t.string() }, (ctx,v) => {
  const {row,current} = membership(ctx,v.runId); const entry = ctx.db.knowledge.id.find(v.id);
  const p = JSON.parse(row.stateJson).position;
  if (current.mode !== 'knowledge' || !entry || entry.runId !== v.runId || !['confirmed','disputed','stale'].includes(v.state) || !p || Math.hypot(entry.x-p[0],entry.y-p[1],entry.z-p[2])>16) throw new SenderError('Invalid knowledge review');
  // Each review is also a durable attributable message; the summary does not erase its history.
  const reviewId = `${v.id.slice(0,45)}.${ctx.sender.toHexString()}.${ctx.timestamp.microsSinceUnixEpoch}`;
  ctx.db.message.insert({ id: reviewId, runId:v.runId, sender:ctx.sender, recipient:'',kind:'observation',body:JSON.stringify({knowledgeId:v.id,state:v.state}),createdAt:ctx.timestamp });
  ctx.db.knowledge.id.update({ ...entry, state:v.state, updatedAt:ctx.timestamp });
});
export const beginAction = db.reducer({ id: t.string(), runId: t.string(), commandJson: t.string(), refs: t.string() }, (ctx,v) => {
  membership(ctx,v.runId); id(v.id); text(v.commandJson,2000); JSON.parse(v.commandJson);
  const references = v.refs ? v.refs.split(',') : [];
  if (references.length>20) throw new SenderError('Too many citations');
  for (const ref of references) { const entry = ctx.db.message.id.find(ref) ?? ctx.db.knowledge.id.find(ref); if (!entry || entry.runId!==v.runId) throw new SenderError('Invalid citation'); }
  const old=ctx.db.action.id.find(v.id);
  if (old) { if (old.actor.equals(ctx.sender) && old.runId===v.runId && old.commandJson===v.commandJson && old.refs===v.refs) return; throw new SenderError('Action ID collision'); }
  if ([...ctx.db.action.runId.filter(v.runId)].some(a=>a.actor.equals(ctx.sender) && a.status==='started')) throw new SenderError('Unresolved action must be reconciled');
  ctx.db.action.insert({...v,actor:ctx.sender,status:'started',result:'',createdAt:ctx.timestamp,updatedAt:ctx.timestamp});
});
export const finishAction = db.reducer({ id: t.string(), result: t.string(), status: t.string() }, (ctx,v)=>{
  const old=ctx.db.action.id.find(v.id); if (!old || !old.actor.equals(ctx.sender)) throw new SenderError('Action not owned');
  membership(ctx,old.runId,false); text(v.result,4000);
  if (!['completed','failed','uncertain'].includes(v.status)) throw new SenderError('Invalid action result');
  if (old.status!=='started') { if(old.status===v.status && old.result===v.result)return; throw new SenderError('Result immutable'); }
  ctx.db.action.id.update({...old,...v,updatedAt:ctx.timestamp});
});
export const configureSpend = db.reducer({ runId:t.string(),version:t.string(),model:t.string(),inputMicrosPerMillion:t.string(),
  cacheReadMicrosPerMillion:t.string(),cacheWriteMicrosPerMillion:t.string(),outputMicrosPerMillion:t.string(),
  maxSpendMicros:t.string(),maxWorkerSpendMicros:t.string() },(ctx,v)=>{
  operator(ctx);text(v.version,64);text(v.model,128);
  const price={id:priceId(v.version,v.model),version:v.version,model:v.model,
    inputMicrosPerMillion:parseMicros(v.inputMicrosPerMillion),cacheReadMicrosPerMillion:parseMicros(v.cacheReadMicrosPerMillion),
    cacheWriteMicrosPerMillion:parseMicros(v.cacheWriteMicrosPerMillion),outputMicrosPerMillion:parseMicros(v.outputMicrosPerMillion),createdAt:ctx.timestamp};
  const prior=ctx.db.modelPrice.id.find(price.id);
  if(prior){if(prior.version!==price.version||prior.model!==price.model||prior.inputMicrosPerMillion!==price.inputMicrosPerMillion||
    prior.cacheReadMicrosPerMillion!==price.cacheReadMicrosPerMillion||prior.cacheWriteMicrosPerMillion!==price.cacheWriteMicrosPerMillion||
    prior.outputMicrosPerMillion!==price.outputMicrosPerMillion)throw new SenderError('Pricing version is immutable');}
  else ctx.db.modelPrice.insert(price);
  const current=ctx.db.run.id.find(v.runId);if(!current)throw new SenderError('Run missing');
  const maxSpendMicros=parseMicros(v.maxSpendMicros),maxWorkerSpendMicros=parseMicros(v.maxWorkerSpendMicros);
  if(maxSpendMicros>0n&&maxSpendMicros<current.usedSpendMicros)throw new SenderError('Run ceiling below reserved or spent amount');
  const byWorker=new Map<string,bigint>();
  for(const attempt of ctx.db.inference.runId.filter(v.runId)){const key=attempt.actor.toHexString();byWorker.set(key,(byWorker.get(key)??0n)+attempt.spendMicros);}
  if(maxWorkerSpendMicros>0n&&[...byWorker.values()].some(value=>value>maxWorkerSpendMicros))throw new SenderError('Worker ceiling below reserved or spent amount');
  ctx.db.run.id.update({...current,pricingVersion:v.version,maxSpendMicros,maxWorkerSpendMicros});
});
export const beginInference = db.reducer({ id:t.string(),runId:t.string(),reservedInputTokens:t.u32(),reservedOutputTokens:t.u32(),model:t.string(),workId:t.string(),inputHash:t.string() },(ctx,v)=>{
  const {current}=membership(ctx,v.runId);id(v.id);text(v.model,128);
  id(v.workId);if(!/^[a-f0-9]{64}$/.test(v.inputHash))throw new SenderError('Input checksum required');
  if([...ctx.db.inference.runId.filter(v.runId)].some(i=>i.actor.equals(ctx.sender)&&i.workId===v.workId&&['pending','completed'].includes(i.status)))throw new SenderError('Inference work already recorded; reconcile or reuse its output');
  const pending=[...ctx.db.inference.runId.filter(v.runId)].filter(i=>i.status==='pending');
  const reservedTokens=v.reservedInputTokens+v.reservedOutputTokens;
  if(!current.pricingVersion)throw new SenderError('Model price version is not configured');
  const price=ctx.db.modelPrice.id.find(priceId(current.pricingVersion,v.model));
  if(!price)throw new SenderError(`No model price for ${v.model} in version ${current.pricingVersion}`);
  const reservedSpendMicros=reserveCost(v.reservedInputTokens,v.reservedOutputTokens,price);
  const workerSpend=[...ctx.db.inference.runId.filter(v.runId)].filter(i=>i.actor.equals(ctx.sender)).reduce((sum,i)=>sum+i.spendMicros,0n);
  if(ctx.db.inference.id.find(v.id) || v.reservedInputTokens<1 || v.reservedOutputTokens<1 || !Number.isSafeInteger(reservedTokens) ||
    current.usedCalls>=current.maxCalls || current.usedTokens+reservedTokens>current.maxTokens || pending.length>=current.maxConcurrent ||
    current.usedSpendMicros+reservedSpendMicros>U64_MAX || (current.maxSpendMicros>0n&&current.usedSpendMicros+reservedSpendMicros>current.maxSpendMicros) ||
    (current.maxWorkerSpendMicros>0n&&workerSpend+reservedSpendMicros>current.maxWorkerSpendMicros)) throw new SenderError('Inference budget or concurrency limit');
  ctx.db.run.id.update({...current,usedCalls:current.usedCalls+1,usedTokens:current.usedTokens+reservedTokens,usedSpendMicros:current.usedSpendMicros+reservedSpendMicros});
  ctx.db.inference.insert({...v,actor:ctx.sender,reservedTokens,tokensUsed:reservedTokens,status:'pending',outputJson:'',pricingVersion:current.pricingVersion,
    reservedSpendMicros,spendMicros:reservedSpendMicros,inputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:0,actualModel:'',failureReason:'',
    createdAt:ctx.timestamp,updatedAt:ctx.timestamp});
});
export const finishInference = db.reducer({id:t.string(),inputTokens:t.u32(),cacheReadTokens:t.u32(),cacheWriteTokens:t.u32(),outputTokens:t.u32(),usageKnown:t.bool(),succeeded:t.bool(),model:t.string(),outputJson:t.string()},(ctx,v)=>{
  const old=ctx.db.inference.id.find(v.id);if(!old || !old.actor.equals(ctx.sender) || old.status!=='pending')throw new SenderError('Inference not pending/owned');
  text(v.model,128);if(v.outputJson.length>16000||(v.succeeded&&!v.outputJson))throw new SenderError('Invalid inference output');
  if(v.succeeded)JSON.parse(v.outputJson);
  const actualTokens=v.inputTokens+v.cacheReadTokens+v.cacheWriteTokens+v.outputTokens;
  if(!Number.isSafeInteger(actualTokens))throw new SenderError('Usage token overflow');
  const {current}=membership(ctx,old.runId,false);
  const actualPrice=ctx.db.modelPrice.id.find(priceId(old.pricingVersion,v.model));
  const requestPrice=ctx.db.modelPrice.id.find(priceId(old.pricingVersion,old.model));if(!requestPrice)throw new SenderError('Recorded model price missing');
  const actualSpendMicros=usageCost(v,actualPrice??requestPrice);
  const unpricedModel=v.usageKnown&&v.model!==old.model&&!actualPrice;
  const exceeded=v.usageKnown&&(actualTokens>old.reservedTokens||actualSpendMicros>old.reservedSpendMicros);
  const settled=v.usageKnown&&!!actualPrice&&!unpricedModel;
  const spendMicros=settled?actualSpendMicros:old.reservedSpendMicros;
  const tokensUsed=settled?actualTokens:old.reservedTokens;
  const totalSpend=current.usedSpendMicros-old.reservedSpendMicros+spendMicros;
  if(totalSpend>U64_MAX)throw new SenderError('Spend counter overflow');
  ctx.db.run.id.update({...current,usedTokens:current.usedTokens-old.reservedTokens+tokensUsed,usedSpendMicros:totalSpend});
  if(unpricedModel||exceeded){const r=ctx.db.run.id.find(old.runId)!;if(r.status==='active')ctx.db.run.id.update({...r,status:'paused'});}
  const failed=!v.succeeded||unpricedModel||exceeded;
  ctx.db.inference.id.update({...old,inputTokens:v.inputTokens,cacheReadTokens:v.cacheReadTokens,cacheWriteTokens:v.cacheWriteTokens,outputTokens:v.outputTokens,
    tokensUsed,spendMicros,actualModel:v.model,outputJson:failed?'':v.outputJson,status:failed?'failed':'completed',
    failureReason:unpricedModel?'actual_model_unpriced':exceeded?'usage_exceeded_reservation':failed?'provider_call_uncertain':'',updatedAt:ctx.timestamp});
});
export const resolveAction = db.reducer({id:t.string(),status:t.string(),evidence:t.string()},(ctx,v)=>{
  operator(ctx);text(v.evidence,2000);const old=ctx.db.action.id.find(v.id);
  if(!old || !['started','uncertain'].includes(old.status) || !['completed','failed'].includes(v.status))throw new SenderError('Only uncertain actions may be reconciled');
  ctx.db.message.insert({id:`resolution.${ctx.timestamp.microsSinceUnixEpoch}`,runId:old.runId,sender:ctx.sender,recipient:'',kind:'warning',body:JSON.stringify({actionId:old.id,previousStatus:old.status,previousResult:old.result,status:v.status,evidence:v.evidence}),createdAt:ctx.timestamp});
  ctx.db.action.id.update({...old,status:v.status,result:`Operator reconciled: ${v.evidence}`,updatedAt:ctx.timestamp});
});
export const resolveInference = db.reducer({id:t.string(),evidence:t.string()},(ctx,v)=>{
  operator(ctx);text(v.evidence,2000);const old=ctx.db.inference.id.find(v.id);
  if(!old || old.status!=='pending')throw new SenderError('Inference not pending');
  // Unknown usage remains fully reserved, but a stopped call no longer holds a concurrency slot.
  ctx.db.inference.id.update({...old,status:'uncertain',updatedAt:ctx.timestamp});
  ctx.db.message.insert({id:`inference-resolution.${ctx.timestamp.microsSinceUnixEpoch}`,runId:old.runId,sender:ctx.sender,recipient:'',kind:'warning',body:JSON.stringify({inferenceId:old.id,evidence:v.evidence,tokensRetained:old.reservedTokens,spendMicrosRetained:old.reservedSpendMicros.toString()}),createdAt:ctx.timestamp});
});

// Indexed run membership drives every read; revocation removes subscribed rows immediately.
function runs(ctx: ViewCtx<InferSchema<typeof db>>) { return [...ctx.db.member.identity.filter(ctx.sender)].map(m=>m.runId); }
export const myRun=db.view({name:'my_game_run',public:true},t.array(run.rowType),ctx=>runs(ctx).flatMap(id=>{const r=ctx.db.run.id.find(id);return r?[r]:[];}));
export const myMember=db.view({name:'my_game_member',public:true},t.array(member.rowType),ctx=>runs(ctx).flatMap(id=>[...ctx.db.member.runId.filter(id)]));
export const myMessage=db.view({name:'my_game_message',public:true},t.array(message.rowType),ctx=>runs(ctx).flatMap(id=>[...ctx.db.message.runId.filter(id)]));
export const myKnowledge=db.view({name:'my_game_knowledge',public:true},t.array(knowledge.rowType),ctx=>runs(ctx).flatMap(id=>[...ctx.db.knowledge.runId.filter(id)]));
export const myAction=db.view({name:'my_game_action',public:true},t.array(action.rowType),ctx=>runs(ctx).flatMap(id=>[...ctx.db.action.runId.filter(id)]));
export const myInference=db.view({name:'my_game_inference',public:true},t.array(inference.rowType),ctx=>runs(ctx).flatMap(id=>[...ctx.db.inference.runId.filter(id)]));
export const myModelPrice=db.view({name:'my_game_model_price',public:true},t.array(modelPrice.rowType),ctx=>ctx.db.owner.id.find('owner')?.identity.equals(ctx.sender)?[...ctx.db.modelPrice.iter()]:[]);

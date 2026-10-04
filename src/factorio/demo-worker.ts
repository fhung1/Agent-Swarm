import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { MessageBoardClient } from '../../message-board/client.ts';

const [world, indexText, actorText, runId] = process.argv.slice(2);
const index = Number(indexText), actor = Number(actorText);
if (!world || !Number.isInteger(index) || !Number.isInteger(actor) || !runId) throw Error('Usage: demo-worker WORLD INDEX ACTOR RUN');
const name = `factorio-${String(index).padStart(2,'0')}`;
const taskId = `plate-${String(index).padStart(2,'0')}`;
const ownDir = join(world,'workers',name);
mkdirSync(ownDir,{recursive:true,mode:0o700});
const tokenPath=join(ownDir,'board.token'), journalPath=join(ownDir,'operations.jsonl');
const journal = existsSync(journalPath) ? readFileSync(journalPath,'utf8').trim().split('\n').filter(Boolean).map(x=>JSON.parse(x)) : [];
const done = new Set(journal.filter(x=>x.state==='done').map(x=>x.id));
let changed = 0;
const board = new MessageBoardClient({uri:process.env.BOARD_URI??'ws://127.0.0.1:3001',database:'quant-swarm-factorio-coord',
 token:existsSync(tokenPath)?readFileSync(tokenPath,'utf8'):undefined,
 onToken(token){writeFileSync(tokenPath,token,{mode:0o600});chmodSync(tokenPath,0o600)},onChange(){changed++}});
board.start();
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function waitFor(predicate:()=>boolean, ms=30000){const end=Date.now()+ms;while(Date.now()<end){if(predicate())return;await sleep(150)}throw Error('Timed out waiting for board state')}
function game(request:Record<string,unknown>):any {return JSON.parse(execFileSync('python3',['factorio/worker-bridge.py',world],{input:JSON.stringify(request),encoding:'utf8',timeout:25000}));}
async function post(kind:string,payload:Record<string,unknown>,linked=true){
 const envelope={version:1,runId,worldId:manifest.worldId,taskId:linked?taskId:null,sender:name,kind,payload};
 await board.post(name,JSON.stringify(envelope),'',linked?taskId:'');
}
const manifest=JSON.parse(readFileSync(join(world,'manifest.json'),'utf8'));
async function reserve(path:string){
 while(true){await waitFor(()=>board.ready);const s=board.snapshot();
  if(s.reservations.some(r=>r.path===path&&r.holder===name))return;
  if(!s.reservations.some(r=>r.path===path)){
   try{await board.reserve(name,path,taskId,`fixture resource for ${taskId}`,5)}catch{}
   await sleep(250);if(board.snapshot().reservations.some(r=>r.path===path&&r.holder===name))return;
  }await sleep(400);
 }
}
async function action(label:string,command:Record<string,unknown>){
 const id=`${runId}-${name}-${label}`;
 if(!done.has(id)){
  appendFileSync(journalPath,JSON.stringify({id,state:'pending',command})+'\n',{mode:0o600});
  let receipt;
  try{receipt=game({kind:'receipt',operation:id})}catch{receipt=null}
  if(!receipt)receipt=game({kind:'execute',actor,operation:id,command});
  if(receipt.status!=='completed')throw Error(`${id}: ${JSON.stringify(receipt)}`);
  appendFileSync(journalPath,JSON.stringify({id,state:'done',receipt})+'\n');done.add(id);
 }
 const receipt=game({kind:'receipt',operation:id});
 if(!receipt||receipt.status!=='completed')throw Error(`Missing game receipt ${id}`);
 if(command.kind!=='move'&&!board.snapshot().messages.some(m=>m.body.includes(`"operationId":"${id}"`)))
  await post('action_result',{operationId:id,item:receipt.item,quantity:receipt.quantity,actorId:actor,gameTick:receipt.endTick});
 return receipt;
}
async function approach(label:string,x:number,y:number){
 const here=game({kind:'observe',actor});
 if(Math.hypot(here.x-x,here.y-y)<=5)return;
 await action(label,{kind:'move',x,y,maxTicks:600});
}
async function main(){
 await waitFor(()=>board.ready);await board.register(name,'rules-worker',`actor ${actor}; ${runId}`);
 await waitFor(()=>board.snapshot().tasks.some(t=>t.id===taskId));
 const task=board.snapshot().tasks.find(t=>t.id===taskId)!;
 if(task.status==='done'){console.log(`${name} already complete`);return}
 if(task.status==='open')await board.claimTask(name,taskId);
 await waitFor(()=>board.snapshot().tasks.some(t=>t.id===taskId&&t.status==='claimed'&&t.assignee===name));
 await post('observation',{actorId:actor,goal:'five iron plates',source:'live game'});
 const status=game({kind:'status'});const chest=status.chests[0];
 if(!chest)throw Error('Fixture chest missing');
 const chestPath=`world/${manifest.worldId}/entity/${chest.unit}`;
 await reserve(chestPath);
 await approach('move-chest',chest.x+1,chest.y);
 await action('take-ore',{kind:'take',targetId:chest.unit,item:'iron-ore',quantity:5});
 await action('take-coal',{kind:'take',targetId:chest.unit,item:'coal',quantity:1});
 await board.releaseReservation(name,chestPath);
 await post('resource_request',{resource:'furnace',ore:5,coal:1});
 const observed=game({kind:'observe',actor});const furnaces=observed.nearby.filter((e:any)=>e.type==='furnace');
 if(!furnaces.length)throw Error('No furnace in observation radius');
 let furnace:any, furnacePath='';
 while(!furnace){for(const candidate of furnaces){const path=`world/${manifest.worldId}/entity/${candidate.unit}`;
  if(board.snapshot().reservations.some(r=>r.path===path&&r.holder===name)){furnace=candidate;furnacePath=path;break}
  if(!board.snapshot().reservations.some(r=>r.path===path)){try{await board.reserve(name,path,taskId,'smelting five plates',5)}catch{}
   await sleep(250);if(board.snapshot().reservations.some(r=>r.path===path&&r.holder===name)){furnace=candidate;furnacePath=path;break}}
  }await sleep(500)}
 await post('task_handoff',{furnaceId:furnace.unit,sharedFixture:true});
 await approach('move-furnace',furnace.x+2,furnace.y);
 await action('put-ore',{kind:'put',targetId:furnace.unit,item:'iron-ore',quantity:5});
 await action('put-coal',{kind:'put',targetId:furnace.unit,item:'coal',quantity:1});
 const collected=game({kind:'receipt',operation:`${runId}-${name}-collect-plates`});
 const deadline=Date.now()+60000;
 if(!collected)while(Date.now()<deadline){const obs=game({kind:'observe',actor});const f=obs.nearby.find((e:any)=>e.unit===furnace.unit);
  if(f?.items?.ironPlate>=5)break;await sleep(500)}
 await action('collect-plates',{kind:'take',targetId:furnace.unit,item:'iron-plate',quantity:5});
 const final=game({kind:'observe',actor});if(final.inventory.ironPlate!==5)throw Error(`Inventory verification failed: ${JSON.stringify(final.inventory)}`);
 await board.releaseReservation(name,furnacePath);
 await post('observation',{actorId:actor,ironPlate:5,verifiedTick:final.tick});
 await board.updateTask(name,taskId,'done',`Game inventory: actor ${actor}, 5 iron plates; receipts ${runId}-${name}-*`);
 console.log(`${name}: verified five plates in actor ${actor}`);
 // Viewing is distinct from production. Keep moving near spawn until stopped.
 let step=0;while(true){await sleep(2500);if(!board.ready)continue;
  try{const s=game({kind:'status'});if(s.paused)continue;const a=s.actors.find((x:any)=>x.unit===actor);if(!a)continue;
   const x=a.x+(step%2===0?1:-1),y=a.y+(step%4<2?0.5:-0.5);step++;
   await action(`view-${step}`,{kind:'move',x,y,maxTicks:180});
   if(step%8===0)await post('viewing',{actorId:actor,step,gameTick:s.tick},false);
  }catch(e){console.error(`${name} viewing: ${e}`)}
 }
}
main().catch(e=>{console.error(`${name}:`,e);process.exitCode=1;board.stop()});

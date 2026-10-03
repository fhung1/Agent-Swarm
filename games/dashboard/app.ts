import { DbConnection } from '../src/module_bindings/index.ts';
const get=(id:string)=>document.getElementById(id)!;
const tokenKey='quant-swarm:games:token';
let conn:DbConnection|undefined;
let selected='';
function node(tag:string,text:string,cls=''){const n=document.createElement(tag);n.textContent=text;n.className=cls;return n;}
function render(){
  if(!conn)return;
  const runs=[...conn.db.myRun.iter()];const select=get('runs') as HTMLSelectElement;
  if(!runs.some(r=>r.id===selected))selected=runs[0]?.id??'';
  select.replaceChildren(...runs.map(r=>{const o=node('option',r.id) as HTMLOptionElement;o.value=r.id;o.selected=r.id===selected;return o;}));
  const run=runs.find(r=>r.id===selected);
  get('access').textContent=runs.length?'':`No run access. Owner grants this browser identity:\nspacetime call --server local quant-swarm-games grant_operator minecraft-pilot ${conn.identity?.toHexString()??''} game-dashboard`;
  get('summary').textContent=run?`${run.status} · ${run.goal} · ${run.usedCalls}/${run.maxCalls} model calls · ${run.usedTokens}/${run.maxTokens} reserved/used tokens · mode ${run.mode}`:'Waiting for a grant';
  const members=[...conn.db.myMember.iter()].filter(m=>m.runId===selected);
  const isOperator=members.some(m=>m.identity.equals(conn!.identity!)&&m.role==='operator');
  for(const id of ['pause','resume','close'])(get(id) as HTMLButtonElement).disabled=!isOperator||run?.status==='closed';
  get('agents').replaceChildren(...members.filter(m=>m.role==='agent').map(m=>{
    const card=node('div','','card');card.append(node('strong',m.name));
    let state:{position?:number[];health?:number;food?:number;inventory?:{name:string;count:number}[]};try{state=JSON.parse(m.stateJson);}catch{state={};}
    card.append(node('p',`Position: ${state.position?.map(n=>n.toFixed(1)).join(', ')??'not reported'}\nHealth ${state.health??'?'} · Food ${state.food??'?'}\n${state.inventory?.map(i=>`${i.count} ${i.name}`).join(', ')??''}\nUpdated ${m.updatedAt.toISOString()}`));
    const last=[...conn!.db.myAction.iter()].filter(a=>a.runId===selected&&a.actor.equals(m.identity)).sort((a,b)=>Number(b.createdAt.microsSinceUnixEpoch-a.createdAt.microsSinceUnixEpoch))[0];
    if(last)card.append(node('p',`${last.status}: ${last.commandJson}\n${last.result.slice(0,150)}`));return card;
  }));
  get('knowledge').replaceChildren(...[...conn.db.myKnowledge.iter()].filter(k=>k.runId===selected).slice(-40).map(k=>node('div',`${k.label} at ${k.x}, ${k.y}, ${k.z} · ${k.state}\n${k.id} · ${k.author.toHexString().slice(0,12)}`,'event')));
  const messages=[...conn.db.myMessage.iter()].filter(m=>m.runId===selected).map(m=>({at:m.createdAt,text:`${members.find(a=>a.identity.equals(m.sender))?.name??'unknown'} · ${m.kind}: ${m.body}`}));
  const actions=[...conn.db.myAction.iter()].filter(a=>a.runId===selected).map(a=>({at:a.updatedAt,text:`${members.find(m=>m.identity.equals(a.actor))?.name??'unknown'} · ${a.status}: ${a.commandJson}\nCitations: ${a.refs||'none'}\n${a.result.slice(0,200)}`}));
  get('timeline').replaceChildren(...[...messages,...actions].sort((a,b)=>Number(b.at.microsSinceUnixEpoch-a.at.microsSinceUnixEpoch)).slice(0,60).map(e=>node('div',`${e.at.toISOString()}\n${e.text}`,'event')));
}
let retry:ReturnType<typeof setTimeout>|undefined;
function reconnect(){get('connection').textContent='Disconnected; retrying';if(!retry)retry=setTimeout(()=>{retry=undefined;connect();},2000);}
function connect(){
  conn=DbConnection.builder().withUri('ws://127.0.0.1:3000').withDatabaseName('quant-swarm-games').withToken(localStorage.getItem(tokenKey)??undefined)
    .onConnect((connection,_identity,token)=>{localStorage.setItem(tokenKey,token);get('connection').textContent='Connected';
      for(const table of [connection.db.myRun,connection.db.myMember,connection.db.myAction,connection.db.myKnowledge,connection.db.myMessage,connection.db.myInference]){table.onInsert(render);table.onUpdate(render);table.onDelete(render);}
      connection.subscriptionBuilder().onApplied(render).onError(()=>{connection.disconnect();reconnect();}).subscribe(['SELECT * FROM my_game_run','SELECT * FROM my_game_member','SELECT * FROM my_game_action','SELECT * FROM my_game_knowledge','SELECT * FROM my_game_message','SELECT * FROM my_game_inference']);
    }).onConnectError(reconnect).onDisconnect(reconnect).build();
}
(get('runs') as HTMLSelectElement).addEventListener('change',event=>{selected=(event.target as HTMLSelectElement).value;render();});
for(const [button,status] of [['pause','paused'],['resume','active'],['close','closed']])get(button).addEventListener('click',()=>{void conn?.reducers.setRunStatus({runId:selected,status}).catch(error=>{get('connection').textContent=String(error);});});
connect();

import { MessageBoardClient } from '../message-board/client.ts';

type BoardId='development'|'factorio';
const databases:Record<BoardId,string>={development:'quant-swarm-coord',factorio:'quant-swarm-factorio-coord'};
const labels:Record<BoardId,string>={development:'Development',factorio:'Factorio'};
const selected:BoardId=new URLSearchParams(location.search).get('board')==='factorio'?'factorio':'development';
const root=document.getElementById('app')!;
const clients={} as Record<BoardId,MessageBoardClient>;
const HISTORY_WINDOW_MS=30*24*60*60_000;
const MAX_RENDERED_ROWS=100;
const boardPort=new URLSearchParams(location.search).get('dbPort')??'3001';
if(!/^\d{1,5}$/.test(boardPort)||Number(boardPort)>65535)throw Error('Invalid board port');
const uri=`ws://${location.hostname}:${boardPort}`;
function esc(value:unknown){return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!))}
function takeTop<T>(rows:Iterable<T>,limit:number,compare:(a:T,b:T)=>number){const result:T[]=[];for(const row of rows){let low=0,high=result.length;while(low<high){const middle=(low+high)>>>1;if(compare(result[middle],row)<=0)low=middle+1;else high=middle}if(low>=limit)continue;result.splice(low,0,row);if(result.length>limit)result.pop()}return result}
function render(){
 const client=clients[selected];if(!client)return;
 const snap=client.snapshot();
 const nav=(Object.keys(databases) as BoardId[]).map(id=>`<li><a href="/?board=${id}&dbPort=${boardPort}">${labels[id]}</a> <span class="${clients[id]?.ready?'live':'offline'}">${clients[id]?.ready?'Available · live':'Unavailable'}</span> <small>http://${location.hostname}:${location.port}/?board=${id}&dbPort=${boardPort}</small></li>`).join('');
 const messages=takeTop(snap.messages,MAX_RENDERED_ROWS,(a,b)=>a.id>b.id?-1:a.id<b.id?1:0).map(m=>{
  let body=String(m.body);try{const e=JSON.parse(body);body=`${e.kind} · ${JSON.stringify(e.payload)}`}catch{}
  return `<li><b>${esc(m.sender)}</b> ${m.taskId?`<small>${esc(m.taskId)}</small>`:''} ${esc(body)}</li>`}).join('');
 const tasks=snap.tasks.slice(0,MAX_RENDERED_ROWS);
 const participants=snap.participants.slice(0,MAX_RENDERED_ROWS);
 const reservations=snap.reservations.slice(0,MAX_RENDERED_ROWS);
 root.innerHTML=`<header><h1>${labels[selected]} board</h1><p>${esc(client.state)} · ${esc(databases[selected])} · last 30 days, plus unfinished tasks; showing at most ${MAX_RENDERED_ROWS} rows per list</p></header><nav><h2>Running dashboards</h2><ul>${nav}</ul></nav>
 ${selected==='factorio'?`<section><h2>Game controls</h2><button id="pause">Pause mutations</button><button id="resume">Resume mutations</button><span id="control-result"></span><p>Join 127.0.0.1:34197 · scripted characters near spawn (0, 0)</p></section>`:''}
 <main><section><h2>Participants (${participants.length} / ${snap.participants.length})</h2><ul>${participants.map(p=>`<li>${esc(p.name)} · ${esc(p.tool)} · ${esc(p.focus)}</li>`).join('')}</ul></section>
 <section><h2>Tasks (${tasks.length} / ${snap.tasks.length})</h2><ul>${tasks.map(t=>`<li><b>${esc(t.id)}</b> ${esc(t.status)} ${esc(t.assignee)} · ${esc(t.title)} ${esc(t.result)}</li>`).join('')}</ul></section>
 <section><h2>Reservations (${reservations.length} / ${snap.reservations.length})</h2><ul>${reservations.map(r=>`<li>${esc(r.path)} · ${esc(r.holder)}</li>`).join('')}</ul></section>
 <section><h2>Live messages (${messages.length} / ${snap.messages.length})</h2><ul>${messages}</ul></section></main>`;
 for(const [id,paused] of [['pause',true],['resume',false]] as const){document.getElementById(id)?.addEventListener('click',async()=>{
  const out=document.getElementById('control-result')!;out.textContent='Sending…';try{const r=await fetch('/control',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({paused})});out.textContent=JSON.stringify(await r.json())}catch(e){out.textContent=String(e)}
 })}
}
for(const id of Object.keys(databases) as BoardId[]){
 const key=`qs-local-${id}-token`;
 clients[id]=new MessageBoardClient({uri,database:databases[id],token:localStorage.getItem(key)??undefined,onToken:t=>localStorage.setItem(key,t),historyWindowMs:HISTORY_WINDOW_MS,onChange:render});
 clients[id].start();
}
render();

import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer } from 'node:net';
const chrome=process.env.CHROME_PATH??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const port=await new Promise<number>((done,reject)=>{const s=createServer();s.on('error',reject);s.listen(0,'127.0.0.1',()=>{const a=s.address();const p=typeof a==='object'&&a?a.port:0;s.close(()=>done(p));});});
mkdirSync('.runtime',{recursive:true});const profile=mkdtempSync(resolve('.runtime','browser-test-'));
const child=spawn(chrome,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-extensions',`--user-data-dir=${profile}`,`--remote-debugging-port=${port}`,'--remote-debugging-address=127.0.0.1','about:blank'],{stdio:'ignore',detached:true});
let ws:WebSocket|undefined;let identity:string|undefined;
const cli=process.env.SPACETIME_CLI??'spacetime';const runId=process.env.GAME_RUN_ID??'minecraft-pilot';const db=process.env.GAME_DB??'quant-swarm-games';
function call(reducer:string,args:string[]){execFileSync(cli,['call','--server','local',db,reducer,...args.map(a=>JSON.stringify(a))],{stdio:['ignore','pipe','pipe']});}
try{
  let target:{webSocketDebuggerUrl:string}|undefined;const deadline=Date.now()+15000;
  while(!target){try{const tabs=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json() as {type:string;webSocketDebuggerUrl:string}[];target=tabs.find(t=>t.type==='page');}catch{}if(Date.now()>deadline)throw new Error('Chrome debugging port did not start');await new Promise(r=>setTimeout(r,100));}
  ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise<void>((done,reject)=>{ws!.onopen=()=>done();ws!.onerror=reject;});
  let next=0;const pending=new Map<number,{done:(value:any)=>void;reject:(error:Error)=>void}>();
  ws.onmessage=event=>{const value=JSON.parse(String(event.data));if(value.method==='Runtime.exceptionThrown')console.log('Browser exception:',value.params.exceptionDetails.exception?.description??value.params.exceptionDetails.text);if(value.id){const request=pending.get(value.id);pending.delete(value.id);if(value.error)request?.reject(new Error(JSON.stringify(value.error)));else request?.done(value.result);}};
  const send=(method:string,params:object={})=>new Promise<any>((done,reject)=>{const id=++next;pending.set(id,{done,reject});ws!.send(JSON.stringify({id,method,params}));});
  const evaluate=async(expression:string)=>(await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true})).result.value;
  await send('Runtime.enable');await send('Page.navigate',{url:'http://127.0.0.1:4175/'});
  let access=''; const accessDeadline=Date.now()+10000;
  while(!access.includes('grant_operator')&&Date.now()<accessDeadline){await new Promise(r=>setTimeout(r,300));access=await evaluate("document.getElementById('access')?.textContent ?? ''") as string;}
  identity=/grant_operator minecraft-pilot ([a-f0-9]{64}) game-dashboard/.exec(access)?.[1];
  if(!identity)console.log('Browser connection state:',await evaluate("document.getElementById('connection')?.textContent"));
  assert.ok(identity,'Fresh browser must show grant instructions and no rows');
  assert.equal(await evaluate("document.querySelectorAll('#agents .card').length"),0);
  call('grant_operator',[runId,identity!,`browser-${Date.now()}`]);
  await new Promise(r=>setTimeout(r,500));
  assert.ok((await evaluate("document.getElementById('summary').textContent") as string).includes('model calls'));
  assert.equal(await evaluate("document.getElementById('pause').disabled"),false);
  await evaluate("document.getElementById('pause').click()");await new Promise(r=>setTimeout(r,300));
  assert.ok((await evaluate("document.getElementById('summary').textContent") as string).startsWith('paused'));
  await evaluate("document.getElementById('resume').click()");await new Promise(r=>setTimeout(r,300));
  assert.ok((await evaluate("document.getElementById('summary').textContent") as string).startsWith('active'));
  call('revoke_member',[runId,identity!]);await new Promise(r=>setTimeout(r,300));
  assert.equal(await evaluate("document.querySelectorAll('#agents .card').length"),0);
  console.log('PASS real Chrome: ungranted isolation, live operator grant, run display, pause/resume and revocation');
}finally{
  if(identity){try{call('set_run_status',[runId,'active']);call('revoke_member',[runId,identity]);}catch{}}
  ws?.close();try{process.kill(-child.pid!,'SIGTERM');}catch{}
  await new Promise(r=>setTimeout(r,500));try{process.kill(-child.pid!,'SIGKILL');}catch{}
  rmSync(profile,{recursive:true,force:true});
}

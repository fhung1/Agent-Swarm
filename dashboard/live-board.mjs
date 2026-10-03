import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
const world=process.env.FACTORIO_WORLD;
await build({entryPoints:['dashboard/live-board.ts'],bundle:true,platform:'browser',format:'esm',outfile:'dashboard/dist/live-board.js'});
const html=`<!doctype html><html><head><meta charset="utf-8"><title>Quant Swarm boards</title><style>body{font:15px system-ui;max-width:1100px;margin:24px auto;padding:0 16px;background:#101b1c;color:#e1efea}a{color:#86d8f8}small{color:#a6b9b4}section,nav{border:1px solid #52706a;border-radius:8px;padding:12px;margin:12px 0}main{display:grid;grid-template-columns:1fr 1fr;gap:12px}ul{padding-left:20px;max-height:42vh;overflow:auto}li{margin:5px 0;overflow-wrap:anywhere}.live{color:#9eed98}.offline{color:#e7ac8d}button{padding:8px;margin-right:8px}@media(max-width:750px){main{display:block}}</style></head><body><div id="app">Connecting…</div><script type="module" src="/app.js"></script></body></html>`;
const server=createServer((req,res)=>{
 if(req.method==='POST'&&req.url==='/control'){
  if(!world){res.writeHead(503);res.end(JSON.stringify({error:'World unavailable'}));return}
  let body='';req.on('data',x=>body+=x);req.on('end',()=>{try{
   const {paused}=JSON.parse(body);if(typeof paused!=='boolean')throw Error('Invalid pause flag');
   const py=`import json,pathlib,sys;sys.path.insert(0,'factorio');from status import call;print(json.dumps(call(pathlib.Path(sys.argv[1]),'control',[sys.argv[2]=='true'])))`;
   const output=execFileSync('python3',['-c',py,world,String(paused)],{encoding:'utf8',timeout:10000});
   res.writeHead(200,{'content-type':'application/json'});res.end(output);
  }catch(e){res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({error:String(e)}))}});return;
 }
 if(req.url==='/app.js'){res.writeHead(200,{'content-type':'text/javascript'});res.end(readFileSync('dashboard/dist/live-board.js'));return}
 res.writeHead(200,{'content-type':'text/html'});res.end(html);
});
server.listen(Number(process.env.DASHBOARD_PORT??4174),'127.0.0.1',()=>console.log(`Board dashboard http://127.0.0.1:${process.env.DASHBOARD_PORT??4174}/?board=factorio`));

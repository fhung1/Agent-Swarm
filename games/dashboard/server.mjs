import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const files={'/':['./index.html','text/html'],'/style.css':['./style.css','text/css'],'/app.js':['../dist/dashboard.js','text/javascript']};
createServer((request,response)=>{
  const target=files[new URL(request.url??'/', 'http://localhost').pathname];
  if(!target){response.writeHead(404);response.end();return;}
  // SDK 2.10.2 compiles binary deserializers with Function; local trusted bundle needs unsafe-eval.
  try{response.writeHead(200,{'Content-Type':target[1],'Cache-Control':'no-store','Content-Security-Policy':"default-src 'self'; connect-src 'self' ws://127.0.0.1:3000; style-src 'self'; script-src 'self' 'unsafe-eval'"});response.end(readFileSync(fileURLToPath(new URL(target[0],import.meta.url))));}
  catch{response.writeHead(503);response.end('Build the games package first');}
}).listen(4175,'127.0.0.1',()=>console.log('Minecraft dashboard: http://127.0.0.1:4175'));

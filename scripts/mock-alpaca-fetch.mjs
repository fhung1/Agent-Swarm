// Loaded only by check-executor.ts. Every HTTP request is intercepted; no broker network access is possible.
import { readFileSync, writeFileSync } from 'node:fs';
import { MockAgent, setGlobalDispatcher } from 'undici';
// The executor stream now uses undici; prevent its fixture credentials from leaving this process.
const dispatcher = new MockAgent();
dispatcher.disableNetConnect();
dispatcher.enableNetConnect(host => /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host));
setGlobalDispatcher(dispatcher);
const file=process.env.MOCK_ALPACA_STATE;
if(!file)throw new Error('Mock broker state path required');
const localFetch=globalThis.fetch;
const databaseOrigin=new URL((process.env.SPACETIMEDB_HOST??'ws://127.0.0.1:3000').replace(/^ws/,'http')).origin;
globalThis.fetch=async(input,options={})=>{
  const url=new URL(String(input));const state=JSON.parse(readFileSync(file,'utf8'));
  if(url.origin===databaseOrigin&&['127.0.0.1','localhost'].includes(url.hostname))return localFetch(input,{...options,redirect:'error'});
  if(url.origin!=='https://paper-api.alpaca.markets')throw new Error('Mock broker denied external origin');
  const headers=new Headers(options.headers);
  if(headers.get('APCA-API-KEY-ID')!=='fixture-key'||headers.get('APCA-API-SECRET-KEY')!=='fixture-secret')throw new Error('Mock broker requires fake credentials');
  const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
  const order=()=>state.order?{...state.order,filled_qty:String(state.filled),status:state.filled===2?'filled':'partially_filled'}:undefined;
  const method=options.method??'GET';
  if(method==='POST'&&url.pathname==='/v2/orders'){
    state.posts++;state.order={...JSON.parse(options.body),id:'00000000-0000-4000-8000-000000000001',created_at:new Date().toISOString()};state.filled=0.5;
    writeFileSync(file,JSON.stringify(state));
    throw new TypeError('Synthetic transport loss AFTER broker accepted order');
  }
  if(method!=='GET')throw new Error(`Unexpected mock mutation ${method}`);
  if(url.pathname==='/v2/account')return json({id:state.accountId,status:'ACTIVE',cash:String(1000-state.filled*100+(state.cashDrift??0)),buying_power:'1000',equity:'1000',trading_blocked:false});
  if(url.pathname==='/v2/positions')return json(state.filled?[{symbol:'QMOCK',qty:String(state.filled),market_value:String(state.filled*100)}]:[]);
  if(url.pathname==='/v2/orders')return json([...(state.order&&state.filled<2?[order()]:[]),...(state.externalOrder?[{id:'external',client_order_id:'manual-order',symbol:'QMOCK',side:'buy',qty:'1',filled_qty:'0'}]:[])]);
  if(url.pathname==='/v2/orders:by_client_order_id')return state.order&&url.searchParams.get('client_order_id')===state.order.client_order_id?json(order()):json({},404);
  if(url.pathname===`/v2/orders/${state.order?.id}`)return json(order());
  if(url.pathname==='/v2/account/activities/FILL')return json(state.order?[{id:'mock-partial',order_id:state.order.id,activity_type:'FILL',qty:'0.5',price:'100',transaction_time:state.order.created_at},...(state.filled===2?[{id:'mock-rest',order_id:state.order.id,activity_type:'FILL',qty:'1.5',price:'100',transaction_time:new Date().toISOString()}]:[])]:[]);
  throw new Error(`Mock broker denied route ${url.pathname}`);
};

import { connectBot,observe } from '../src/minecraft.ts';
import { connectDatabase,DATABASE } from '../src/database.ts';
import { execFileSync } from 'node:child_process';
const name=process.argv[2];if(!name)throw new Error('Usage: inspect qs-agent-N [--resolve-stopped]');
const conn=await connectDatabase(name);const bot=await connectBot(name);
try{
  const state=observe(bot);console.log(JSON.stringify({name,position:state.position,inventory:state.inventory}));
  if(process.argv.includes('--resolve-stopped'))for(const action of conn.db.myAction.iter()){
    if(!action.actor.equals(conn.identity!)||!['started','uncertain'].includes(action.status))continue;
    const evidence=JSON.stringify({reason:'Stopped bounded collection inspected after worker exit; partial effects retained; next intent must use current state',position:state.position,inventory:state.inventory});
    execFileSync(process.env.SPACETIME_CLI??'spacetime',['call','--server','local',DATABASE,'resolve_action',...[''+action.id,'failed',evidence].map(v=>JSON.stringify(v))],{stdio:['ignore','pipe','pipe']});
    console.log(`Resolved stopped action ${action.id} with observed inventory; no action replay`);
  }
}finally{bot.quit();conn.disconnect();}

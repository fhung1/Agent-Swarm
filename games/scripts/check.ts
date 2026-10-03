import assert from 'node:assert/strict';
import { connectBot, observe, execute } from '../src/minecraft.ts';
import { connectDatabase } from '../src/database.ts';
const seconds=Number(process.env.MC_CHECK_SECONDS??600);
const count=Number(process.env.GAME_AGENT_COUNT??10);
if(!Number.isFinite(seconds)||seconds<1||seconds>3600||!Number.isInteger(count)||count<1||count>10)throw new Error('Invalid check limits');
const bots=[];
try{
  for(let i=1;i<=count;i++){const bot=await connectBot(`qs-agent-${i}`);bots.push(bot);console.log(`Connected ${bot.username} at ${JSON.stringify(observe(bot).position)}`);}
  let disconnected=false;for(const bot of bots)bot.once('end',()=>{disconnected=true;});
  const deadline=Date.now()+seconds*1000;
  while(Date.now()<deadline){assert.equal(disconnected,false,'Bot disconnected');await new Promise(r=>setTimeout(r,1000));}
  console.log(`PASS: ${count} real Mineflayer bots connected for ${seconds}s on Minecraft 1.21.11`);
  if(process.env.MC_CHECK_CRAFT==='1'){
    const bot=bots[0];await execute(bot,{kind:'collect',block:'oak_log',count:5});
    await execute(bot,{kind:'craft',item:'oak_planks',count:1});await execute(bot,{kind:'craft',item:'crafting_table',count:1});
    assert.ok(bot.inventory.items().some(i=>i.name==='crafting_table'));
    console.log('PASS: collected five local oak logs and crafted a crafting table');
  }
  const outsider=await connectDatabase('ungranted-check');
  assert.equal([...outsider.db.myRun.iter()].length,0);assert.equal([...outsider.db.myMessage.iter()].length,0);outsider.disconnect();
  console.log('PASS: ungranted database identity sees no game state');
}finally{for(const bot of bots)bot.quit();}

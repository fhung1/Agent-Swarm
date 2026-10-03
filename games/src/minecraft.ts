import mineflayer, { type Bot } from 'mineflayer';
import pathfinderPackage from 'mineflayer-pathfinder';
import collectBlockPackage from 'mineflayer-collectblock';
import { Vec3 } from 'vec3';
import type { CommandValue } from './commands.ts';
const { pathfinder, Movements, goals }=pathfinderPackage;
const collectBlock=collectBlockPackage.plugin;

export async function connectBot(username:string):Promise<Bot> {
  const bot=mineflayer.createBot({host:'127.0.0.1',port:Number(process.env.MC_PORT??25565),username,auth:'offline',version:'1.21.11',hideErrors:true});
  bot.on('error',error=>console.error('Minecraft:',error.message));
  await new Promise<void>((resolve,reject)=>{
    const timer=setTimeout(()=>{bot.quit();reject(new Error('Minecraft spawn timeout'));},60000);
    bot.once('spawn',()=>{clearTimeout(timer);resolve();});
    bot.once('kicked',reason=>{clearTimeout(timer);reject(new Error(`Minecraft kicked: ${String(reason)}`));});
    bot.once('end',()=>{clearTimeout(timer);reject(new Error('Minecraft disconnected before spawn'));});
  });
  await bot.waitForChunksToLoad();
  bot.loadPlugin(pathfinder);bot.loadPlugin(collectBlock);
  const movement=new Movements(bot);movement.canDig=false;movement.allow1by1towers=false;
  bot.pathfinder.setMovements(movement);
  bot.collectBlock.movements=movement;
  return bot;
}
export function observe(bot:Bot) {
  const p=bot.entity.position;
  const definitions=Object.values(bot.registry.blocksByName);
  const groups:[RegExp,number][]=[[/log$/,16],[/ore$/,16],[/chest$|crafting_table$|barrel$/,8],[/^stone$|^cobblestone$/,8],[/^water$|^lava$/,4]];
  const blocks=groups.flatMap(([pattern,count])=>bot.findBlocks({matching:definitions.filter(b=>pattern.test(b.name)).map(b=>b.id),maxDistance:16,count}))
    .map(position=>({name:bot.blockAt(position)?.name??'unknown',position:[position.x,position.y,position.z]}));
  return {position:[p.x,p.y,p.z],health:bot.health,food:bot.food,inventory:bot.inventory.items().map(i=>({name:i.name,count:i.count})),
    blocks,entities:Object.values(bot.entities).filter(e=>e.id!==bot.entity.id&&e.position.distanceTo(p)<=16).slice(0,20).map(e=>({id:e.id,name:e.username??e.name,position:[e.position.x,e.position.y,e.position.z]})),time:bot.time.timeOfDay};
}
function nearby(bot:Bot,p:{x:number;y:number;z:number},radius=16) { const target=new Vec3(p.x,p.y,p.z);if(bot.entity.position.distanceTo(target)>radius)throw new Error('Target exceeds local radius');return target; }
function item(bot:Bot,name:string) { const i=bot.inventory.items().find(i=>i.name===name);if(!i)throw new Error(`No ${name} in inventory`);return i; }
async function go(bot:Bot,p:Vec3) { await bot.pathfinder.goto(new goals.GoalNear(p.x,p.y,p.z,2)); }
const activeCommands=new WeakMap<Bot,AbortController>();
export function stop(bot:Bot) { activeCommands.get(bot)?.abort();bot.pathfinder.stop();void bot.collectBlock.cancelTask().catch(()=>{});bot.stopDigging();bot.clearControlStates(); }
export async function execute(bot:Bot,command:CommandValue):Promise<string> {
  const abort=new AbortController();activeCommands.set(bot,abort);
  let timer:NodeJS.Timeout|undefined;
  const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{stop(bot);reject(new Error('Command timeout (30s)'));},30000);});
  const work=async()=>{
    switch(command.kind){
      case 'wait':await new Promise(resolve=>setTimeout(resolve,command.seconds*1000));break;
      case 'move':await go(bot,nearby(bot,command.position));break;
      case 'collect':{
        const type=bot.registry.blocksByName[command.block];if(!type)throw new Error('Unknown block');
        for(let i=0;i<command.count;i++){
          if(abort.signal.aborted)throw new Error('Collection stopped; inspect current inventory before the next command');
          const block=bot.findBlock({matching:type.id,maxDistance:16});if(!block)throw new Error(`No local ${command.block}`);
          nearby(bot,block.position);await bot.collectBlock.collect(block);
          if(abort.signal.aborted || bot.blockAt(block.position)?.type===block.type)throw new Error('Collection interrupted before target was mined');
        }break;
      }
      case 'craft':{
        const type=bot.registry.itemsByName[command.item];if(!type)throw new Error('Unknown item');
        const table=bot.findBlock({matching:bot.registry.blocksByName.crafting_table.id,maxDistance:4});
        const recipe=bot.recipesFor(type.id,null,command.count,table??null)[0];if(!recipe)throw new Error('No craftable recipe/materials');
        await bot.craft(recipe,command.count,table??undefined);break;
      }
      case 'equip':await bot.equip(item(bot,command.item),'hand');break;
      case 'eat':await bot.equip(item(bot,command.item),'hand');await bot.consume();break;
      case 'place':{
        const p=nearby(bot,command.position,4).floored();const support=bot.blockAt(p.offset(0,-1,0));
        if(!support || support.boundingBox==='empty' || bot.blockAt(p)?.name!=='air')throw new Error('Placement needs solid support and empty target');
        await bot.equip(item(bot,command.item),'hand');await bot.placeBlock(support,new Vec3(0,1,0));break;
      }
      case 'attack':{
        const target=bot.entities[command.entityId];if(!target||target.position.distanceTo(bot.entity.position)>3)throw new Error('Entity not in attack range');bot.attack(target);break;
      }
      case 'chest':{
        const p=nearby(bot,command.position,4);const block=bot.blockAt(p);if(!block||!['chest','trapped_chest','barrel'].includes(block.name))throw new Error('No local container');
        const type=bot.registry.itemsByName[command.item];if(!type)throw new Error('Unknown item');
        const chest=await bot.openContainer(block);try { if(command.operation==='deposit')await chest.deposit(type.id,null,command.count);else await chest.withdraw(type.id,null,command.count); }finally{chest.close();}break;
      }
      case 'give':{
        const target=Object.values(bot.entities).find(e=>e.username===command.recipient);if(!target||target.position.distanceTo(bot.entity.position)>3)throw new Error('Recipient not nearby');
        await bot.lookAt(target.position.offset(0,1,0));const i=item(bot,command.item);if(i.count<command.count)throw new Error('Insufficient items');await bot.toss(i.type,null,command.count);break;
      }
      default:throw new Error('Sharing commands must go through SpacetimeDB');
    }
    return JSON.stringify({ok:true,command:command.kind,state:observe(bot)});
  };
  const job=work();
  try{return await Promise.race([job,deadline]);}
  catch(error){
    if(String(error).includes('Command timeout') && ['collect','move','wait'].includes(command.kind)){
      let settled=false;
      await Promise.race([job.then(()=>{settled=true;},()=>{settled=true;}),new Promise(r=>setTimeout(r,2000))]);
      if(settled)throw new Error(`Command stopped at the 30-second limit; current observed state: ${JSON.stringify(observe(bot))}`);
    }
    throw error;
  }finally{if(timer)clearTimeout(timer);activeCommands.delete(bot);}
}

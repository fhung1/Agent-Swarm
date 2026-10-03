import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DbConnection } from './module_bindings/index.ts';
export const DATABASE=process.env.GAME_DB??'quant-swarm-games';
export const HOST=process.env.SPACETIMEDB_HOST??'ws://127.0.0.1:3000';
export async function connectDatabase(name:string,subscribe=true):Promise<DbConnection> {
  if(!/^[a-z0-9][a-z0-9-]{0,40}$/.test(name))throw new Error('Invalid worker name');
  const file=resolve('.tokens',`${name}.token`);mkdirSync(dirname(file),{recursive:true,mode:0o700});
  return await new Promise((done,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Database connection timeout')),15000);
    DbConnection.builder().withUri(HOST).withDatabaseName(DATABASE).withToken(existsSync(file)?readFileSync(file,'utf8'):undefined)
      .onConnect((conn,identity,token)=>{
        writeFileSync(file,token,{mode:0o600});console.log(`${name} identity ${identity.toHexString()}`);
        if(!subscribe){clearTimeout(timer);done(conn);return;}
        conn.subscriptionBuilder().onApplied(()=>{clearTimeout(timer);done(conn);}).onError(ctx=>{clearTimeout(timer);reject(new Error(`Game subscription failed: ${String(ctx)}`));conn.disconnect();})
          .subscribe(['SELECT * FROM my_game_run','SELECT * FROM my_game_member','SELECT * FROM my_game_message','SELECT * FROM my_game_knowledge','SELECT * FROM my_game_action','SELECT * FROM my_game_inference']);
      }).onConnectError((_ctx,error)=>{clearTimeout(timer);reject(error);}).build();
  });
}

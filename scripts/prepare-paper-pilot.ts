import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { credentialsFromEnv, getAccount, object, textField } from '../src/alpaca-client.ts';
import { parseSwarmConfig } from '../src/swarm-plan.ts';

// A single paper-only GET discovers the account ID; keys remain in the launching environment.
const file=resolve('config/swarm.json');const exists=existsSync(file);
const config=JSON.parse(readFileSync(exists?file:resolve('config/swarm.example.json'),'utf8'));
const account=object(await getAccount(credentialsFromEnv()),'paper account');const accountId=textField(account,'id');
if(account.status!=='ACTIVE'||account.trading_blocked===true)throw new Error('Paper account is inactive or trading blocked');
if(config.accountId&&config.accountId!==accountId)throw new Error('Existing config targets another account; inspect it before changing accounts');
config.accountId=accountId;
if(!exists)for(const role of ['analyst','skeptic','coordinator']){config.agents[role].brain='codex';config.agents[role].model='gpt-6-astra';config.agents[role].effort='medium';}
parseSwarmConfig(JSON.stringify(config));
writeFileSync(file,JSON.stringify(config,null,2)+'\n',{mode:0o600});
console.log('Prepared ignored config/swarm.json for the active paper account. Credentials were not written.');
console.log('Next: npm run swarm -- plan; npm run swarm -- register; npm run swarm -- grants --apply; npm run swarm -- up');

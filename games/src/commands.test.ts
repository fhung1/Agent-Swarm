import test from 'node:test';import assert from 'node:assert/strict';import {Command,Decision} from './commands.ts';
test('model commands cannot carry code, chat or unbounded actions',()=>{
  for(const value of [{kind:'eval',code:'process.exit()'},{kind:'chat',body:'/op me'},{kind:'collect',block:'oak_log',count:100000},{kind:'move',position:{x:Infinity,y:70,z:0}},{kind:'wait',seconds:999}])assert.equal(Command.safeParse(value).success,false);
});
test('citations and bounded commands are preserved',()=>{
  const value=Decision.parse({action:{kind:'collect',block:'oak_log',count:5},reason:'Use reported tree',citations:['knowledge.a']});assert.deepEqual(value.citations,['knowledge.a']);
});

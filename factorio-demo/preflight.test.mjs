import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import dgram from 'node:dgram';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { availablePort, reachable, preflight } from './preflight.mjs';

test('preflight detects occupied TCP and UDP ports and releases probes', async () => {
  const tcp = net.createServer();
  await new Promise(resolve => tcp.listen(0, '127.0.0.1', resolve));
  const udp = dgram.createSocket('udp4');
  await new Promise(resolve => udp.bind(0, '127.0.0.1', resolve));
  const tcpPort=tcp.address().port, udpPort=udp.address().port;
  try {
    assert.equal((await availablePort(tcpPort, 'tcp')).ok, false);
    assert.equal((await availablePort(udpPort, 'udp')).ok, false);
    assert.equal(await reachable('127.0.0.1', tcpPort), true);
  } finally { await Promise.all([new Promise(r => tcp.close(r)), new Promise(r => udp.close(r))]); }
  assert.equal((await availablePort(tcpPort, 'tcp')).ok, true);
  assert.equal((await availablePort(udpPort, 'udp')).ok, true);
  assert.equal(await reachable('127.0.0.1', tcpPort), false);
});
test('missing configuration fails clearly; invalid ports never bind and development board is refused', async () => {
  const root=mkdtempSync(join(tmpdir(),'factorio-preflight-test-'));
  try {
    assert.equal((await preflight({root})).checks[0].ok,false);
    writeFileSync(join(root,'config.json'), JSON.stringify({version:'2.0.77',agentCount:10,scenario:'cooperative-starter',boardDatabase:'quant-swarm-coord',gamePort:-1,rconPort:70000,boardHost:'https://localhost'}));
    const result=await preflight({root,configPath:'config.json',binary:join(root,'absent')});
    assert.equal(result.ok,false);
    for(const name of ['board-isolation','binary','gamePort','rconPort','board-host']) assert.equal(result.checks.find(c=>c.name===name).ok,false,name);
  } finally {rmSync(root,{recursive:true,force:true});}
});

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test, type TestContext } from 'node:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecClient, requireSecUrl } from './sec-client.ts';

const url = 'https://data.sec.gov/submissions/CIK0000320193.json';
const filing = 'https://www.sec.gov/Archives/edgar/data/320193/000032019326000001/aapl.htm';
const contact = 'Quant Swarm test@example.com';
const json = '{"company":"fixture","value":"é"}\n';

function fixture(t: TestContext, fetcher: typeof fetch) {
  const directory = mkdtempSync(join(tmpdir(), 'sec-cache-test-'));
  const cacheDir = join(directory,'cache'); mkdirSync(cacheDir);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let time = 1_800_000_000_000;
  const sleeps: number[] = [];
  const starts: number[] = [];
  const events: string[] = [];
  const options = { userAgent: contact, cacheDir, rateDir:join(directory,'rate'), now: () => time,
    sleep: async (ms: number) => { sleeps.push(ms); time += ms; },
    fetch: (async (input, init) => { starts.push(time); return fetcher(input, init); }) as typeof fetch,
    onEvent: (event: { kind: string }) => { events.push(event.kind); },
  };
  return { client: new SecClient(options), options, cacheDir, sleeps, starts, events, advance: (ms: number) => { time += ms; } };
}

test('SEC transport allows only the ingestor HTTPS routes and requires a contact', () => {
  for (const allowed of [url, filing, 'https://www.sec.gov/files/company_tickers.json',
    'https://data.sec.gov/api/xbrl/companyfacts/CIK0000320193.json']) requireSecUrl(allowed);
  for (const denied of ['http://data.sec.gov/submissions/CIK0000320193.json', `${url}?token=x`, `${url}#x`,
    'https://data.sec.gov.evil.test/submissions/CIK0000320193.json', 'https://data.sec.gov@evil.test/submissions/CIK0000320193.json',
    'https://www.sec.gov/Archives/edgar/data/../../other.htm', 'https://data.sec.gov/submissions/CIKx.json']) {
    assert.throws(() => requireSecUrl(denied), /allow-listed/);
  }
  assert.throws(() => new SecClient({ userAgent: 'no contact', cacheDir: '/unused' }), /contact email/);
});

test('fresh cache preserves exact bytes across client restart and deduplicates concurrent requests', async t => {
  let count = 0;
  const f = fixture(t, async (_input, init) => {
    count++;
    assert.equal(init?.method, 'GET');
    assert.equal(init?.redirect, 'error');
    assert.equal(new Headers(init?.headers).get('user-agent'), contact);
    assert(init?.signal);
    return new Response(json, { headers: { etag: '"v1"' } });
  });
  const [left, right] = await Promise.all([f.client.get(url), f.client.get(url)]);
  assert.deepEqual(left, Buffer.from(json));
  assert.deepEqual(right, left);
  assert.deepEqual(await new SecClient(f.options).get(url), left);
  assert.equal(count, 1);
  const file = join(f.cacheDir, readdirSync(f.cacheDir)[0]);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(f.events, ['download', 'hit']);
});

test('expired response uses validators, 304 keeps bytes and advances validation time', async t => {
  let count = 0;
  const f = fixture(t, async (_input, init) => {
    count++;
    if (count === 1) return new Response(json, { headers: { etag: '"v1"', 'last-modified': 'Fri, 02 Oct 2026 12:00:00 GMT' } });
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('if-none-match'), '"v1"');
    assert.equal(headers.get('if-modified-since'), 'Fri, 02 Oct 2026 12:00:00 GMT');
    return new Response(null, { status: 304 });
  });
  await f.client.get(url);
  f.advance(300_000);
  assert.deepEqual(await f.client.get(url), Buffer.from(json));
  await f.client.get(url);
  assert.equal(count, 2);
  assert.deepEqual(f.events, ['download', 'revalidated', 'hit']);
});

test('filing cache has bounded 24-hour lifetime and updated bytes replace expired cache', async t => {
  let count = 0;
  const f = fixture(t, async () => new Response(++count === 1 ? '<p>Original</p>' : '<p>Updated</p>'));
  await f.client.get(filing, 'text/html');
  f.advance(300_000);
  assert.equal((await f.client.get(filing, 'text/html')).toString(), '<p>Original</p>');
  f.advance(86_400_000);
  assert.equal((await f.client.get(filing, 'text/html')).toString(), '<p>Updated</p>');
  assert.equal(count, 2);
});

test('transient responses retry at most three times and honor Retry-After', async t => {
  let count = 0;
  const f = fixture(t, async () => {
    count++;
    if (count === 1) return new Response('busy', { status: 429, headers: { 'retry-after': '2' } });
    if (count === 2) return new Response('unavailable', { status: 503 });
    return new Response(json);
  });
  assert.deepEqual(await f.client.get(url), Buffer.from(json));
  assert.equal(count, 3);
  assert.deepEqual(f.sleeps.filter(ms=>ms>200), [2000, 1000]);
});

test('date Retry-After is respected and a delay beyond the retry budget fails immediately', async t => {
  let count = 0;
  const f = fixture(t, async () => {
    count++;
    return count === 1 ? new Response('busy', { status: 503, headers: {
      'retry-after': new Date(f.options.now() + 3000).toUTCString(),
    } }) : new Response(json);
  });
  await f.client.get(url);
  // HTTP-date precision is one second; the first gate's 200ms have already elapsed.
  assert.deepEqual(f.sleeps.filter(ms=>ms>200), [2800]);
  const long = fixture(t, async () => new Response('busy', { status: 429, headers: { 'retry-after': '120' } }));
  await assert.rejects(long.client.get(url), /exceeds 30-second/);
  assert.equal(long.starts.length, 1);
  assert.deepEqual(long.sleeps, [200]);
});

test('network and body failures are bounded; expired cache is never an outage fallback', async t => {
  let available = true;
  const f = fixture(t, async () => {
    if (available) return new Response(json);
    throw new TypeError('connection reset');
  });
  await f.client.get(url);
  available = false;
  f.advance(300_000);
  await assert.rejects(f.client.get(url), /after 3 attempts/);
  assert.equal(f.starts.length, 4);
  assert.deepEqual(f.sleeps.filter(ms=>ms>200), [500, 1000]);
  const body = fixture(t, async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error('body reset')); } })));
  await assert.rejects(body.client.get(url), /after 3 attempts/);
  assert.equal(body.starts.length, 3);
  assert.deepEqual(readdirSync(body.cacheDir), []);
});

test('permanent HTTP errors and malformed successes are never cached or retried', async t => {
  for (const response of [new Response('forbidden', { status: 403 }), new Response('not found', { status: 404 }),
    new Response('<html>bot restriction</html>'), new Response('null'), new Response('[]'), new Response('')]) {
    const f = fixture(t, async () => response);
    await assert.rejects(f.client.get(url));
    assert.equal(f.starts.length, 1);
    assert.deepEqual(readdirSync(f.cacheDir), []);
  }
});

test('corruption invalidates the cache and removes its conditional validators', async t => {
  let count = 0;
  const f = fixture(t, async (_input, init) => {
    count++;
    assert.equal(new Headers(init?.headers).get('if-none-match'), null);
    return new Response(json, { headers: { etag: '"v1"' } });
  });
  await f.client.get(url);
  const file = join(f.cacheDir, readdirSync(f.cacheDir)[0]);
  const cached = JSON.parse(readFileSync(file, 'utf8'));
  cached.body = Buffer.from('corrupt').toString('base64');
  writeFileSync(file, JSON.stringify(cached));
  assert.deepEqual(await f.client.get(url), Buffer.from(json));
  assert.equal(count, 2);
  assert(f.events.includes('invalid-cache'));
});

test('simultaneous distinct URLs still respect the 200ms request-start spacing', async t => {
  const f = fixture(t, async () => new Response(json));
  await Promise.all([f.client.get(url), f.client.get('https://www.sec.gov/files/company_tickers.json')]);
  assert.equal(f.starts[1] - f.starts[0], 200);
});

test('real local HTTP fixture recovers from 503 then revalidates saved bytes after restart', async t => {
  let count = 0;
  const server = createServer((request, response) => {
    count++;
    assert.equal(request.method, 'GET');
    assert.equal(request.headers['user-agent'], contact);
    if (count === 1) { response.writeHead(503, { 'retry-after': '0' }); response.end('busy'); }
    else if (request.headers['if-none-match'] === '"fixture"') { response.writeHead(304); response.end(); }
    else { response.writeHead(200, { etag: '"fixture"' }); response.end(json); }
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise<void>((done, reject) => { server.close(error => error ? reject(error) : done()); server.closeAllConnections(); }));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const f = fixture(t, async (_input, init) => fetch(`http://127.0.0.1:${address.port}/fixture`, init));
  assert.deepEqual(await f.client.get(url), Buffer.from(json));
  f.advance(300_000);
  assert.deepEqual(await new SecClient(f.options).get(url), Buffer.from(json));
  assert.equal(count, 3);
});

test('two independent processes with different caches share one request gate', {timeout:10000},async t=>{
  const directory=mkdtempSync(join(tmpdir(),'sec-rate-process-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const moduleUrl=new URL('./sec-client.ts',import.meta.url).href;
  const starts=await Promise.all([0,1].map(index=>new Promise<number>((done,reject)=>{
    const script=`import {SecClient} from ${JSON.stringify(moduleUrl)};
      const client=new SecClient({userAgent:${JSON.stringify(contact)},cacheDir:${JSON.stringify(join(directory,`cache-${index}`))},
        rateDir:${JSON.stringify(join(directory,'rate'))},fetch:async()=>{console.log(Date.now());return new Response('{"ok":true}')}});
      await client.get(${JSON.stringify(url)});`;
    const child=spawn(process.execPath,['--input-type=module','-e',script],{stdio:['ignore','pipe','pipe']});
    t.after(()=>child.kill('SIGKILL'));
    let output='',errors=''; child.stdout.on('data',chunk=>output+=String(chunk));child.stderr.on('data',chunk=>errors+=String(chunk));
    child.once('error',reject);child.once('close',code=>code===0?done(Number(output.trim())):reject(new Error(errors)));
  })));
  starts.sort((a,b)=>a-b);
  assert(starts.every(Number.isFinite));
  assert(starts[1]-starts[0]>=200,`request spacing was ${starts[1]-starts[0]}ms`);
});

test('a killed process releases the gate without deleting locks or using stale data', {timeout:10000},async t=>{
  const f=fixture(t,async()=>new Response(json));
  const moduleUrl=new URL('./sec-client.ts',import.meta.url).href;
  const script=`import {SecClient} from ${JSON.stringify(moduleUrl)};
    setInterval(()=>{},1000);
    const client=new SecClient({userAgent:${JSON.stringify(contact)},cacheDir:${JSON.stringify(join(f.cacheDir,'killed'))},
      rateDir:${JSON.stringify(f.options.rateDir)},fetch:async()=>{console.log('in-flight');await new Promise(()=>{});}});
    await client.get(${JSON.stringify(url)});`;
  const child=spawn(process.execPath,['--input-type=module','-e',script],{stdio:['ignore','pipe','pipe']});
  t.after(()=>child.kill('SIGKILL'));
  await new Promise<void>((done,reject)=>{
    child.once('error',reject);
    child.once('exit',()=>reject(new Error('Child exited before request')));
    child.stdout.on('data',chunk=>{if(String(chunk).includes('in-flight'))done();});
  });
  const closed=new Promise<void>(done=>child.once('close',()=>done()));
  child.kill('SIGKILL');await closed;
  assert.deepEqual(await f.client.get(url),Buffer.from(json));
  assert.equal(f.starts.length,1);
});

test('an unavailable or corrupt shared gate fails before any HTTP request',async t=>{
  const f=fixture(t,async()=>new Response(json));
  mkdirSync(f.options.rateDir);
  writeFileSync(join(f.options.rateDir,'gate.sqlite'),'invalid database');
  await assert.rejects(f.client.get(url),/shared rate gate unavailable/);
  assert.equal(f.starts.length,0);
});

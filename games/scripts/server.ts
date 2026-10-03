import { createHash } from 'node:crypto';
import { mkdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const runtime = join(root, '.runtime');
const version = '1.21.11';
const server = join(runtime, 'minecraft');
const javaDir = join(runtime, 'java');
const java = process.env.MC_JAVA ?? join(javaDir, 'Contents/Home/bin/java');
async function download(url: string, file: string, hash: string, algorithm = 'sha256') {
  if (existsSync(file) && createHash(algorithm).update(readFileSync(file)).digest('hex') === hash) return;
  const response = await fetch(url, { signal: AbortSignal.timeout(180000) });
  if (!response.ok) throw new Error(`Download failed (${response.status})`);
  const body = Buffer.from(await response.arrayBuffer());
  if (createHash(algorithm).update(body).digest('hex') !== hash) throw new Error('Download checksum mismatch');
  writeFileSync(file, body, { mode: 0o600 });
}
function offlineUuid(name: string) {
  const bytes = createHash('md5').update(`OfflinePlayer:${name}`).digest();
  bytes[6] = (bytes[6] & 15) | 48; bytes[8] = (bytes[8] & 63) | 128;
  const h = bytes.toString('hex'); return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
async function setup() {
  if (!process.argv.includes('--accept-eula')) throw new Error('Owner must accept Minecraft EULA: setup --accept-eula');
  mkdirSync(server, { recursive: true }); mkdirSync(javaDir, { recursive: true });
  if (!existsSync(java)) {
    if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Set MC_JAVA to a Java 21+ executable for this platform');
    const response = await fetch('https://api.adoptium.net/v3/assets/latest/21/hotspot?architecture=aarch64&image_type=jre&os=mac&vendor=eclipse');
    if (!response.ok) throw new Error('Java release metadata unavailable');
    const releases = await response.json() as {binary:{package:{link:string;checksum:string}}}[];
    const pkg = releases[0]?.binary.package; if (!pkg) throw new Error('Java 21 runtime unavailable');
    const archive = join(runtime,'java21.tar.gz'); await download(pkg.link,archive,pkg.checksum);
    execFileSync('tar',['-xzf',archive,'-C',javaDir,'--strip-components=1']);
  }
  const manifest = await (await fetch('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json')).json() as {versions:{id:string;url:string}[]};
  const release = manifest.versions.find(v=>v.id===version); if(!release)throw new Error(`Server ${version} missing`);
  const metadata = await (await fetch(release.url)).json() as {downloads:{server:{url:string;sha1:string}}};
  await download(metadata.downloads.server.url,join(server,'server.jar'),metadata.downloads.server.sha1,'sha1');
  writeFileSync(join(server,'eula.txt'),'eula=true\n');
  if(!existsSync(join(server,'server.properties')))writeFileSync(join(server,'server.properties'),[
    'server-ip=127.0.0.1','server-port=25565','online-mode=false','white-list=true','enforce-whitelist=true',
    'difficulty=peaceful','gamemode=survival','max-players=12','view-distance=6','simulation-distance=4',
    'level-seed=123456','spawn-protection=0','enable-rcon=false','enable-query=false','motd=Quant Swarm private pilot',
  ].join('\n')+'\n');
  const names = Array.from({length:10},(_,i)=>`qs-agent-${i+1}`);
  if(process.env.MC_OPERATOR_NAME) names.push(process.env.MC_OPERATOR_NAME);
  writeFileSync(join(server,'whitelist.json'),JSON.stringify(names.map(name=>({uuid:offlineUuid(name),name})),null,2));
  writeFileSync(join(server,'runtime-manifest.json'),JSON.stringify({version,sha1:metadata.downloads.server.sha1,seed:123456,eulaAccepted:true},null,2));
  console.log(`Minecraft ${version} ready; Java: ${java}; localhost:25565; ten whitelisted bots`);
}
if(process.argv[2]==='setup')await setup();
else if(process.argv[2]==='start') {
  if(!existsSync(join(server,'server.jar')))throw new Error('Run setup --accept-eula first');
  const child=spawn(java,['-Xms512M','-Xmx2G','-jar','server.jar','nogui'],{cwd:server,stdio:['pipe','inherit','inherit']});
  process.stdin.pipe(child.stdin!);
  const stop=()=>{child.stdin?.write('stop\n');setTimeout(()=>child.kill('SIGTERM'),15000).unref();};
  process.on('SIGINT',stop);process.on('SIGTERM',stop);
  child.on('exit',code=>{process.exitCode=code??1;process.stdin.unpipe();process.stdin.pause();});
} else throw new Error('Usage: node scripts/server.ts setup --accept-eula | start');

#!/usr/bin/env python3
"""Pinned, isolated Factorio runtime. Run start in a terminal; Ctrl+C saves/stops."""
import argparse, hashlib, ipaddress, json, os, pathlib, shutil, socket, subprocess, sys, uuid
ROOT = pathlib.Path(__file__).resolve().parents[1]
VERSION = '2.0.77'

def digest_tree(directory):
    h = hashlib.sha256()
    for p in sorted(directory.rglob('*')):
        if p.is_file():
            h.update(str(p.relative_to(directory)).encode()); h.update(p.read_bytes())
    return h.hexdigest()

def binary():
    p = pathlib.Path(os.environ.get('FACTORIO_BIN', pathlib.Path.home()/'.local/share/agent-swarm/factorio'/VERSION/'factorio/bin/x64/factorio')).resolve()
    try: version = subprocess.check_output([str(p), '--version'], text=True, timeout=10).splitlines()[0]
    except (OSError, subprocess.SubprocessError) as e: raise ValueError(f'Missing runtime: run bash factorio/install.sh ({e})')
    if not version.startswith(f'Version: {VERSION} '): raise ValueError(f'Expected {VERSION}, got {version}')
    return p, version

def game_bind(config):
    value=config.get('gameBind','127.0.0.1')
    try: address=ipaddress.ip_address(value)
    except ValueError: raise ValueError('gameBind must be a specific private IPv4 address')
    if address.version!=4 or address.is_unspecified or address.is_multicast or not (any(address in ipaddress.ip_network(network) for network in ['127.0.0.0/8','10.0.0.0/8','172.16.0.0/12','192.168.0.0/16','100.64.0.0/10'])):
        raise ValueError('gameBind must be loopback, private LAN or Tailscale IPv4; public/wildcard binding refused')
    return str(address)

def ports(config):
    for key, kind in [('gamePort',socket.SOCK_DGRAM),('rconPort',socket.SOCK_STREAM)]:
        value=config[key]
        if type(value) is not int or not 1024 <= value <= 65535: raise ValueError(f'Invalid {key}')
        with socket.socket(socket.AF_INET,kind) as s:
            try: s.bind((game_bind(config) if key=='gamePort' else '127.0.0.1',value))
            except OSError as e: raise ValueError(f'{key} {game_bind(config) if key=="gamePort" else "127.0.0.1"}:{value} unavailable: {e}')

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command',choices=['init','preflight','start','inspect'])
    parser.add_argument('--world',required=True,help='New isolated world directory for init')
    parser.add_argument('--config',default=str(ROOT/'config/factorio-pilot.json'))
    args=parser.parse_args(); world=pathlib.Path(args.world).resolve()
    if args.command=='init':
        config=json.loads(pathlib.Path(args.config).read_text())
        if config['version']!=VERSION or config['agentCount']!=10 or config['scenario'] not in ['cooperative-starter','freeplay']: raise ValueError('Unsupported pilot contract')
        if type(config['seed']) is not int or not 0<=config['seed']<=4294967295: raise ValueError('Invalid seed')
        exe,version=binary(); ports(config)
        world.mkdir(parents=True,exist_ok=False)
        os.chmod(world,0o700)
        mods=world/'mods'; mods.mkdir()
        source=ROOT/'factorio/mod/agent-swarm_0.1.0'
        shutil.copytree(source,mods/source.name)
        modlist={'mods':[{'name':'base','enabled':True},{'name':'quality','enabled':False},{'name':'space-age','enabled':False},{'name':'elevated-rails','enabled':False},{'name':'agent-swarm','enabled':True}]}
        (mods/'mod-list.json').write_text(json.dumps(modlist,indent=2))
        (world/'map-gen.json').write_text(json.dumps({'seed':config['seed'],'peaceful_mode':True}))
        (world/'server-settings.json').write_text(json.dumps({'name':'Quant Swarm private pilot','description':'Scripted avatars; initial fixture grants declared in manifest','visibility':{'public':False,'lan':False},'require_user_verification':False,'auto_pause':False,'autosave_interval':2,'autosave_slots':3}))
        manifest={**config,'worldId':str(uuid.uuid4()),'historyId':str(uuid.uuid4()),'binaryVersion':version,'mods':modlist,'bridgeSha256':digest_tree(source),'fixtureGrants':{'sharedChest':{'iron-ore':50,'coal':20},'sharedFurnaces':2,'actorInventories':{}} if config['scenario']=='cooperative-starter' else {'actorInventories':{},'sharedChest':{},'sharedFurnaces':0}}
        (world/'manifest.json').write_text(json.dumps(manifest,indent=2))
        (world/'rcon.password').write_text(uuid.uuid4().hex); os.chmod(world/'rcon.password',0o600)
        (world/'runtime.cfg').write_text('[path]\nread-data='+str(exe.parents[2]/'data')+'\nwrite-data='+str(world/'data')+'\n')
        # A scenario declares grants explicitly; ordinary saves remain untouched.
        scenario=world/'data/scenarios/qs-pilot'; scenario.mkdir(parents=True)
        shutil.copyfile(ROOT/'factorio/scenario.lua',scenario/'control.lua')
        (scenario/'description.json').write_text(json.dumps({'name':'Quant Swarm '+config['scenario']}))
        (scenario/'pilot.json').write_text(json.dumps(manifest))
        (scenario/'control.lua').write_text((scenario/'control.lua').read_text().replace('SCENARIO_NAME',config['scenario']).replace('424242',str(config['seed'])).replace('WORLD_ID',manifest['worldId']).replace('HISTORY_ID',manifest['historyId']))
        subprocess.run([str(exe),'--config',str(world/'runtime.cfg'),'--mod-directory',str(mods),'--map-gen-settings',str(world/'map-gen.json'),'--create',str(world/'world.zip')],check=True,stdout=(world/'create.log').open('w'),stderr=subprocess.STDOUT)
        # convert scenario with declared layout into save; map generation uses seed through scenario Lua
        subprocess.run([str(exe),'--config',str(world/'runtime.cfg'),'--mod-directory',str(mods),'--map-gen-settings',str(world/'map-gen.json'),'--scenario2map','qs-pilot'],check=True,stdout=(world/'scenario.log').open('w'),stderr=subprocess.STDOUT)
        generated=world/'data/saves/qs-pilot.zip'
        if not generated.exists(): raise ValueError('Scenario save missing; inspect scenario.log')
        shutil.copyfile(generated,world/'world.zip')
        print(json.dumps(manifest,indent=2)); return
    manifest=json.loads((world/'manifest.json').read_text())
    if manifest['version']!=VERSION: raise ValueError('World version mismatch')
    if digest_tree(world/'mods/agent-swarm_0.1.0')!=manifest['bridgeSha256']: raise ValueError('World bridge hash mismatch')
    if not (world/'world.zip').is_file(): raise ValueError('World save missing')
    if args.command=='inspect': print(json.dumps(manifest,indent=2)); return
    exe,version=binary(); ports(manifest)
    if args.command=='preflight': print('PASS: pinned binary, manifest, bridge, save and ports'); return
    cmd=[str(exe),'--config',str(world/'runtime.cfg'),'--mod-directory',str(world/'mods'),'--start-server',str(world/'world.zip'),'--server-settings',str(world/'server-settings.json'),'--bind',game_bind(manifest),'--port',str(manifest['gamePort']),'--rcon-bind','127.0.0.1:'+str(manifest['rconPort']),'--rcon-password', (world/'rcon.password').read_text().strip()]
    print('Private server starting; Ctrl+C saves and stops. Manifest:',world/'manifest.json',flush=True)
    # foreground ownership: never search for or kill an unrelated Factorio process
    child=subprocess.Popen(cmd)
    try: return child.wait()
    except KeyboardInterrupt:
        try: child.wait(timeout=30)
        except subprocess.TimeoutExpired: child.terminate(); child.wait(timeout=10)

if __name__=='__main__':
    try: sys.exit(main() or 0)
    except (ValueError,OSError,subprocess.SubprocessError,KeyError) as e: print(f'Runtime refused: {e}',file=sys.stderr); sys.exit(1)

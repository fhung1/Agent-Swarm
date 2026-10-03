#!/usr/bin/env python3
"""Real-engine smoke in a disposable directory; no shared boards touched."""
import json,os,pathlib,signal,socket,subprocess,sys,tempfile,time
from status import status
ROOT=pathlib.Path(__file__).resolve().parents[1]
def run(*args,ok=True):
    p=subprocess.run([sys.executable,str(ROOT/'factorio/runtime.py'),*args],capture_output=True,text=True)
    if (p.returncode==0)!=ok: raise AssertionError(p.stdout+p.stderr)
    return p
with tempfile.TemporaryDirectory(prefix='qs-factorio-check-') as directory:
    parent=pathlib.Path(directory);world=parent/'world';config=json.loads((ROOT/'config/factorio-pilot.json').read_text())
    config['gameBind']=os.environ.get('FACTORIO_CHECK_GAME_BIND','127.0.0.1')
    # Select available ports for this isolated test only; runtime rechecks before startup.
    for key,kind in [('gamePort',socket.SOCK_DGRAM),('rconPort',socket.SOCK_STREAM)]:
        with socket.socket(socket.AF_INET,kind) as s:
            s.bind((config['gameBind'] if key=='gamePort' else '127.0.0.1',0));config[key]=s.getsockname()[1]
    config_path=parent/'config.json';config_path.write_text(json.dumps(config))
    run('init','--world',str(world),'--config',str(config_path))
    before=(world/'world.zip').read_bytes()
    run('init','--world',str(world),'--config',str(config_path),ok=False)
    assert before==(world/'world.zip').read_bytes(),'existing save overwritten'
    run('preflight','--world',str(world))
    invalid=json.loads((world/'manifest.json').read_text());invalid['gameBind']='0.0.0.0'
    original=(world/'manifest.json').read_text();(world/'manifest.json').write_text(json.dumps(invalid))
    run('preflight','--world',str(world),ok=False);(world/'manifest.json').write_text(original)
    with (parent/'server.log').open('w') as log:
        child=subprocess.Popen([sys.executable,str(ROOT/'factorio/runtime.py'),'start','--world',str(world)],stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
        try:
            deadline=time.monotonic()+30
            while True:
                if child.poll() is not None: raise AssertionError((parent/'server.log').read_text())
                try: observed=status(world);break
                except (OSError,ValueError):
                    if time.monotonic()>deadline: raise
                    time.sleep(.2)
            manifest=json.loads((world/'manifest.json').read_text())
            assert len(observed['actors'])==10 and len({a['unit'] for a in observed['actors']})==10
            assert observed['world']['worldId']==manifest['worldId']
            assert observed['world']['historyId']==manifest['historyId']
            assert observed['world']['seed']==config['seed']
            assert sum(c['ironOre'] for c in observed['chests'])==50
            assert sum(c['coal'] for c in observed['chests'])==20
            assert observed['furnaces']==2
            run('preflight','--world',str(world),ok=False)
            time.sleep(.2);assert status(world)['tick']>observed['tick'],'paused without viewer'
        finally:
            os.killpg(child.pid,signal.SIGINT)
            try: child.wait(timeout=30)
            except subprocess.TimeoutExpired: os.killpg(child.pid,signal.SIGKILL);child.wait();raise
        assert child.returncode==0,(parent/'server.log').read_text()
    run('preflight','--world',str(world))
    (world/'mods/agent-swarm_0.1.0/control.lua').write_text('-- tampered')
    run('preflight','--world',str(world),ok=False)
    print('PASS: Factorio 2.0.77; ten actors; declared 50 ore/20 coal/two furnaces; IDs/seed; running ticks; existing-save/port/hash refusal; clean stop')

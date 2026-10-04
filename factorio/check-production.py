#!/usr/bin/env python3
"""One-actor real smelting smoke. Disposable world; no paid inference."""
import json,os,pathlib,signal,socket,subprocess,sys,tempfile,time
from status import status,call
from bridge import execute,encode
ROOT=pathlib.Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix='qs-factorio-production-') as directory:
    parent=pathlib.Path(directory);world=parent/'world';config=json.loads((ROOT/'config/factorio-pilot.json').read_text())
    for key,kind in [('gamePort',socket.SOCK_DGRAM),('rconPort',socket.SOCK_STREAM)]:
        with socket.socket(socket.AF_INET,kind) as s:s.bind(('127.0.0.1',0));config[key]=s.getsockname()[1]
    config_path=parent/'config.json';config_path.write_text(json.dumps(config))
    init=subprocess.run([sys.executable,str(ROOT/'factorio/runtime.py'),'init','--world',str(world),'--config',str(config_path)],capture_output=True,text=True)
    assert init.returncode==0,init.stdout+init.stderr
    log=(parent/'server.log').open('w')
    child=subprocess.Popen([sys.executable,str(ROOT/'factorio/runtime.py'),'start','--world',str(world)],stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
    try:
        deadline=time.monotonic()+30
        while True:
            try:before=status(world);break
            except (OSError,ValueError):
                if child.poll() is not None or time.monotonic()>deadline: raise AssertionError((parent/'server.log').read_text())
                time.sleep(.2)
        actor=before['actors'][0]['unit'];chest=before['chests'][0]
        nearby=call(world,'observe',[actor,32])['nearby'];furnace=next(e for e in nearby if e['type']=='furnace')
        move=lambda ident,x,y:execute(world,actor,ident,{'kind':'move','x':x,'y':y,'maxTicks':600})
        transfer=lambda ident,kind,target,item,n:execute(world,actor,ident,{'kind':kind,'targetId':target,'item':item,'quantity':n})
        # Rejected out-of-reach/oversized mutation leaves source inventory unchanged.
        try: transfer('bad-transfer','take',furnace['unit'],'coal',21);raise AssertionError('oversized accepted')
        except ValueError:pass
        assert status(world)['chests'][0]['ironOre']==50
        move('move-chest',chest['x']+1,chest['y'])
        first=transfer('take-ore','take',chest['unit'],'iron-ore',5)
        duplicate=transfer('take-ore','take',chest['unit'],'iron-ore',5)
        assert first==duplicate and status(world)['chests'][0]['ironOre']==45
        try:transfer('take-ore','take',chest['unit'],'iron-ore',6);raise AssertionError('changed replay accepted')
        except ValueError:pass
        transfer('take-coal','take',chest['unit'],'coal',1)
        move('move-furnace',furnace['x']+2,furnace['y'])
        transfer('insert-ore','put',furnace['unit'],'iron-ore',5)
        transfer('insert-coal','put',furnace['unit'],'coal',1)
        deadline=time.monotonic()+45
        while True:
            obs=call(world,'observe',[actor,32])
            entity=next(e for e in obs['nearby'] if e['unit']==furnace['unit'])
            if entity['items']['ironPlate']==5:break
            if time.monotonic()>deadline:raise AssertionError('Engine did not smelt five plates')
            time.sleep(.2)
        transfer('collect-plates','take',furnace['unit'],'iron-plate',5)
        assert call(world,'observe',[actor,32])['inventory']['ironPlate']==5
        pending=call(world,'submit',[encode(world,actor,'paused-move',{'kind':'move','x':chest['x']+1,'y':chest['y'],'maxTicks':600})])
        assert pending['status']=='pending'
        call(world,'control',[True])
        deadline=time.monotonic()+5
        while True:
            paused_move=call(world,'receipt',['paused-move'])
            if paused_move['status']!='pending':break
            if time.monotonic()>deadline:raise AssertionError('pause did not terminate movement')
            time.sleep(.1)
        assert paused_move['status']=='failed' and paused_move['detail']=='Paused during movement'
        try:transfer('paused-take','take',chest['unit'],'coal',1);raise AssertionError('paused mutation accepted')
        except ValueError:pass
        assert call(world,'receipt',['collect-plates'])['quantity']==5
        os.killpg(child.pid,signal.SIGINT);child.wait(timeout=30)
        assert child.returncode==0
        child=subprocess.Popen([sys.executable,str(ROOT/'factorio/runtime.py'),'start','--world',str(world)],stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
        deadline=time.monotonic()+30
        while True:
            try:after=status(world);break
            except (OSError,ValueError):
                if child.poll() is not None or time.monotonic()>deadline:raise AssertionError((parent/'server.log').read_text())
                time.sleep(.2)
        assert after['paused'] and after['world']==before['world']
        assert call(world,'receipt',['collect-plates'])['quantity']==5
        assert transfer('take-ore','take',chest['unit'],'iron-ore',5)==first
        assert call(world,'observe',[actor,32])['inventory']['ironPlate']==5
        print('PASS: real engine smelting/movement; five plates; replay and resource conservation; pause; save/restart retains world, actors, inventory and receipts')
    finally:
        if child.poll() is None:os.killpg(child.pid,signal.SIGINT)
        try:child.wait(timeout=30)
        except subprocess.TimeoutExpired:os.killpg(child.pid,signal.SIGKILL);child.wait();raise
        log.close()

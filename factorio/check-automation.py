#!/usr/bin/env python3
"""Destructive fixture check; only run against a disposable automation-starter world."""
import json,pathlib,socket,sys,time
from status import call,send,packet
from bridge import execute
world=pathlib.Path(sys.argv[1]).resolve()
assert 'automation-check' in str(world), 'Disposable automation-check path required'
manifest=json.loads((world/'manifest.json').read_text())
assert manifest['scenario']=='automation-starter'
def fixture(lua):
    with socket.create_connection(('127.0.0.1',manifest['rconPort']),timeout=10) as s:
        send(s,1,3,(world/'rcon.password').read_text().strip())
        while True:
            ident,kind,body=packet(s)
            if ident==1 and kind==2: break
        send(s,2,2,'/silent-command '+lua)
        send(s,3,2,'/silent-command rcon.print("end")')
        while True:
            ident,kind,body=packet(s)
            if ident==2 and body.strip(): print(body.strip())
            if ident==3: break
s=call(world,'status');assert not s['automation']['verified']
a=s['actors'][0];aid=a['unit'];x=a['x'];y=a['y']+3
r=execute(world,aid,'check-direction',{'kind':'build','item':'inserter','x':x,'y':y,'direction':8});assert r['status']=='completed',r
s=call(world,'status');machine=next(e for e in s['productionSites'] if e['unit']==r['targetId']);assert machine['direction']==8
assert machine['pickup']['y']>machine['y'] and machine['drop']['y']<machine['y'],machine
assert execute(world,aid,'check-recover',{'kind':'recover','targetId':r['targetId']})['status']=='completed'
# Fixed test-only layout on natural iron: drill -> furnace -> inserter -> chest.
# Daylight is held for a short deterministic test. The live run uses normal days.
fixture('''local s=game.surfaces[1];s.always_day=true
local x,y=-70.5,15.5
for _,e in pairs(s.find_entities_filtered{area={{x-22,y-12},{x+5,y+5}},type={"tree","simple-entity"}}) do e.destroy() end
local function build(n,px,py,d) return assert(s.create_entity{name=n,position={px,py},direction=d or 0,force="player"}) end
build("electric-mining-drill",x,y,0);build("electric-furnace",x,y-3,0);build("inserter",x,y-5,8);build("wooden-chest",x,y-6)
for i=0,3 do for j=0,2 do build("solar-panel",x-6-i*3,y-6+j*3) end end
for i=0,2 do build("medium-electric-pole",x-2-i*6,y-2) end
rcon.print("fixture built")''')
for _ in range(18):
    time.sleep(5);s=call(world,'status');p=s['automation'];print(json.dumps(p),flush=True)
    if p.get('verified'): break
else: raise AssertionError('Unattended production not verified: '+json.dumps(s['productionSites']))
assert p['currentStored']>=10
# Material mutation must immediately invalidate proof.
s=call(world,'status');a=next(a for a in s['actors'] if a['unit']==aid)
r=execute(world,aid,'check-reset',{'kind':'build','item':'wooden-chest','x':a['x'],'y':a['y']+3,'direction':0});assert r['status']=='completed',r
assert not call(world,'status')['automation']['verified']
print('PASS: direction, recovery, unattended mining/smelting/storage, mutation reset')

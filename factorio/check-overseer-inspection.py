#!/usr/bin/env python3
"""Destructive engine checks. Requires a disposable overseer-inspection-check world."""
import json,pathlib,socket,sys,time
from status import call,send,packet
from bridge import execute,encode
world=pathlib.Path(sys.argv[1]).resolve()
assert 'overseer-inspection-check' in str(world), 'Disposable overseer-inspection-check path required'
manifest=json.loads((world/'manifest.json').read_text())
def fixture(lua):
    with socket.create_connection(('127.0.0.1',manifest['rconPort']),timeout=10) as s:
        send(s,1,3,(world/'rcon.password').read_text().strip())
        while True:
            ident,kind,body=packet(s)
            if ident==1 and kind==2: break
        send(s,2,2,'/silent-command '+lua)
        send(s,3,2,'/silent-command rcon.print("end")')
        result=[]
        while True:
            ident,kind,body=packet(s)
            if ident==2 and body.strip():result.append(body.strip())
            if ident==3:break
        return json.loads(''.join(result)) if result else None

# Explicit machine fixtures; no live-world changes.
setup=fixture('''local s=game.surfaces[1];local found=nil
for _,ore in pairs(s.find_entities_filtered{name="iron-ore"}) do
 if s.can_place_entity{name="burner-mining-drill",position=ore.position,force="player"} then found=ore.position;break end
end
assert(found);local d=assert(s.create_entity{name="burner-mining-drill",position=found,force="player",direction=4})
local p={x=200,y=200};s.request_to_generate_chunks(p,1);s.force_generate_chunk_requests()
for _,e in pairs(s.find_entities_filtered{area={{190,190},{210,210}}}) do e.destroy() end
local tiles={};for x=190,210 do for y=190,210 do tiles[#tiles+1]={name="grass-1",position={x,y}} end end;s.set_tiles(tiles)
local bad=assert(s.create_entity{name="burner-mining-drill",position={200,200},force="player",direction=4})
for x=192,208 do for y=192,196 do s.create_entity{name="transport-belt",position={x+0.5,y+0.5},direction=4,force="player"} end end
rcon.print(helpers.table_to_json{good=d.unit_number,bad=bad.unit_number})''')
good=call(world,'inspect',[dict(kind='machine',id=setup['good'])])
bad=call(world,'inspect',[dict(kind='machine',id=setup['bad'])])
assert good['machine']['miningArea']['resources']['iron-ore']>0,good
assert bad['machine']['miningArea']['resourceTiles']==0,bad
q=dict(kind='layout',x=200,y=200,radius=12,offset=0)
first=call(world,'inspect',[q]);assert len(first['entities'])==40 and first['nextOffset']==40,first
q['offset']=40;second=call(world,'inspect',[q]);assert len(second['entities'])>0
keys=lambda page:{(e['name'],e['x'],e['y']) for e in page['entities']}
assert not keys(first)&keys(second)
assert all('box' in e and 'direction' in e for e in first['entities'])
assert any(e['name']=='transport-belt' and e['direction']==4 for e in first['entities'])
try:call(world,'inspect',[dict(kind='layout',x=0,y=0,radius=100,offset=0)])
except ValueError:pass
else:raise AssertionError('Unbounded inspection accepted')
print('PASS: actual extraction area resources, empty placement, exact belt directions/footprints, bounded layout pagination and rejected invalid bounds')

#!/usr/bin/env python3
"""Destructive engine checks. Requires a disposable belt-observation-check world."""
import json,pathlib,socket,sys,time
from status import call,send,packet
from bridge import execute,encode
world=pathlib.Path(sys.argv[1]).resolve()
assert 'belt-observation-check' in str(world), 'Disposable belt-observation-check path required'
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



setup=fixture('''local s=game.surfaces[1];local a=s.find_entities_filtered{name="character"}[1]
s.request_to_generate_chunks({200,200},1);s.force_generate_chunk_requests()
for _,e in pairs(s.find_entities_filtered{area={{190,190},{210,210}}}) do if e.type~="character" then e.destroy() end end
local tiles={};for x=190,210 do for y=190,210 do tiles[#tiles+1]={name="grass-1",position={x,y}} end end;s.set_tiles(tiles);a.teleport({202,202})
local b=s.create_entity{name="transport-belt",position={200.5,200.5},direction=4,force="player"};b.active=false
assert(b.get_transport_line(1).insert_at(0.5,{name="coal",count=1}));assert(b.get_transport_line(2).insert_at(0.5,{name="iron-ore",count=1}))
local empty=s.create_entity{name="transport-belt",position={204.5,200.5},force="player"}
rcon.print(helpers.table_to_json{actor=a.unit_number,belt=b.unit_number,empty=empty.unit_number})''')
for _ in range(2):
    machine=call(world,'inspect',[dict(kind='machine',id=setup['belt'])])['machine']
    assert machine['belt']['items']=={'coal':1,'iron-ore':1},machine
    assert machine['belt']['lanes'][0]['items']=={'coal':1}
    assert machine['belt']['lanes'][1]['items']=={'iron-ore':1}
    obs=call(world,'observe',[setup['actor'],32]);b=next(e for e in obs['nearby'] if e['unit']==setup['belt']);assert b['belt']==machine['belt']
    layout=call(world,'inspect',[dict(kind='layout',x=202,y=200,radius=5,offset=0)])
    assert next(e for e in layout['entities'] if e['id']==setup['belt'])['belt']==machine['belt']
    empty=call(world,'inspect',[dict(kind='machine',id=setup['empty'])])['machine']
    assert not empty['belt']['items']
print('PASS: both lane contents and totals visible in machine/local/layout, empty belt distinct, repeated reads conserve items')

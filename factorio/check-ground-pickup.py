#!/usr/bin/env python3
"""Destructive engine checks. Requires a disposable ground-pickup-check world."""
import json,pathlib,socket,sys,time
from status import call,send,packet
from bridge import execute,encode
world=pathlib.Path(sys.argv[1]).resolve()
assert 'ground-pickup-check' in str(world), 'Disposable ground-pickup-check path required'
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
local tiles={};for x=190,210 do for y=190,210 do tiles[#tiles+1]={name="grass-1",position={x,y}} end end;s.set_tiles(tiles)
a.teleport({203,200});a.get_inventory(defines.inventory.character_main).clear();a.insert{name="stone-furnace",count=1}
s.create_entity{name="item-on-ground",position={200,200},stack={name="iron-ore",count=10}}
rcon.print(helpers.table_to_json{actor=a.unit_number})''')
aid=setup['actor'];seq=0
def action(command,success=True):
    global seq
    seq+=1;raw=encode(world,aid,'pickup-check-'+str(time.time_ns()),command)
    r=call(world,'submit',[raw]);assert r['status']==('completed' if success else 'failed'),r
    assert call(world,'submit',[raw])==r
    return r
def ground():
    return [e for e in call(world,'observe',[aid,32])['nearby'] if e['type']=='item-entity']
assert ground()[0]['groundItem']==dict(name='iron-ore',count=10)
layout=call(world,'inspect',[dict(kind='layout',x=200,y=200,radius=5,offset=0)])
assert any(e.get('groundItem',{}).get('name')=='iron-ore' for e in layout['entities'])
action(dict(kind='build',item='stone-furnace',x=200,y=200,direction=0),False)
action(dict(kind='pickup',item='coal',x=200,y=200,quantity=1),False)
action(dict(kind='pickup',item='iron-ore',x=190,y=190,quantity=1),False)
call(world,'control',[True]);action(dict(kind='pickup',item='iron-ore',x=200,y=200,quantity=1),False);call(world,'control',[False])
r=action(dict(kind='pickup',item='iron-ore',x=200,y=200,quantity=3));assert r['quantity']==3
assert ground()[0]['groundItem']['count']==7
assert call(world,'observe',[aid,32])['inventory']['items']['iron-ore']==3
r=action(dict(kind='pickup',item='iron-ore',x=200,y=200,quantity=100));assert r['quantity']==7
assert not ground()
assert call(world,'observe',[aid,32])['inventory']['items']['iron-ore']==10
action(dict(kind='build',item='stone-furnace',x=200,y=200,direction=0))
print('PASS: ground visibility, bounded pickup, conservation, exact replay, wrong item/range/pause rejection, cleared blocked placement')

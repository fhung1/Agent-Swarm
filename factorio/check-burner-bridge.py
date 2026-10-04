#!/usr/bin/env python3
"""Destructive engine checks. Requires a disposable burner-bridge-check world."""
import json,pathlib,socket,sys,time
from status import call,send,packet
from bridge import execute,encode
world=pathlib.Path(sys.argv[1]).resolve()
assert 'burner-bridge-check' in str(world), 'Disposable burner-bridge-check path required'
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
for _,e in pairs(s.find_entities_filtered{type={"container","mining-drill","furnace","inserter","boiler"}}) do e.destroy() end
a.get_inventory(defines.inventory.character_main).clear();a.teleport({-68,19});a.insert{name="coal",count=100};a.insert{name="wood",count=20};a.insert{name="iron-ore",count=120};a.insert{name="iron-plate",count=9};a.insert{name="stone",count=5}
for _,e in pairs(s.find_entities_filtered{area={{-75,10},{-62,26}},type={"tree","simple-entity"}}) do e.destroy() end
local function build(n,x,y,d,force) local e=assert(s.create_entity{name=n,position={x,y},direction=d or 0,force=force or "player"});e.active=false;return e.unit_number end
rcon.print(helpers.table_to_json{actor=a.unit_number,drill=build("burner-mining-drill",-70,16,4),furnace=build("stone-furnace",-68,16),inserter=build("burner-inserter",-66.5,16.5,12),chest=build("wooden-chest",-65.5,16.5),boiler=build("boiler",-70,22),electric=build("inserter",-65.5,20.5),foreign=build("wooden-chest",-67.5,22.5,0,"enemy"),far=build("wooden-chest",-90.5,20.5)})''')
aid=setup['actor'];counter=0;prefix='burner-'+str(time.time_ns())
def action(kind,target,item,quantity,success=True):
    global counter
    counter+=1;op=f'{prefix}-{counter}'
    cmd={'kind':kind,'targetId':setup[target],'item':item,'quantity':quantity}
    receipt=call(world,'submit',[encode(world,aid,op,cmd)])
    assert receipt['status']==('completed' if success else 'failed'),receipt
    replay=call(world,'submit',[encode(world,aid,op,cmd)])
    assert replay==receipt,'Receipt replay changed'
    return receipt
def entity(name):return next(e for e in call(world,'observe',[aid,32])['nearby'] if e['unit']==setup[name])
assert entity('drill')['fuel']['items']=={} or entity('drill')['fuel']['items']==[]
assert isinstance(entity('drill')['statusName'],str)
assert 'drop' in entity('drill')
action('put','drill','coal',4);assert entity('drill')['fuel']['items']['coal']==4
action('take','drill','coal',1);assert entity('drill')['fuel']['items']['coal']==3
action('put','inserter','coal',4);assert entity('inserter')['fuel']['items']['coal']==4
action('take','inserter','coal',1);assert entity('inserter')['fuel']['items']['coal']==3
action('put','boiler','wood',3);action('take','boiler','wood',1);assert entity('boiler')['fuel']['items']['wood']==2
action('put','drill','iron-ore',1,False);assert entity('drill')['fuel']['items']['coal']==3
action('put','drill','coal',60,False);assert entity('drill')['fuel']['items']['coal']==3
action('put','electric','coal',1,False)
action('put','foreign','coal',1,False)
action('put','far','coal',1,False)
action('put','chest','coal',2);action('take','chest','coal',2)
fixture('game.surfaces[1].find_entities_filtered{type="container",force="player",position={-65.5,16.5},radius=1}[1].get_inventory(defines.inventory.chest).set_bar(2)')
action('put','chest','coal',49);action('put','chest','coal',2,False);assert entity('chest')['items']['coal']==49
action('take','chest','coal',49)
action('put','furnace','iron-ore',3);action('put','furnace','coal',4)
action('put','furnace','iron-ore',100,False)
assert entity('furnace')['items']['items']['iron-ore']==3 and entity('furnace')['fuel']['items']['coal']==4
call(world,'control',[True]);action('put','inserter','coal',1,False);call(world,'control',[False])
fixture('''for _,e in pairs(game.surfaces[1].find_entities_filtered{type={"mining-drill","furnace","inserter"},force="player"}) do e.active=true end''')
for _ in range(30):
    time.sleep(1)
    s=call(world,'status');chest=next(e for e in s['chests'] if e['unit']==setup['chest'])
    if chest['ironPlate']>=4:break
else:raise AssertionError('Fueled drill/furnace/inserter failed to operate: '+json.dumps(s['productionSites']))
assert entity('drill')['fuel']['remainingEnergy']>0
# Isolate mining reach from the production fixture.
probe=fixture('''local a=game.surfaces[1].find_entities_filtered{name="character"}[1];local ore=game.surfaces[1].find_entities_filtered{name="iron-ore",position={-70,12},radius=5}[1];a.teleport({ore.position.x,ore.position.y+1});rcon.print(helpers.table_to_json{x=ore.position.x,y=ore.position.y,reachable=a.can_reach_entity(ore)})''')
before=call(world,'observe',[aid,32])['inventory']['ironOre']
r=execute(world,aid,prefix+'-mine',{'kind':'mine','name':'iron-ore','x':probe['x'],'y':probe['y'],'quantity':3});assert r['quantity']==3,r
assert call(world,'observe',[aid,32])['inventory']['ironOre']==before+3
assert call(world,'receipt',[prefix+'-mine'])['quantity']==3
# Hand crafting includes prerequisite gears/furnace; placement and recovery
# use the same bounded commands available to inference actors.
execute(world,aid,prefix+'-craft',{'kind':'craft','recipe':'burner-mining-drill','quantity':1})
for _ in range(30):
    if call(world,'observe',[aid,32])['inventory']['items'].get('burner-mining-drill',0)>=1:break
    time.sleep(.2)
else:raise AssertionError('Crafted drill never arrived')
position=fixture('local a=game.surfaces[1].find_entities_filtered{name="character"}[1];local found=nil;for dx=-3,3 do for dy=-3,3 do local p={x=math.floor(a.position.x)+dx,y=math.floor(a.position.y)+dy};if a.surface.can_place_entity{name="burner-mining-drill",position=p,direction=4,force="player"} then found=p;break end end;if found then break end end;assert(found);rcon.print(helpers.table_to_json(found))')
built=execute(world,aid,prefix+'-build',{'kind':'build','item':'burner-mining-drill','x':position['x'],'y':position['y'],'direction':4})
observed=call(world,'observe',[aid,32]);placed=next(e for e in observed['nearby'] if e['unit']==built['targetId'])
assert placed['direction']==4 and 'drop' in placed
execute(world,aid,prefix+'-recover',{'kind':'recover','targetId':built['targetId']})
assert call(world,'observe',[aid,32])['inventory']['items']['burner-mining-drill']==1
print('PASS: crafting/build/recover; drill/inserter/boiler fuel put/take, observation, idempotent receipts, nonfuel/capacity/foreign/range/pause rejection, furnace/chest routing, fueled production, nearby mining')

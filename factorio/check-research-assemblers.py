#!/usr/bin/env python3
"""Destructive engine checks. Requires a disposable research-assembler-check world."""
import json,pathlib,socket,sys,time
from status import call,send,packet
from bridge import execute,encode
world=pathlib.Path(sys.argv[1]).resolve()
assert 'research-assembler-check' in str(world), 'Disposable research-assembler-check path required'
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
# All materials, machines and power below are explicit disposable test fixtures.
setup=fixture('''local s=game.surfaces[1];local a=s.find_entities_filtered{name="character"}[1]
for _,e in pairs(s.find_entities_filtered{area={{-85,5},{-50,40}}}) do if e.type~="character" then e.destroy() end end
local tiles={};for x=-85,-50 do for y=5,40 do tiles[#tiles+1]={name="grass-1",position={x,y}} end end;s.set_tiles(tiles)
a.teleport({-68,20});a.get_inventory(defines.inventory.character_main).clear()
a.insert{name="iron-plate",count=100};a.insert{name="copper-plate",count=50};a.insert{name="coal",count=5};a.insert{name="automation-science-pack",count=30}
local function build(n,x,y) return assert(s.create_entity{name=n,position={x,y},force="player"}) end
local iron=build("stone-furnace",-70,16);iron.insert{name="iron-ore",count=60};iron.insert{name="coal",count=10}
local copper=build("stone-furnace",-66,16);copper.insert{name="copper-ore",count=20};copper.insert{name="coal",count=10}
local lab=build("lab",-66,21);local assembler=build("assembling-machine-1",-70,21)
build("substation",-68,25);for x=-78,-74,4 do for y=23,31,4 do build("solar-panel",x,y) end end
s.daytime=0;s.freeze_daytime=true;game.speed=10
rcon.print(helpers.table_to_json{actor=a.unit_number,lab=lab.unit_number,assembler=assembler.unit_number,iron=iron.unit_number})''')
aid=setup['actor'];counter=0;prefix='research-'+str(time.time_ns())
def action(command,success=True):
    global counter
    counter+=1;op=f'{prefix}-{counter}'
    receipt=call(world,'submit',[encode(world,aid,op,command)])
    assert receipt['status']==('completed' if success else 'failed'),receipt
    assert call(world,'submit',[encode(world,aid,op,command)])==receipt
    return receipt
def transfer(kind,target,item,quantity,success=True):
    return action(dict(kind=kind,targetId=setup[target],item=item,quantity=quantity),success)
def recipe(name,success=True,target='assembler'):
    return action(dict(kind='set_recipe',targetId=setup[target],recipe=name),success)
def wait_for(check,label,seconds=40):
    for _ in range(seconds*5):
        if check():return
        time.sleep(.2)
    raise AssertionError(label)
def entity(name):return next(e for e in call(world,'observe',[aid,32])['nearby'] if e['unit']==setup[name])
action(dict(kind='research',technology='automation'),False)
action(dict(kind='research',technology='missing-technology'),False)
action(dict(kind='research',technology='steam-power'),False)
assert call(world,'status')['research']['automaticTriggers']
recipe('assembling-machine-1',False);recipe('iron-plate',False);recipe('iron-gear-wheel',False,'lab')
recipe('iron-gear-wheel');assert entity('assembler')['recipe']['ingredients'][0]['name']=='iron-plate'
transfer('put','assembler','coal',1,False)
fixture('game.surfaces[1].find_entities_filtered{name="assembling-machine-1"}[1].active=false')
transfer('put','assembler','iron-plate',4);recipe('transport-belt',False);recipe('iron-gear-wheel')
assert entity('assembler')['input']['iron-plate']==4
transfer('take','assembler','iron-plate',2)
call(world,'control',[True]);recipe('iron-gear-wheel',False);call(world,'control',[False])
fixture('game.surfaces[1].find_entities_filtered{name="assembling-machine-1"}[1].active=true')
wait_for(lambda: entity('assembler')['output'].get('iron-gear-wheel',0)>=1,'Assembler did not produce gear')
recipe('transport-belt',False);transfer('take','assembler','iron-gear-wheel',1);recipe('transport-belt')
transfer('put','lab','iron-plate',1,False)
wait_for(lambda: all(t in call(world,'status')['research']['researched'] for t in ['steam-power','electronics']),'Smelting did not unlock trigger technologies')
# Cancelling a queued craft must never credit the research trigger.
action(dict(kind='craft',recipe='lab',quantity=1))
fixture('local a=game.surfaces[1].find_entities_filtered{name="character"}[1];while a.crafting_queue_size>0 do a.cancel_crafting{index=a.crafting_queue_size,count=1000} end')
wait_for(lambda: not call(world,'observe',[aid,4])['triggerCraftPending'],'Cancelled craft did not reconcile')
assert 'automation-science-pack' not in call(world,'status')['research']['researched']
assert call(world,'status')['lastTriggerCraft']['verified']==False
# Craft through the same bounded actor command, proving scripted actors can unlock the lab trigger.
crafted=action(dict(kind='craft',recipe='lab',quantity=1))
wait_for(lambda: 'automation-science-pack' in call(world,'status')['research']['researched'],'Lab crafting did not unlock science research')
assert call(world,'status')['lastTriggerCraft']['verified']==True
assert call(world,'receipt',[crafted['operationId']])==crafted, 'Craft completion changed immutable receipt'
assert fixture('rcon.print(game.forces.player.get_item_production_statistics(game.surfaces[1]).get_input_count("lab"))')==1
assert any(t['name']=='automation' for t in call(world,'status')['research']['available'])
action(dict(kind='research',technology='automation'))
action(dict(kind='research',technology='logistics'),False)
action(dict(kind='research',technology='automation'))
transfer('put','lab','automation-science-pack',12);transfer('take','lab','automation-science-pack',1)
wait_for(lambda: 'automation' in call(world,'status')['research']['researched'],'Powered lab failed to finish automation',60)
assert 'assembling-machine-1' in call(world,'status')['recipeCatalog']['enabled']
recipe('assembling-machine-1')
print('PASS: natural production/crafting research triggers; science selection and actual lab completion; assembler recipes, input/output transfers and production; cancelled crafts receive no research credit; locked/incompatible/nonempty/pause rejection; exact receipt replay. Explicit disposable item/machine/power fixtures only.')

local function world() return remote.call("qs_world","metadata") end
local function actor(id)
  if type(id)~="number" or id%1~=0 then error("Invalid actor ID") end
  for _,e in pairs(game.surfaces[1].find_entities_filtered{name="character"}) do
    if e.valid and not e.player and e.unit_number==id then return e end
  end
  error("Unknown scripted actor")
end
local function distance(a,b) return ((a.x-b.x)^2+(a.y-b.y)^2)^0.5 end
local function bounded(v,min,max)
  if type(v)~="number" or v~=v or v<min or v>max or v%1~=0 then error("Invalid integer bound") end
  return v
end
local function exact(value,keys)
  local allowed={};for _,key in ipairs(keys) do allowed[key]=true end
  local count=0;for key,_ in pairs(value) do if not allowed[key] then error("Unexpected field") end;count=count+1 end
  if count~=#keys then error("Missing field") end
end
local function contents(e)
  local items={};local inventories={}
  if e.type=="character" then inventories={defines.inventory.character_main}
  elseif e.type=="container" then inventories={defines.inventory.chest}
  elseif e.type=="assembling-machine" then inventories={defines.inventory.assembling_machine_input,defines.inventory.assembling_machine_output}
  elseif e.type=="lab" then inventories={defines.inventory.lab_input}
  elseif e.type=="furnace" then inventories={defines.inventory.furnace_source,defines.inventory.furnace_result,defines.inventory.fuel} end
  for _,index in ipairs(inventories) do
    local inventory=e.get_inventory(index)
    if inventory then for _,entry in pairs(inventory.get_contents()) do items[entry.name]=(items[entry.name] or 0)+entry.count end end
  end
  if e.type~="character" and e.type~="container" and e.type~="furnace" then
    local fuel=e.get_fuel_inventory()
    if fuel then for _,entry in pairs(fuel.get_contents()) do items[entry.name]=(items[entry.name] or 0)+entry.count end end
  end
  return {ironOre=items["iron-ore"] or 0,coal=items["coal"] or 0,ironPlate=items["iron-plate"] or 0,items=items}
end
local machine_types={lab=true,["assembling-machine"]=true,container=true,furnace=true,["mining-drill"]=true,inserter=true,["transport-belt"]=true,["electric-pole"]=true,["solar-panel"]=true,accumulator=true,boiler=true,generator=true,pipe=true,["pipe-to-ground"]=true,["offshore-pump"]=true,["storage-tank"]=true,["underground-belt"]=true,splitter=true}
local status_names={};for name,value in pairs(defines.entity_status) do status_names[value]=name end
local function inventory_items(inventory)
  local items={}
  if inventory then for _,entry in pairs(inventory.get_contents()) do items[entry.name]=(items[entry.name] or 0)+entry.count end end
  return items
end
local function recipe_info(recipe)
  if not recipe then return nil end
  return {name=recipe.name,category=recipe.category,ingredients=recipe.ingredients,products=recipe.products,energy=recipe.energy}
end
local function research_ready(technology)
  if not technology.enabled or technology.researched or #technology.research_unit_ingredients==0 then return false end
  for _,prerequisite in pairs(technology.prerequisites) do if not prerequisite.researched then return false end end
  return true
end
local function research_status(force)
  local available={};local researched={};local triggers={}
  for name,t in pairs(force.technologies) do
    if t.researched then researched[#researched+1]=name
    elseif t.enabled and t.prototype.research_trigger then
      local prerequisites={};for _,p in pairs(t.prerequisites) do if not p.researched then prerequisites[#prerequisites+1]=p.name end end
      table.sort(prerequisites)
      triggers[#triggers+1]={name=name,trigger=t.prototype.research_trigger,missingPrerequisites=prerequisites}
    elseif research_ready(t) then available[#available+1]={name=name,units=t.research_unit_count,ingredients=t.research_unit_ingredients} end
  end
  table.sort(available,function(a,b)return a.name<b.name end);table.sort(researched);table.sort(triggers,function(a,b)return a.name<b.name end)
  local omitted=math.max(0,#available-24);while #available>24 do table.remove(available) end
  local current=force.current_research
  return {current=current and current.name or nil,progress=current and force.research_progress or 0,available=available,automaticTriggers=triggers,omittedAvailable=omitted,researched=researched}
end
local function recipe_catalog(force)
  local names={};for name,recipe in pairs(force.recipes) do if recipe.enabled and not name:match("^parameter%-%d+$") and name~="recipe-unknown" then names[#names+1]=name end end
  table.sort(names);local omitted=math.max(0,#names-100);while #names>100 do table.remove(names) end
  return {enabled=names,omitted=omitted}
end
local function mining_area(e)
  if e.type~="mining-drill" then return nil end
  local radius=e.prototype.mining_drill_radius;local area={{e.position.x-radius,e.position.y-radius},{e.position.x+radius,e.position.y+radius}}
  local resources={};local tiles=0
  for _,ore in pairs(e.surface.find_entities_filtered{area=area,type="resource"}) do
    if e.prototype.resource_categories[ore.prototype.resource_category] then resources[ore.name]=(resources[ore.name] or 0)+ore.amount;tiles=tiles+1 end
  end
  local target=e.mining_target
  return {radius=radius,area=area,resourceTiles=tiles,resources=resources,target=target and target.valid and {name=target.name,x=target.position.x,y=target.position.y,amount=target.amount} or nil,
    note="Resource entities intersecting the prototype extraction area; machine status and current target determine actual mining."}
end
local function belt_contents(e)
  if e.type~="transport-belt" and e.type~="underground-belt" and e.type~="splitter" then return nil end
  local lanes={};local totals={}
  for i=1,e.get_max_transport_line_index() do
    local items={};local line=e.get_transport_line(i)
    for _,entry in pairs(line.get_contents()) do items[entry.name]=(items[entry.name] or 0)+entry.count;totals[entry.name]=(totals[entry.name] or 0)+entry.count end
    lanes[#lanes+1]={index=i,items=items}
  end
  return {lanes=lanes,items=totals}
end
local function fluid_state(e,includePipes)
  if not includePipes and e.type~="offshore-pump" and e.type~="boiler" and e.type~="generator" and
      e.type~="chemical-plant" and e.type~="oil-refinery" and e.type~="pump" then return nil end
  local fluidbox=e.fluidbox
  if not fluidbox or #fluidbox==0 then return nil end
  local boxes={}
  for i=1,math.min(#fluidbox,8) do
    local fluid=fluidbox[i]
    local connections=fluidbox.get_pipe_connections(i)
    local ports={}
    for j=1,math.min(#connections,12) do
      local connection=connections[j]
      ports[#ports+1]={position=connection.position,targetPosition=connection.target_position,
        flowDirection=connection.flow_direction,connectionType=connection.connection_type,connected=connection.target~=nil}
    end
    boxes[#boxes+1]={index=i,fluid=fluid and {name=fluid.name,amount=fluid.amount,temperature=fluid.temperature} or nil,
      ports=ports,omittedPorts=math.max(0,#connections-12)}
  end
  return {boxes=boxes,omittedBoxes=math.max(0,#fluidbox-8)}
end
local function machine_state(e,includePipeFluids)
  local fuel=e.get_fuel_inventory();local burner=e.burner;local fuel_items={}
  if fuel then for _,entry in pairs(fuel.get_contents()) do fuel_items[entry.name]=(fuel_items[entry.name] or 0)+entry.count end end
  return {unit=e.unit_number or 0,name=e.name,type=e.type,x=e.position.x,y=e.position.y,direction=e.direction,status=e.status,statusName=status_names[e.status],energy=e.energy,
    fuel=fuel and {items=fuel_items,burning=burner and burner.currently_burning and burner.currently_burning.name or nil,remainingEnergy=burner and burner.remaining_burning_fuel or 0} or nil,
    items=(e.type=="container" or e.type=="furnace" or e.type=="assembling-machine" or e.type=="lab" or fuel) and contents(e) or nil,
    miningArea=mining_area(e),belt=belt_contents(e),fluidboxes=fluid_state(e,includePipeFluids),
    recipe=e.type=="assembling-machine" and recipe_info(e.get_recipe()) or nil,
    craftingProgress=e.type=="assembling-machine" and e.crafting_progress or nil,
    input=e.type=="assembling-machine" and inventory_items(e.get_inventory(defines.inventory.assembling_machine_input)) or nil,
    output=e.type=="assembling-machine" and inventory_items(e.get_inventory(defines.inventory.assembling_machine_output)) or nil,
    pickup=e.type=="inserter" and e.pickup_position or nil,drop=(e.type=="inserter" or e.type=="mining-drill") and e.drop_position or nil}
end
-- Read only generated tiles. Water/land pairs are geometric shoreline evidence,
-- not a promise that an offshore pump or adjacent machines can be placed.
local function terrain_sample(surface,cx,cy,radius)
  local min_x=math.floor(cx-radius);local max_x=math.floor(cx+radius)
  local min_y=math.floor(cy-radius);local max_y=math.floor(cy+radius)
  local chunks={};local cells={};local water_count=0;local land_count=0;local unknown_count=0
  local shores={};local nearest_water=nil;local nearest_distance=nil
  local function tile_at(x,y)
    if x<min_x or x>max_x or y<min_y or y>max_y then return nil end
    local key=x..":"..y
    if cells[key]~=nil then return cells[key] end
    local chunk_x=math.floor(x/32);local chunk_y=math.floor(y/32)
    local chunk_key=chunk_x..":"..chunk_y
    if chunks[chunk_key]==nil then chunks[chunk_key]=surface.is_chunk_generated{x=chunk_x,y=chunk_y} end
    if not chunks[chunk_key] then cells[key]=false;return false end
    local tile=surface.get_tile(x,y)
    cells[key]={water=tile.collides_with("water_tile"),name=tile.name}
    return cells[key]
  end
  for y=min_y,max_y do for x=min_x,max_x do
    local tile=tile_at(x,y)
    if tile==false then unknown_count=unknown_count+1
    elseif tile.water then
      water_count=water_count+1
      local d=(x+0.5-cx)^2+(y+0.5-cy)^2
      if not nearest_distance or d<nearest_distance then nearest_distance=d;nearest_water={x=x,y=y,name=tile.name} end
      for _,delta in ipairs({{1,0},{-1,0},{0,1},{0,-1}}) do
        local lx=x+delta[1];local ly=y+delta[2];local land=tile_at(lx,ly)
        if land and not land.water then shores[#shores+1]={waterX=x,waterY=y,landX=lx,landY=ly,waterTile=tile.name} end
      end
    else land_count=land_count+1 end
  end end
  table.sort(shores,function(a,b)
    local ad=(a.waterX+0.5-cx)^2+(a.waterY+0.5-cy)^2
    local bd=(b.waterX+0.5-cx)^2+(b.waterY+0.5-cy)^2
    if ad~=bd then return ad<bd end
    if a.waterY~=b.waterY then return a.waterY<b.waterY end
    if a.waterX~=b.waterX then return a.waterX<b.waterX end
    if a.landY~=b.landY then return a.landY<b.landY end
    return a.landX<b.landX
  end)
  local visible={};for i=1,math.min(#shores,24) do visible[#visible+1]=shores[i] end
  return {area={{min_x,min_y},{max_x,max_y}},waterTiles=water_count,landTiles=land_count,unknownTiles=unknown_count,
    nearestWater=nearest_water,shorelines=visible,omittedShorelines=math.max(0,#shores-24),
    note="Generated tiles only. Shorelines are adjacent water/land tiles, not verified pump footprints; inspect and build to confirm placement."}
end
local function observation(id,radius)
  local a=actor(id);radius=bounded(radius or 32,1,32)
  local entries={};local omitted=0
  local candidates=a.surface.find_entities_filtered{position=a.position,radius=radius}
  table.sort(candidates,function(ae,be)
    local ad=distance(a.position,ae.position);local bd=distance(a.position,be.position)
    if ad~=bd then return ad<bd end
    if ae.position.x~=be.position.x then return ae.position.x<be.position.x end
    if ae.position.y~=be.position.y then return ae.position.y<be.position.y end
    return ae.name<be.name
  end)
  for _,e in ipairs(candidates) do
    if e.valid and (machine_types[e.type] or e.type=="resource" or e.type=="tree" or e.type=="item-entity" or e.type=="character" or e.type=="simple-entity" or e.type=="cliff") then
      if #entries<100 then
        local entry=machine_state(e,false);entry.amount=e.type=="resource" and e.amount or nil;entry.groundItem=e.type=="item-entity" and {name=e.stack.name,count=e.stack.count} or nil;entries[#entries+1]=entry
      else omitted=omitted+1 end
    end
  end
  return {actorId=id,x=a.position.x,y=a.position.y,inventory=contents(a),craftingQueue=a.crafting_queue,triggerCraftPending=storage.qs_trigger_crafts and storage.qs_trigger_crafts[id]~=nil or false,nearby=entries,omitted=omitted,
    terrain=terrain_sample(a.surface,a.position.x,a.position.y,12),tick=game.tick,world=world(),paused=storage.qs_paused or false}
end
-- Read-only survey of generated terrain; never grants items or generates chunks.
-- Cache the scan, and send compact resource cells rather than every ore tile.
local survey_cache=nil
local function resource_map()
  if survey_cache and game.tick-survey_cache.tick<600 then return survey_cache end
  local surface=game.surfaces[1];local spawn=world().spawn
  local groups={};local totals={};local generated={};local chunks={}
  for chunk in surface.get_chunks() do
    if surface.is_chunk_generated(chunk) then
      generated[chunk.x..":"..chunk.y]=true;chunks[#chunks+1]={x=chunk.x,y=chunk.y}
    end
  end
  for _,e in pairs(surface.find_entities_filtered{type={"resource","tree"}}) do
    if e.valid then
      local name=e.type=="tree" and "wood" or e.name
      local key=name..":"..math.floor(e.position.x/32)..":"..math.floor(e.position.y/32)
      local amount=e.type=="resource" and e.amount or 1
      totals[name]=(totals[name] or 0)+amount
      local g=groups[key]
      if not g then
        g={id=key,resource=name,name=e.name,x=e.position.x,y=e.position.y,amount=0,entities=0,distance=distance(spawn,e.position)}
        groups[key]=g
      end
      g.amount=g.amount+amount;g.entities=g.entities+1
      if distance(spawn,e.position)<g.distance then
        g.x=e.position.x;g.y=e.position.y;g.name=e.name;g.distance=distance(spawn,e.position)
      end
    end
  end
  local sorted={};for _,g in pairs(groups) do sorted[#sorted+1]=g end
  table.sort(sorted,function(a,b) if a.distance==b.distance then return a.id<b.id end;return a.distance<b.distance end)
  local deposits={};local counts={};local omitted=0
  for _,g in ipairs(sorted) do
    if (counts[g.resource] or 0)<6 and #deposits<36 then
      counts[g.resource]=(counts[g.resource] or 0)+1;g.distance=math.floor(g.distance);deposits[#deposits+1]=g
    else omitted=omitted+1 end
  end
  local frontier={};local seen={}
  for _,c in ipairs(chunks) do
    for _,d in ipairs({{1,0},{-1,0},{0,1},{0,-1}}) do
      local x=c.x+d[1];local y=c.y+d[2];local key=x..":"..y
      if not generated[key] and not seen[key] then
        seen[key]=true;frontier[#frontier+1]={x=x*32+16,y=y*32+16}
      end
    end
  end
  table.sort(frontier,function(a,b)
    local da=distance(spawn,a);local db=distance(spawn,b)
    if da==db then if a.x==b.x then return a.y<b.y end;return a.x<b.x end;return da<db
  end)
  local targets={};for i=1,math.min(8,#frontier) do targets[#targets+1]=frontier[i] end
  survey_cache={tick=game.tick,coverage="all-generated-terrain",cellSize=32,generatedChunks=#chunks,
    totals=totals,deposits=deposits,omittedCells=omitted,frontiers=targets,
    note="Targets are real entity positions; approach and observe before mining. Wood amount counts trees. Up to six nearest cells per resource; ungenerated terrain is unknown."}
  return survey_cache
end
local function finish(id,status,detail)
  local receipt=storage.qs_receipts[id]
  receipt.status=status;receipt.detail=detail;receipt.endTick=game.tick
  storage.qs_busy[receipt.actorId]=nil
  if storage.qs_pending then storage.qs_pending[id]=nil end
  return receipt
end
local function target_for(a,id)
  bounded(id,1,2147483647)
  local e
  for _, candidate in pairs(a.surface.find_entities_filtered{position=a.position,radius=6}) do
    if candidate.unit_number==id then e=candidate;break end
  end
  if not e or not e.valid or e.surface~=a.surface or e.force~=a.force or (e.type~="container" and e.type~="furnace" and e.type~="assembling-machine" and e.type~="lab" and not ((e.type=="mining-drill" or e.type=="inserter" or e.type=="boiler") and e.get_fuel_inventory())) then error("Invalid transfer target: "..tostring(e and e.name).."/"..tostring(e and e.type).." force="..tostring(e and e.force.name).." actor="..a.force.name.." surface="..tostring(e and e.surface.index).."/"..a.surface.index) end
  if distance(a.position,e.position)>6 then error("Transfer out of reach") end
  return e
end
local submit
local function agents()
  local scripted={};for _,e in pairs(game.surfaces[1].find_entities_filtered{name="character"}) do if e.valid and not e.player then scripted[#scripted+1]=e end end
  table.sort(scripted,function(a,b) return a.unit_number<b.unit_number end)
  return scripted
end
script.on_configuration_changed(function()
  local scripted=agents();storage.qs_busy=storage.qs_busy or {};storage.qs_receipts=storage.qs_receipts or {}
  storage.qs_task_labels=storage.qs_task_labels or {}
  for i=#scripted,6,-1 do
    local entity=scripted[i];local operation=storage.qs_busy[entity.unit_number]
    if operation and storage.qs_receipts[operation] and storage.qs_receipts[operation].status=="pending" then
      entity.walking_state={walking=false,direction=defines.direction.north};finish(operation,"failed","Actor removed by five-agent roster update")
    end
    storage.qs_busy[entity.unit_number]=nil;storage.qs_task_labels[entity.unit_number]=nil;entity.destroy()
  end
end)
local function agent_by_index(index)
  bounded(index,1,5);local e=agents()[index]
  if not e then error("Unknown agent number") end
  return e
end
local function submit_operator(player,index,command)
  local target=agent_by_index(index);storage.qs_manual_sequence=(storage.qs_manual_sequence or 0)+1
  local w=world()
  local raw=helpers.table_to_json({version=1,worldId=w.worldId,historyId=w.historyId,
    operationId="operator-"..player.index.."-"..game.tick.."-"..storage.qs_manual_sequence,
    actorId=target.unit_number,command=command,digest=string.rep("0",64)})
  local receipt=submit(raw)
  player.print(string.format("QS: Agent %02d command %s (%s).",index,command.kind,receipt.status))
end
local function number_arg(value,name)
  local n=tonumber(value)
  if not n or n~=n or math.abs(n)==math.huge then error("Invalid "..name) end
  return n
end
local function command_args(value)
  local out={};for token in string.gmatch(value or "","%S+") do out[#out+1]=token end
  return out
end
commands.add_command("qs","Observe and command the Factorio swarm. Use /qs help.",function(event)
  local player=event.player_index and game.get_player(event.player_index)
  if not player then return end
  local ok,err=pcall(function()
    local a=command_args(event.parameter);local action=string.lower(a[1] or "help")
    if action=="help" then
      player.print("QS: /qs status | observe N | pause | resume | move N X Y | mine N NAME X Y [Q] | transfer N take|put BOX ITEM Q | craft N RECIPE Q | build N ITEM X Y")
    elseif action=="status" then
      local parts={};for i,e in ipairs(agents()) do parts[#parts+1]=string.format("A%02d(%.0f,%.0f)",i,e.position.x,e.position.y) end
      player.print("QS "..(storage.qs_paused and "paused" or "running").." tick "..game.tick..": "..table.concat(parts," "))
    elseif action=="observe" and #a==2 then
      local index=number_arg(a[2],"agent number");local e=agent_by_index(index);local o=observation(e.unit_number,32);local inv={}
      for name,count in pairs(o.inventory.items) do inv[#inv+1]=name.." "..count end;table.sort(inv)
      local nearby={};for _,entity in ipairs(o.nearby) do
        if entity.type=="resource" or entity.type=="tree" or entity.type=="container" or entity.type=="furnace" then
          nearby[#nearby+1]=entity.type.."/"..entity.name.."#"..entity.unit
        end
      end
      player.print(string.format("Agent %02d at %.1f, %.1f; inventory: %s; nearby: %s",index,o.x,o.y,#inv>0 and table.concat(inv,",") or "empty",#nearby>0 and table.concat(nearby,"; ") or "none"))
    elseif action=="pause" and #a==1 then storage.qs_paused=true;player.print("QS: swarm paused.")
    elseif action=="resume" and #a==1 then storage.qs_paused=false;player.print("QS: swarm resumed.")
    elseif action=="move" and #a==4 then
      submit_operator(player,number_arg(a[2],"agent number"),{kind="move",x=number_arg(a[3],"x coordinate"),y=number_arg(a[4],"y coordinate"),maxTicks=600})
    elseif action=="mine" and (#a==5 or #a==6) then
      submit_operator(player,number_arg(a[2],"agent number"),{kind="mine",name=a[3],x=number_arg(a[4],"x coordinate"),y=number_arg(a[5],"y coordinate"),quantity=number_arg(a[6] or "1","quantity")})
    elseif action=="transfer" and #a==6 and (a[3]=="take" or a[3]=="put") then
      submit_operator(player,number_arg(a[2],"agent number"),{kind=a[3],targetId=number_arg(a[4],"container unit"),item=a[5],quantity=number_arg(a[6],"quantity")})
    elseif action=="craft" and #a==4 then
      submit_operator(player,number_arg(a[2],"agent number"),{kind="craft",recipe=a[3],quantity=number_arg(a[4],"quantity")})
    elseif action=="build" and #a==5 then
      submit_operator(player,number_arg(a[2],"agent number"),{kind="place",item=a[3],x=number_arg(a[4],"x coordinate"),y=number_arg(a[5],"y coordinate")})
    else error("Invalid command. Use /qs help.") end
  end)
  if not ok then player.print("QS command refused: "..tostring(err)) end
end)
script.on_event(defines.events.on_player_joined_game,function(event)
  local player=game.get_player(event.player_index)
  if player then
    player.admin=true
    if not player.character then player.create_character();player.teleport(world().spawn,game.surfaces[1]) end
    player.print("You are the swarm operator and a Factorio admin. Use /qs help to inspect, pause, or command agents.")
  end
end)
submit=function(raw)
  if type(raw)~="string" or #raw>4096 then error("Oversized request") end
  local req=helpers.json_to_table(raw)
  if type(req)~="table" or req.version~=1 then error("Invalid protocol") end
  exact(req,{"version","worldId","historyId","operationId","actorId","command","digest"})
  local w=world()
  if req.worldId~=w.worldId or req.historyId~=w.historyId then error("World/history mismatch") end
  if type(req.operationId)~="string" or #req.operationId>96 or not req.operationId:match("^[%w_.:-]+$") then error("Invalid operation ID") end
  if type(req.digest)~="string" or #req.digest~=64 or not req.digest:match("^[0-9a-f]+$") then error("Invalid digest") end
  bounded(req.actorId,1,2147483647)
  storage.qs_receipts=storage.qs_receipts or {};storage.qs_busy=storage.qs_busy or {}
  local existing=storage.qs_receipts[req.operationId]
  if existing then
    if existing.request~=raw then error("Operation ID content changed") end
    return existing
  end
  local a,target,target_inventory
  local command=req.command
  -- A valid scoped operation always has a durable outcome, including admission
  -- rejection. No mutation occurs inside validation; uncertain transport can
  -- reconcile this failed receipt instead of inventing a retry.
  local accepted,rejection=pcall(function()
    if storage.qs_paused then error("World paused") end
    a=actor(req.actorId)
    if storage.qs_busy[req.actorId] then error("Actor has pending operation") end
    if storage.qs_trigger_crafts and storage.qs_trigger_crafts[req.actorId] and command.kind~="move" then error("Wait for verified research-trigger crafting to finish") end
    if type(command)~="table" then error("Missing command") end
    -- Validate every argument before recording or mutating resources.
    if command.kind=="move" then
      exact(command,{"kind","x","y","maxTicks"})
      if type(command.x)~="number" or type(command.y)~="number" or command.x~=command.x or command.y~=command.y or math.abs(command.x)>1000000 or math.abs(command.y)>1000000 then error("Invalid position") end
      if distance(a.position,{x=command.x,y=command.y})>32 then error("Movement outside local radius") end
      bounded(command.maxTicks,1,600)
    elseif command.kind=="take" or command.kind=="put" then
      exact(command,{"kind","targetId","item","quantity"})
      target=target_for(a,command.targetId);bounded(command.quantity,1,100)
      if type(command.item)~="string" or not command.item:match("^[a-z0-9][a-z0-9-]*$") or #command.item>64 or not prototypes.item[command.item] then error("Invalid item") end
      if target.type=="lab" then
        target_inventory=target.get_inventory(defines.inventory.lab_input)
        if prototypes.item[command.item].type~="tool" then error("Labs accept science packs only") end
      elseif target.type=="assembling-machine" then
        local input=target.get_inventory(defines.inventory.assembling_machine_input)
        local output=target.get_inventory(defines.inventory.assembling_machine_output)
        if command.kind=="take" then target_inventory=output.get_item_count(command.item)>=command.quantity and output or input
        else
          local recipe=target.get_recipe();local ingredient=false
          if recipe then for _,entry in pairs(recipe.ingredients) do if entry.type=="item" and entry.name==command.item then ingredient=true end end end
          if not ingredient then error("Set a recipe and provide only its item ingredients") end
          target_inventory=input
        end
      elseif target.type~="container" and target.type~="furnace" then
        target_inventory=target.get_fuel_inventory()
        if not target_inventory or prototypes.item[command.item].fuel_value<=0 then error("Target accepts fuel items only") end
      end
      local target_store=target_inventory or target
      if command.kind=="take" then
        if target_store.get_item_count(command.item)<command.quantity or not a.can_insert{name=command.item,count=command.quantity} or a.get_inventory(defines.inventory.character_main).get_insertable_count(command.item)<command.quantity then error("Insufficient source or destination capacity") end
      else
        local destination_inventory=target_inventory
        if target.type=="container" then destination_inventory=target.get_inventory(defines.inventory.chest)
        elseif target.type=="furnace" then
          destination_inventory=prototypes.item[command.item].fuel_value>0 and target.get_fuel_inventory() or target.get_inventory(defines.inventory.furnace_source)
        end
        if a.get_item_count(command.item)<command.quantity or not target_store.can_insert{name=command.item,count=command.quantity} or not destination_inventory or destination_inventory.get_insertable_count(command.item)<command.quantity then error("Insufficient source or destination capacity") end
      end
    elseif command.kind=="pickup" then
      exact(command,{"kind","item","x","y","quantity"});bounded(command.quantity,1,100)
      if type(command.item)~="string" or not command.item:match("^[a-z0-9][a-z0-9-]*$") or #command.item>64 then error("Invalid pickup item") end
      if type(command.x)~="number" or type(command.y)~="number" or command.x~=command.x or command.y~=command.y or math.abs(command.x)>1000000 or math.abs(command.y)>1000000 or distance(a.position,{x=command.x,y=command.y})>6 then error("Pickup target out of reach") end
      for _,candidate in pairs(a.surface.find_entities_filtered{position={command.x,command.y},radius=0.05,type="item-entity"}) do
        if candidate.valid and candidate.stack.valid_for_read and candidate.stack.name==command.item then target=candidate;break end
      end
      if not target then error("Ground item missing") end
      if not a.can_insert(target.stack) then error("No inventory capacity for ground item") end
    elseif command.kind=="mine" then
      exact(command,{"kind","name","x","y","quantity"});bounded(command.quantity,1,20)
      if type(command.name)~="string" or not command.name:match("^[a-z0-9][a-z0-9-]*$") or #command.name>64 then error("Invalid mine target") end
      if type(command.x)~="number" or type(command.y)~="number" or command.x~=command.x or command.y~=command.y or math.abs(command.x)>1000000 or math.abs(command.y)>1000000 or distance(a.position,{x=command.x,y=command.y})>6 then error("Mine target out of reach") end
      for _,candidate in pairs(a.surface.find_entities_filtered{position={command.x,command.y},radius=0.6,name=command.name}) do
        if candidate.valid and (candidate.type=="resource" or candidate.type=="tree") then target=candidate;break end
      end
      if not target or not target.minable then error("Mine target missing or not minable") end
    elseif command.kind=="research" then
      exact(command,{"kind","technology"})
      if type(command.technology)~="string" or not command.technology:match("^[a-z0-9][a-z0-9-]*$") or #command.technology>64 then error("Invalid technology") end
      local technology=a.force.technologies[command.technology]
      if not technology or not research_ready(technology) then error("Technology unavailable or prerequisites incomplete") end
      if a.force.current_research and a.force.current_research.name~=command.technology then error("Another research is active; finish it before selecting another") end
    elseif command.kind=="set_recipe" then
      exact(command,{"kind","targetId","recipe"});target=target_for(a,command.targetId)
      if target.type~="assembling-machine" then error("Recipe target must be an assembler") end
      if type(command.recipe)~="string" or not command.recipe:match("^[a-z0-9][a-z0-9-]*$") or #command.recipe>64 then error("Invalid recipe") end
      local recipe=a.force.recipes[command.recipe]
      if not recipe or not recipe.enabled or not target.prototype.crafting_categories[recipe.category] then error("Recipe locked or incompatible with this machine") end
      local current=target.get_recipe()
      if not current or current.name~=recipe.name then
        if not target.get_inventory(defines.inventory.assembling_machine_input).is_empty() or not target.get_inventory(defines.inventory.assembling_machine_output).is_empty() or target.is_crafting() or target.crafting_progress>0 then error("Empty assembler and finish its current craft before changing recipe") end
        local modules=target.get_module_inventory();if modules and not modules.is_empty() then error("Remove assembler modules before changing recipe") end
        for i=1,#target.fluidbox do if target.fluidbox[i] and target.fluidbox[i].amount>0 then error("Drain assembler fluids before changing recipe") end end
      end
    elseif command.kind=="craft" then
      exact(command,{"kind","recipe","quantity"});bounded(command.quantity,1,20)
      if type(command.recipe)~="string" or not command.recipe:match("^[a-z0-9][a-z0-9-]*$") or #command.recipe>64 or not a.force.recipes[command.recipe] or not a.force.recipes[command.recipe].enabled then error("Recipe unavailable") end
      if a.get_craftable_count(command.recipe)<command.quantity then error("Insufficient crafting inputs") end
    elseif command.kind=="recover" then
      exact(command,{"kind","targetId"});bounded(command.targetId,1,2147483647)
      for _,candidate in pairs(a.surface.find_entities_filtered{position=a.position,radius=6}) do if candidate.unit_number==command.targetId then target=candidate;break end end
      if not target or not target.valid or not machine_types[target.type] or target.force~=a.force or target.surface~=a.surface or distance(a.position,target.position)>6 or not target.minable then error("Recover target unavailable or out of reach") end
    elseif command.kind=="place" or command.kind=="build" then
      exact(command,command.kind=="build" and {"kind","item","x","y","direction"} or {"kind","item","x","y"})
      if command.kind=="build" and command.direction~=0 and command.direction~=4 and command.direction~=8 and command.direction~=12 then error("Invalid cardinal direction") end
      if type(command.item)~="string" or not command.item:match("^[a-z0-9][a-z0-9-]*$") or #command.item>64 then error("Invalid place item") end
      local prototype=prototypes.item[command.item]
      if not prototype or not prototype.place_result or a.get_item_count(command.item)<1 then error("Place item unavailable") end
      if type(command.x)~="number" or type(command.y)~="number" or command.x~=command.x or command.y~=command.y or math.abs(command.x)>1000000 or math.abs(command.y)>1000000 or distance(a.position,{x=command.x,y=command.y})>6 then error("Place target out of reach") end
      if not a.surface.can_place_entity{name=prototype.place_result.name,position={command.x,command.y},force=a.force,direction=command.direction or 0} then error("Place target blocked") end
    else error("Unsupported command") end
  end)
  if not accepted then
    local receipt={version=1,operationId=req.operationId,digest=req.digest,worldId=w.worldId,
      historyId=w.historyId,actorId=req.actorId,status="failed",startTick=game.tick,
      endTick=game.tick,detail=tostring(rejection),request=raw}
    storage.qs_receipts[req.operationId]=receipt
    -- Never clear qs_busy here: this rejection may belong to a second request
    -- while an earlier operation is still moving the same actor.
    return receipt
  end
  if command.kind~="move" then storage.qs_automation=nil end
  local receipt={version=1,operationId=req.operationId,digest=req.digest,worldId=w.worldId,historyId=w.historyId,actorId=req.actorId,status="pending",startTick=game.tick,request=raw}
  storage.qs_receipts[req.operationId]=receipt;storage.qs_busy[req.actorId]=req.operationId
  if command.kind=="move" then
    receipt.target={x=command.x,y=command.y};receipt.deadline=game.tick+command.maxTicks
    if storage.qs_pending then storage.qs_pending[req.operationId]=true end;return receipt
  end
  if command.kind=="pickup" then
    local stack=target.stack;local original=stack.count
    local count=math.min(original,command.quantity)
    stack.count=count
    local ok,inserted=pcall(function() return a.insert(stack) end)
    if not ok then stack.count=original;return finish(req.operationId,"failed","Pickup insertion failed") end
    if original>inserted then stack.count=original-inserted else target.destroy() end
    receipt.quantity=inserted;receipt.item=command.item
    return finish(req.operationId,inserted>0 and "completed" or "failed",inserted>0 and "Picked up existing ground items" or "No inventory capacity")
  end
  if command.kind=="mine" then
    local mined=0
    for _=1,command.quantity do
      if not target.valid then break end
      local amount_before=target.type=="resource" and target.amount or nil
      local result=a.mine_entity(target)
      -- In 2.0.77 a resource can yield an item while mine_entity returns false
      -- because the ore entity remains. Count the engine's actual depletion.
      local progressed=result or not target.valid or (amount_before and target.amount<amount_before)
      if not progressed then break end
      mined=mined+1
    end
    receipt.quantity=mined;receipt.item=command.name
    return finish(req.operationId,mined>0 and "completed" or "failed",mined>0 and "Mined in game" or "Mining failed")
  end
  if command.kind=="research" then
    local active=a.force.current_research
    local started=(active and active.name==command.technology) or a.force.add_research(command.technology)
    receipt.technology=command.technology
    return finish(req.operationId,started and "completed" or "failed",started and "Research selected; labs must consume science to complete it" or "Engine refused research")
  end
  if command.kind=="set_recipe" then
    local ok,reason=pcall(function()
      local current=target.get_recipe()
      if not current or current.name~=command.recipe then target.set_recipe(command.recipe) end
    end)
    local recipe=target.get_recipe();local applied=ok and recipe and recipe.name==command.recipe
    receipt.targetId=target.unit_number;receipt.recipe=command.recipe
    return finish(req.operationId,applied and "completed" or "failed",applied and "Assembler recipe configured" or tostring(reason or "Engine refused recipe"))
  end
  if command.kind=="craft" then
    -- Scripted characters in 2.0.77 craft real items but omit production
    -- statistics, so craft-item research triggers never see their lab output.
    -- Track only trigger products, keeping inventory mutations excluded until
    -- the engine finishes and the complete output is present. Persist this
    -- evidence across saves; never credit merely queued or cancelled crafts.
    local products={}
    for _,technology in pairs(a.force.technologies) do
      local trigger=technology.prototype.research_trigger
      if not technology.researched and trigger and trigger.type=="craft-item" then
        for _,product in pairs(a.force.recipes[command.recipe].products) do
          if product.type=="item" and product.name==trigger.item.name and product.amount and (not product.probability or product.probability==1) then
            products[product.name]={before=a.get_item_count(product.name),amount=product.amount}
          end
        end
      end
    end
    if next(products) and a.crafting_queue_size>0 then return finish(req.operationId,"failed","Finish existing craft queue before research-trigger crafting") end
    local started=a.begin_crafting{count=command.quantity,recipe=command.recipe}
    if started>0 and next(products) then
      storage.qs_trigger_crafts=storage.qs_trigger_crafts or {}
      storage.qs_trigger_crafts[req.actorId]={operationId=req.operationId,products=products,count=started}
    end
    receipt.quantity=started;receipt.item=command.recipe
    return finish(req.operationId,started==command.quantity and "completed" or "failed",started==command.quantity and "Craft queued in game" or "Craft queue rejected")
  end
  if command.kind=="recover" then
    local recovered=a.mine_entity(target)
    return finish(req.operationId,recovered and "completed" or "failed",recovered and "Recovered machine into inventory" or "Recovery failed")
  end
  if command.kind=="place" or command.kind=="build" then
    local prototype=prototypes.item[command.item]
    local placed=a.surface.create_entity{name=prototype.place_result.name,position={command.x,command.y},force=a.force,direction=command.direction or 0}
    if not placed then return finish(req.operationId,"failed","Placement rejected") end
    local removed=a.remove_item{name=command.item,count=1}
    if removed~=1 then placed.destroy();return finish(req.operationId,"failed","Place item disappeared") end
    receipt.quantity=1;receipt.item=command.item;receipt.targetId=placed.unit_number
    return finish(req.operationId,"completed","Built from inventory")
  end
  local source=command.kind=="take" and (target_inventory or target) or a
  local dest=command.kind=="take" and a or (target_inventory or target)
  local removed
  if command.kind=="take" and target_inventory then removed=source.remove{name=command.item,count=command.quantity}
  else removed=source.remove_item{name=command.item,count=command.quantity} end
  local inserted=dest.insert{name=command.item,count=removed}
  if inserted<removed then source.insert{name=command.item,count=removed-inserted} end
  receipt.quantity=inserted;receipt.item=command.item;receipt.targetId=target.unit_number
  if inserted>0 then
    local position=command.kind=="put" and target.position or a.position
    rendering.draw_text{surface=a.surface,target=position,time_to_live=240,scale=1.5,
      text=(command.kind=="take" and "+" or "-")..inserted.." "..command.item,
      color=command.item=="iron-plate" and {r=0.8,g=0.9,b=1} or {r=1,g=0.85,b=0.35}}
  end
  return finish(req.operationId,inserted==command.quantity and "completed" or "failed",inserted==command.quantity and "Transferred" or "Capacity changed")
end
script.on_event(defines.events.on_tick,function()
  for actor_id,craft in pairs(storage.qs_trigger_crafts or {}) do
    local ok,a=pcall(actor,actor_id)
    if not ok or a.crafting_queue_size==0 then
      local verified=ok
      if ok then for name,product in pairs(craft.products) do
        if a.get_item_count(name)-product.before<product.amount*craft.count then verified=false end
      end end
      if verified then
        for name,product in pairs(craft.products) do
          a.force.get_item_production_statistics(a.surface).on_flow(name,product.amount*craft.count)
        end
      end
      storage.qs_last_trigger_craft={operationId=craft.operationId,actorId=actor_id,verified=verified,tick=game.tick}
      storage.qs_trigger_crafts[actor_id]=nil
    end
  end
  if game.tick%30==0 then
    local surface=game.surfaces[1];local force=game.forces.player;local tags={};storage.qs_task_labels=storage.qs_task_labels or {}
    for _,tag in pairs(force.find_chart_tags(surface)) do
      local index=string.match(tag.text or "","^QS Agent (%d+):?")
      if index then tags[tonumber(index)]=tag end
    end
    for _,a in ipairs(agents()) do
      local index=a.unit_number-11;local label=string.format("Agent %02d",index)
      local task=storage.qs_task_labels[a.unit_number] or "Waiting for task"
      local map_task=string.sub(task,1,48)
      force.chart(surface,{{x=a.position.x-16,y=a.position.y-16},{x=a.position.x+16,y=a.position.y+16}})
      local tag=tags[a.unit_number];local map_label="QS Agent "..a.unit_number..": "..map_task
      if tag and tag.valid then tag.position=a.position;tag.text=map_label
      else force.add_chart_tag(surface,{position=a.position,text=map_label}) end
      rendering.draw_text{text=label,surface=surface,target=a,color={r=0.25,g=0.9,b=1},scale=1.5,
        time_to_live=45,alignment="center",vertical_alignment="bottom",scale_with_zoom=true}
      rendering.draw_text{text=task,surface=surface,target={type="entity",entity=a,offset={0,-0.65}},color={r=1,g=0.9,b=0.55},scale=1.15,
        time_to_live=45,alignment="center",vertical_alignment="bottom",scale_with_zoom=true}
    end
  end
  if not storage.qs_pending then
    storage.qs_pending={}
    for id,receipt in pairs(storage.qs_receipts or {}) do
      if receipt.status=="pending" and receipt.target then storage.qs_pending[id]=true end
    end
  end
  for id,_ in pairs(storage.qs_pending) do
    local receipt=(storage.qs_receipts or {})[id]
    if not receipt then storage.qs_pending[id]=nil
    else
      if receipt.status=="pending" and receipt.target then
        local ok,a=pcall(actor,receipt.actorId)
        if not ok then finish(id,"failed","Actor lost")
        elseif storage.qs_paused then
          a.walking_state={walking=false,direction=defines.direction.north};finish(id,"failed","Paused during movement")
        elseif distance(a.position,receipt.target)<0.5 then
          a.walking_state={walking=false,direction=defines.direction.north};finish(id,"completed","Arrived")
        elseif game.tick>=receipt.deadline then
          a.walking_state={walking=false,direction=defines.direction.north};finish(id,"failed","Movement timeout")
        else
          local dx=receipt.target.x-a.position.x;local dy=receipt.target.y-a.position.y
          local angle=math.atan2(dx,-dy)
          local direction=math.floor((angle/(2*math.pi)*16)+0.5)%16
          a.walking_state={walking=true,direction=direction}
        end
      end
    end
  end
end)
script.on_event(defines.events.on_rocket_launched,function()
  storage.qs_rocket_launches=(storage.qs_rocket_launches or 0)+1
  storage.qs_last_rocket_tick=game.tick
end)
remote.add_interface("agent_swarm", {
  observe=observation,
  inspect=function(raw)
    if type(raw)~="string" or #raw>2048 then error("Invalid inspection wire request") end
    local query=helpers.json_to_table(raw)
    if type(query)~="table" then error("Invalid inspection") end
    if query.kind=="machine" then
      exact(query,{"kind","id"});bounded(query.id,1,2147483647)
      local e=game.get_entity_by_unit_number(query.id)
      -- Base machines need not carry the get-by-unit-number prototype flag.
      if not e then for _,candidate in pairs(game.surfaces[1].find_entities_filtered{force="player"}) do
        if candidate.unit_number==query.id then e=candidate;break end
      end end
      if not e or not e.valid or e.force~=game.forces.player or not machine_types[e.type] then error("Friendly machine not found") end
      return {world=world(),tick=game.tick,machine=machine_state(e),box=e.bounding_box}
    end
    exact(query,{"kind","x","y","radius","offset"})
    if query.kind~="layout" then error("Unsupported inspection") end
    for _,key in pairs({"x","y"}) do if type(query[key])~="number" or query[key]~=query[key] or math.abs(query[key])>1000000 then error("Invalid coordinate") end end
    bounded(query.radius,1,16);bounded(query.offset,0,10000)
    local area={{query.x-query.radius,query.y-query.radius},{query.x+query.radius,query.y+query.radius}}
    local candidates={}
    for _,e in pairs(game.surfaces[1].find_entities_filtered{area=area}) do
      if (machine_types[e.type] and e.force==game.forces.player) or e.type=="item-entity" or e.type=="character" or e.type=="tree" or e.type=="simple-entity" or e.type=="cliff" then candidates[#candidates+1]=e end
    end
    table.sort(candidates,function(a,b) if a.position.y~=b.position.y then return a.position.y<b.position.y end;if a.position.x~=b.position.x then return a.position.x<b.position.x end;return a.name<b.name end)
    local entities={}
    for i=query.offset+1,math.min(#candidates,query.offset+40) do
      local e=candidates[i];entities[#entities+1]={id=e.unit_number or 0,name=e.name,x=e.position.x,y=e.position.y,direction=e.direction,
        box=e.bounding_box,status=status_names[e.status],type=e.type,belt=belt_contents(e),fluidboxes=fluid_state(e),groundItem=e.type=="item-entity" and {name=e.stack.name,count=e.stack.count} or nil,pickup=e.type=="inserter" and e.pickup_position or nil,
        drop=(e.type=="inserter" or e.type=="mining-drill") and e.drop_position or nil}
    end
    return {world=world(),tick=game.tick,area=area,terrain=terrain_sample(game.surfaces[1],query.x,query.y,query.radius),entities=entities,total=#candidates,offset=query.offset,
      nextOffset=query.offset+40<#candidates and query.offset+40 or nil,
      note="Read-only layout, not a screenshot. Directions: 0 north,4 east,8 south,12 west. Belt direction is travel; inserter direction is pickup side; use actual pickup/drop coordinates. Fluid ports show exact position, intended target position and whether connected; fluid amounts are per box. Bounding boxes show footprints. No automatic judgment of aesthetics or design."}
  end,
  submit=submit,
  receipt=function(id) return (storage.qs_receipts or {})[id] end,
  control=function(paused)
    if type(paused)~="boolean" then error("Expected pause flag") end
    storage.qs_paused=paused;return {paused=paused,tick=game.tick}
  end,
  set_task_label=function(id,label)
    bounded(id,1,2147483647)
    if type(label)~="string" or #label<1 or #label>80 or label:find("%c") then error("Invalid task label") end
    actor(id);storage.qs_task_labels=storage.qs_task_labels or {};storage.qs_task_labels[id]=label
    return {actorId=id,label=label}
  end,
  status=function()
    local actors={}
    for _,e in pairs(game.surfaces[1].find_entities_filtered{name="character"}) do
      if e.valid and not e.player then actors[#actors+1]={unit=e.unit_number,x=e.position.x,y=e.position.y,inventory=contents(e)} end
    end
    local chests={}
    for _,e in pairs(game.surfaces[1].find_entities_filtered{type="container",force="player"}) do
      local c=contents(e);c.unit=e.unit_number;c.x=e.position.x;c.y=e.position.y;chests[#chests+1]=c
    end
    local productionSites={};local omittedSites=0
    for _,e in pairs(game.surfaces[1].find_entities_filtered{type={"lab","assembling-machine","furnace","mining-drill","inserter","transport-belt","electric-pole","solar-panel","accumulator","boiler","generator","pipe","pipe-to-ground","offshore-pump","storage-tank","underground-belt","splitter"},force="player"}) do
      if #productionSites<160 then
        productionSites[#productionSites+1]=machine_state(e)
      else omittedSites=omittedSites+1 end
    end
    return {version="0.1.1",tick=game.tick,actors=actors,actorCount=#actors,world=world(),chests=chests,automation=storage.qs_automation or {verified=false},furnaces=#game.surfaces[1].find_entities_filtered{type="furnace",force="player"},paused=storage.qs_paused or false,
      lastTriggerCraft=storage.qs_last_trigger_craft,research=research_status(game.forces.player),recipeCatalog=recipe_catalog(game.forces.player),productionSites=productionSites,omittedSites=omittedSites,resourceMap=resource_map(),rocketLaunches=storage.qs_rocket_launches or 0,lastRocketTick=storage.qs_last_rocket_tick}
  end
})

-- A rolling engine proof, never a model claim. Each half of a minute must
-- include fresh mining, smelting and stored output; manual mutations reset it.
script.on_nth_tick(60,function()
  local surface=game.surfaces[1]
  for _,a in pairs(surface.find_entities_filtered{name="character"}) do
    if a.crafting_queue_size>0 or (a.player and a.player.mining_state.mining) then storage.qs_automation=nil;return end
  end
  local stats=game.forces.player.get_item_production_statistics(surface)
  local ore=stats.get_input_count("iron-ore");local coal=stats.get_input_count("coal");local plates=stats.get_input_count("iron-plate");local stored=0
  for _,e in pairs(surface.find_entities_filtered{type="container",force="player"}) do stored=stored+e.get_item_count("iron-plate") end
  local proof=storage.qs_automation
  if not proof then proof={verified=false,startTick=game.tick,ore=ore,coal=coal,plates=plates,stored=stored,windows=0};storage.qs_automation=proof end
  proof.currentStored=stored;proof.tick=game.tick
  proof.mined=ore-proof.ore;proof.coalMined=coal-(proof.coal or coal);proof.smelted=plates-proof.plates;proof.delivered=stored-proof.stored
  local needsFuel=false
  for _,e in pairs(surface.find_entities_filtered{type={"mining-drill","furnace","boiler"},force="player"}) do
    if e.burner then needsFuel=true;break end
  end
  proof.needsFuel=needsFuel
  if game.tick-proof.startTick>=1800 then
    if proof.mined>=5 and proof.smelted>=5 and proof.delivered>=5 and (not needsFuel or proof.coalMined>=1) then proof.windows=proof.windows+1 else proof.windows=0 end
    proof.verified=proof.windows>=2
    proof.startTick=game.tick;proof.ore=ore;proof.coal=coal;proof.plates=plates;proof.stored=stored
    if proof.verified then proof.verifiedTick=game.tick end
  end
end)
for _,event in pairs({defines.events.on_built_entity,defines.events.on_player_mined_entity,defines.events.on_player_main_inventory_changed,defines.events.on_player_rotated_entity,defines.events.on_player_crafted_item}) do
  script.on_event(event,function() storage.qs_automation=nil end)
end

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
  elseif e.type=="furnace" then inventories={defines.inventory.furnace_source,defines.inventory.furnace_result,defines.inventory.fuel} end
  for _,index in ipairs(inventories) do
    local inventory=e.get_inventory(index)
    if inventory then for _,entry in pairs(inventory.get_contents()) do items[entry.name]=(items[entry.name] or 0)+entry.count end end
  end
  return {ironOre=e.get_item_count("iron-ore"),coal=e.get_item_count("coal"),ironPlate=e.get_item_count("iron-plate"),items=items}
end
local function observation(id,radius)
  local a=actor(id);radius=bounded(radius or 32,1,32)
  local entries={};local omitted=0
  for _,e in pairs(a.surface.find_entities_filtered{position=a.position,radius=radius}) do
    if e.valid and (e.type=="container" or e.type=="furnace" or e.type=="resource" or e.type=="tree") then
      if #entries<100 then
        entries[#entries+1]={unit=e.unit_number or 0,name=e.name,type=e.type,x=e.position.x,y=e.position.y,
          amount=e.type=="resource" and e.amount or nil,items=(e.type=="container" or e.type=="furnace") and contents(e) or nil}
      else omitted=omitted+1 end
    end
  end
  return {actorId=id,x=a.position.x,y=a.position.y,inventory=contents(a),nearby=entries,omitted=omitted,tick=game.tick,world=world(),paused=storage.qs_paused or false}
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
  if not e or not e.valid or e.surface~=a.surface or e.force~=a.force or (e.type~="container" and e.type~="furnace") then error("Invalid transfer target: "..tostring(e and e.name).."/"..tostring(e and e.type).." force="..tostring(e and e.force.name).." actor="..a.force.name.." surface="..tostring(e and e.surface.index).."/"..a.surface.index) end
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
  local a,target
  local command=req.command
  -- A valid scoped operation always has a durable outcome, including admission
  -- rejection. No mutation occurs inside validation; uncertain transport can
  -- reconcile this failed receipt instead of inventing a retry.
  local accepted,rejection=pcall(function()
    if storage.qs_paused then error("World paused") end
    a=actor(req.actorId)
    if storage.qs_busy[req.actorId] then error("Actor has pending operation") end
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
      if command.kind=="take" then
        if target.get_item_count(command.item)<command.quantity or not a.can_insert{name=command.item,count=command.quantity} then error("Insufficient source or destination capacity") end
      else
        if a.get_item_count(command.item)<command.quantity or not target.can_insert{name=command.item,count=command.quantity} then error("Insufficient source or destination capacity") end
      end
    elseif command.kind=="mine" then
      exact(command,{"kind","name","x","y","quantity"});bounded(command.quantity,1,20)
      if type(command.name)~="string" or not command.name:match("^[a-z0-9][a-z0-9-]*$") or #command.name>64 then error("Invalid mine target") end
      if type(command.x)~="number" or type(command.y)~="number" or command.x~=command.x or command.y~=command.y or math.abs(command.x)>1000000 or math.abs(command.y)>1000000 or distance(a.position,{x=command.x,y=command.y})>6 then error("Mine target out of reach") end
      for _,candidate in pairs(a.surface.find_entities_filtered{position={command.x,command.y},radius=0.6,name=command.name}) do
        if candidate.valid and (candidate.type=="resource" or candidate.type=="tree") then target=candidate;break end
      end
      if not target or not target.minable then error("Mine target missing or not minable") end
    elseif command.kind=="craft" then
      exact(command,{"kind","recipe","quantity"});bounded(command.quantity,1,20)
      if type(command.recipe)~="string" or not command.recipe:match("^[a-z0-9][a-z0-9-]*$") or #command.recipe>64 or not a.force.recipes[command.recipe] or not a.force.recipes[command.recipe].enabled then error("Recipe unavailable") end
      if a.get_craftable_count(command.recipe)<command.quantity then error("Insufficient crafting inputs") end
    elseif command.kind=="place" then
      exact(command,{"kind","item","x","y"})
      if type(command.item)~="string" or not command.item:match("^[a-z0-9][a-z0-9-]*$") or #command.item>64 then error("Invalid place item") end
      local prototype=prototypes.item[command.item]
      if not prototype or not prototype.place_result or a.get_item_count(command.item)<1 then error("Place item unavailable") end
      if type(command.x)~="number" or type(command.y)~="number" or command.x~=command.x or command.y~=command.y or math.abs(command.x)>1000000 or math.abs(command.y)>1000000 or distance(a.position,{x=command.x,y=command.y})>6 then error("Place target out of reach") end
      if not a.surface.can_place_entity{name=prototype.place_result.name,position={command.x,command.y},force=a.force} then error("Place target blocked") end
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
  local receipt={version=1,operationId=req.operationId,digest=req.digest,worldId=w.worldId,historyId=w.historyId,actorId=req.actorId,status="pending",startTick=game.tick,request=raw}
  storage.qs_receipts[req.operationId]=receipt;storage.qs_busy[req.actorId]=req.operationId
  if command.kind=="move" then
    receipt.target={x=command.x,y=command.y};receipt.deadline=game.tick+command.maxTicks
    if storage.qs_pending then storage.qs_pending[req.operationId]=true end;return receipt
  end
  if command.kind=="mine" then
    local mined=0
    for _=1,command.quantity do if not target.valid or not a.mine_entity(target) then break end;mined=mined+1 end
    receipt.quantity=mined;receipt.item=command.name
    return finish(req.operationId,mined>0 and "completed" or "failed",mined>0 and "Mined in game" or "Mining failed")
  end
  if command.kind=="craft" then
    local started=a.begin_crafting{count=command.quantity,recipe=command.recipe}
    receipt.quantity=started;receipt.item=command.recipe
    return finish(req.operationId,started==command.quantity and "completed" or "failed",started==command.quantity and "Craft queued in game" or "Craft queue rejected")
  end
  if command.kind=="place" then
    local prototype=prototypes.item[command.item]
    local placed=a.surface.create_entity{name=prototype.place_result.name,position={command.x,command.y},force=a.force}
    if not placed then return finish(req.operationId,"failed","Placement rejected") end
    local removed=a.remove_item{name=command.item,count=1}
    if removed~=1 then placed.destroy();return finish(req.operationId,"failed","Place item disappeared") end
    receipt.quantity=1;receipt.item=command.item;receipt.targetId=placed.unit_number
    return finish(req.operationId,"completed","Built from inventory")
  end
  local source=command.kind=="take" and target or a
  local dest=command.kind=="take" and a or target
  local removed=source.remove_item{name=command.item,count=command.quantity}
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
    for _,e in pairs(game.surfaces[1].find_entities_filtered{name="wooden-chest"}) do
      local c=contents(e);c.unit=e.unit_number;c.x=e.position.x;c.y=e.position.y;chests[#chests+1]=c
    end
    local productionSites={};local omittedSites=0
    for _,e in pairs(game.surfaces[1].find_entities_filtered{type="furnace"}) do
      if #productionSites<16 then
        productionSites[#productionSites+1]={unit=e.unit_number,name=e.name,x=e.position.x,y=e.position.y,inventory=contents(e)}
      else omittedSites=omittedSites+1 end
    end
    return {version="0.1.1",tick=game.tick,actors=actors,actorCount=#actors,world=world(),chests=chests,furnaces=#game.surfaces[1].find_entities_filtered{name="stone-furnace"},paused=storage.qs_paused or false,
      productionSites=productionSites,omittedSites=omittedSites,resourceMap=resource_map(),rocketLaunches=storage.qs_rocket_launches or 0,lastRocketTick=storage.qs_last_rocket_tick}
  end
})

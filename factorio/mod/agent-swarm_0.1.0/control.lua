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
  return {ironOre=e.get_item_count("iron-ore"),coal=e.get_item_count("coal"),ironPlate=e.get_item_count("iron-plate")}
end
local function observation(id,radius)
  local a=actor(id);radius=bounded(radius or 32,1,32)
  local entries={};local omitted=0
  for _,e in pairs(a.surface.find_entities_filtered{position=a.position,radius=radius}) do
    if e.valid and e.unit_number and (e.type=="container" or e.type=="furnace" or e.type=="resource" or e.type=="tree") then
      if #entries<100 then
        entries[#entries+1]={unit=e.unit_number,name=e.name,type=e.type,x=e.position.x,y=e.position.y,items=(e.type=="container" or e.type=="furnace") and contents(e) or nil}
      else omitted=omitted+1 end
    end
  end
  return {actorId=id,x=a.position.x,y=a.position.y,inventory=contents(a),nearby=entries,omitted=omitted,tick=game.tick,world=world(),paused=storage.qs_paused or false}
end
local function finish(id,status,detail)
  local receipt=storage.qs_receipts[id]
  receipt.status=status;receipt.detail=detail;receipt.endTick=game.tick
  storage.qs_busy[receipt.actorId]=nil
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
local function submit(raw)
  if type(raw)~="string" or #raw>4096 then error("Oversized request") end
  local req=helpers.json_to_table(raw)
  if type(req)~="table" or req.version~=1 then error("Invalid protocol") end
  exact(req,{"version","worldId","historyId","operationId","actorId","command","digest"})
  local w=world()
  if req.worldId~=w.worldId or req.historyId~=w.historyId then error("World/history mismatch") end
  if type(req.operationId)~="string" or #req.operationId>96 or not req.operationId:match("^[%w_.:-]+$") then error("Invalid operation ID") end
  if type(req.digest)~="string" or #req.digest~=64 or not req.digest:match("^[0-9a-f]+$") then error("Invalid digest") end
  storage.qs_receipts=storage.qs_receipts or {};storage.qs_busy=storage.qs_busy or {}
  local existing=storage.qs_receipts[req.operationId]
  if existing then
    if existing.request~=raw then error("Operation ID content changed") end
    return existing
  end
  if storage.qs_paused then error("World paused") end
  local a=actor(req.actorId)
  if storage.qs_busy[req.actorId] then error("Actor has pending operation") end
  local command=req.command
  if type(command)~="table" then error("Missing command") end
  -- Validate every argument before recording or mutating resources.
  local target
  if command.kind=="move" then
    exact(command,{"kind","x","y","maxTicks"})
    if type(command.x)~="number" or type(command.y)~="number" or command.x~=command.x or command.y~=command.y or math.abs(command.x)>1000000 or math.abs(command.y)>1000000 then error("Invalid position") end
    if distance(a.position,{x=command.x,y=command.y})>32 then error("Movement outside local radius") end
    bounded(command.maxTicks,1,600)
  elseif command.kind=="take" or command.kind=="put" then
    exact(command,{"kind","targetId","item","quantity"})
    target=target_for(a,command.targetId);bounded(command.quantity,1,20)
    if command.item~="iron-ore" and command.item~="coal" and command.item~="iron-plate" then error("Unsupported item") end
    if command.kind=="take" then
      if target.get_item_count(command.item)<command.quantity or not a.can_insert{name=command.item,count=command.quantity} then error("Insufficient source or destination capacity") end
    else
      if a.get_item_count(command.item)<command.quantity or not target.can_insert{name=command.item,count=command.quantity} then error("Insufficient source or destination capacity") end
    end
  else error("Unsupported command") end
  local receipt={version=1,operationId=req.operationId,digest=req.digest,worldId=w.worldId,historyId=w.historyId,actorId=req.actorId,status="pending",startTick=game.tick,request=raw}
  storage.qs_receipts[req.operationId]=receipt;storage.qs_busy[req.actorId]=req.operationId
  if command.kind=="move" then
    receipt.target={x=command.x,y=command.y};receipt.deadline=game.tick+command.maxTicks
    return receipt
  end
  local source=command.kind=="take" and target or a
  local dest=command.kind=="take" and a or target
  local removed=source.remove_item{name=command.item,count=command.quantity}
  local inserted=dest.insert{name=command.item,count=removed}
  if inserted<removed then source.insert{name=command.item,count=removed-inserted} end
  receipt.quantity=inserted;receipt.item=command.item;receipt.targetId=target.unit_number
  return finish(req.operationId,inserted==command.quantity and "completed" or "failed",inserted==command.quantity and "Transferred" or "Capacity changed")
end
script.on_event(defines.events.on_tick,function()
  for id,receipt in pairs(storage.qs_receipts or {}) do
    if receipt.status=="pending" and receipt.target then
      local ok,a=pcall(actor,receipt.actorId)
      if not ok then finish(id,"failed","Actor lost")
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
end)
remote.add_interface("agent_swarm", {
  observe=observation,
  submit=submit,
  receipt=function(id) return (storage.qs_receipts or {})[id] end,
  control=function(paused)
    if type(paused)~="boolean" then error("Expected pause flag") end
    storage.qs_paused=paused;return {paused=paused,tick=game.tick}
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
    return {version="0.1.0",tick=game.tick,actors=actors,world=world(),chests=chests,furnaces=#game.surfaces[1].find_entities_filtered{name="stone-furnace"},paused=storage.qs_paused or false}
  end
})

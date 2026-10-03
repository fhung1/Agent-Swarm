script.on_init(function()
  local surface=game.surfaces[1]
  local settings=surface.map_gen_settings
  settings.seed=424242
  settings.peaceful_mode=true
  surface.map_gen_settings=settings
  surface.request_to_generate_chunks({0,0},3)
  surface.force_generate_chunk_requests()
  local spawn=surface.find_non_colliding_position("character",{0,0},64,1)
  if not spawn then error("No safe spawn") end
  storage.qs_spawn=spawn
  for i=1,10 do
    local p=surface.find_non_colliding_position("character",{spawn.x+i*2,spawn.y},32,0.5)
    local actor=surface.create_entity{name="character",position=p,force="player"}
    if not actor then error("Failed actor spawn") end
  end
  if "SCENARIO_NAME"=="cooperative-starter" then
    local p=surface.find_non_colliding_position("wooden-chest",{spawn.x,spawn.y+4},32,1)
    local chest=surface.create_entity{name="wooden-chest",position=p,force="player"}
    chest.insert{name="iron-ore",count=50}; chest.insert{name="coal",count=20}
    for i=1,2 do
      local fp=surface.find_non_colliding_position("stone-furnace",{spawn.x+i*3,spawn.y+8},32,1)
      assert(surface.create_entity{name="stone-furnace",position=fp,force="player"})
    end
  end
  game.forces.player.set_spawn_position(spawn,surface)
end)

remote.add_interface("qs_world", {metadata=function()
  return {worldId="WORLD_ID",historyId="HISTORY_ID",scenario="SCENARIO_NAME",seed=424242,spawn=storage.qs_spawn}
end})

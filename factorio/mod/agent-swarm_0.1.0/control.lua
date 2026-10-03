-- Runtime status only. Validated mutation protocol lands in the next work package.
remote.add_interface("agent_swarm", {
  status = function()
    local actors = {}
    for _, surface in pairs(game.surfaces) do
      for _, e in pairs(surface.find_entities_filtered{name="character"}) do
        if e.valid and not e.player then
          actors[#actors+1] = {unit=e.unit_number, x=e.position.x, y=e.position.y}
        end
      end
    end
    local world=remote.call("qs_world","metadata")
    local chest_items={}
    for _, e in pairs(game.surfaces[1].find_entities_filtered{name="wooden-chest"}) do
      chest_items[#chest_items+1]={unit=e.unit_number,ironOre=e.get_item_count("iron-ore"),coal=e.get_item_count("coal")}
    end
    return {version="0.1.0",tick=game.tick,actors=actors,world=world,chests=chest_items,
      furnaces=#game.surfaces[1].find_entities_filtered{name="stone-furnace"}}
  end
})

import { z } from 'zod';
export const InspectSchema = z.discriminatedUnion('kind', [
  z.object({kind: z.literal('layout'), x: z.number().finite().min(-1000000).max(1000000), y: z.number().finite().min(-1000000).max(1000000), radius: z.number().int().min(1).max(16), offset: z.number().int().min(0).max(10000).default(0)}).strict(),
  z.object({kind: z.literal('machine'), id: z.number().int().positive().max(2147483647)}).strict(),
  z.object({kind: z.literal('task'), id: z.string().max(96)}).strict(),
  z.object({kind: z.literal('receipt'), id: z.string().max(180)}).strict(),
  z.object({kind: z.literal('map'), resource: z.string().regex(/^[a-z0-9-]{1,64}$/)}).strict(),
  z.object({kind: z.literal('research')}).strict(),
  z.object({kind: z.literal('reference'), query: z.string().max(160)}).strict(),
]);
export type Inspection = z.infer<typeof InspectSchema>;
export const PlanWriteSchema = z.object({section: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/).refine(s => !['constructor','prototype'].includes(s)), content: z.string().min(1).max(1700)}).strict();
export interface PlanSection {revision: number; content: string; updatedTick: number}
export type OverseerPlan = Record<string, PlanSection>;
const list = (value: unknown): any[] => Array.isArray(value) ? value : [];
/** No plan/strategy is generated here. These are loss-labelled factual projections. */
export function compactGameStatus(status: Record<string, any>, previous: Record<string, string> = {}) {
  const signatures: Record<string, string> = {};
  const sites = list(status.productionSites).map(e => ({id: e.unit, name: e.name, x: e.x, y: e.y, direction: e.direction,
    status: e.statusName, fuel: e.fuel?.items, burningEnergy: e.fuel ? Math.round(e.fuel.remainingEnergy ?? 0) : undefined,
    recipe: e.recipe?.name}));
  const changes = sites.filter(e => {
    const key = `${e.id}:${e.x}:${e.y}`;
    // Bucket fuel energy to avoid treating normal per-tick consumption as a new event.
    signatures[key] = JSON.stringify({...e, burningEnergy: undefined});
    return previous[key] !== signatures[key];
  });
  const counts: Record<string, number> = {};
  for (const site of sites) counts[site.name] = (counts[site.name] ?? 0) + 1;
  return {signatures, briefing: {world: status.world, tick: status.tick, paused: status.paused,
    actors: list(status.actors).map(a => ({id: a.unit, x: a.x, y: a.y, inventory: a.inventory?.items ?? a.inventory})),
    automation: status.automation, storage: list(status.chests).map(c => ({id: c.unit, x: c.x, y: c.y, items: c.items})),
    machineCounts: counts, machineAlerts: sites.filter(e => !['working','normal'].includes(e.status)).slice(0,16), omittedMachineAlerts: Math.max(0,sites.filter(e => !['working','normal'].includes(e.status)).length-16), changedMachines: changes.slice(0, 12), omittedChangedMachines: Math.max(0, changes.length - 12),
    removedMachineKeys: Object.keys(previous).filter(k => !(k in signatures)).slice(0, 12),
    omittedGlobalSites: status.omittedSites, resourceTotals: status.resourceMap?.totals,
    mapCoverage: status.resourceMap?.coverage, research: {current: status.research?.current, progress: status.research?.progress},
    rocketLaunches: status.rocketLaunches,
    detailNotice: 'Coordinates, full inventories/recipes, deposits, research prerequisites and layouts are available through inspect. No listed change does not mean a machine is working.'}};
}
export function planBrief(plan: OverseerPlan = {}) {
  return {current: plan.current, assignments: plan.assignments,
    sections: Object.entries(plan).map(([section, value]) => ({section, revision: value.revision, updatedTick: value.updatedTick})),
    note: 'Current and assignments are loaded automatically when authored. Use read_plan for other sections; write_plan authors/replaces one section.'};
}

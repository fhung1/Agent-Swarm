import { z } from 'zod';

export const gameSchema = z.enum(['factorio', 'minecraft']);
export type Game = z.infer<typeof gameSchema>;

const coordinate = z.number().int().min(0).max(1000);
const duration = z.number().int().min(30).max(600);
const point = { x: coordinate, y: coordinate };
const button = z.enum(['left', 'right']);
const key = z.enum([
  'w', 'a', 's', 'd', 'e', 'f', 'q', 'r',
  '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
  'tab', 'space', 'escape', 'shift', 'control',
  'up', 'down', 'left', 'right',
]);

export const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('key'), key, durationMs: duration }).strict(),
  z.object({ type: z.literal('keys'), keys: z.array(key).min(2).max(3), durationMs: duration }).strict(),
  z.object({ type: z.literal('click'), ...point, button, durationMs: duration }).strict(),
  z.object({ type: z.literal('hold_mouse'), ...point, button, durationMs: duration }).strict(),
  z.object({ type: z.literal('mouse_button'), button, durationMs: duration }).strict(),
  z.object({ type: z.literal('drag'), ...point, x2: coordinate, y2: coordinate, button, durationMs: duration }).strict(),
  z.object({ type: z.literal('move'), ...point }).strict(),
  z.object({ type: z.literal('scroll'), ...point, amount: z.number().int().min(-5).max(5).refine(value => value !== 0) }).strict(),
  z.object({ type: z.literal('look'), dx: z.number().int().min(-120).max(120),
    dy: z.number().int().min(-120).max(120), durationMs: duration }).strict(),
  z.object({ type: z.literal('wait'), durationMs: duration }).strict(),
]);

export const planSchema = z.object({
  reason: z.string().min(1).max(240),
  done: z.boolean(),
  actions: z.array(actionSchema).max(4),
}).strict().superRefine((plan, ctx) => {
  if (plan.done && plan.actions.length) {
    ctx.addIssue({ code: 'custom', message: 'A completed plan cannot include actions', path: ['actions'] });
  }
  if (plan.actions.reduce((total, action) => total + ('durationMs' in action ? action.durationMs : 0), 0) > 2000) {
    ctx.addIssue({ code: 'custom', message: 'Action sequence exceeds 2000 ms', path: ['actions'] });
  }
  for (const [index, action] of plan.actions.entries()) {
    if (action.type === 'keys' && new Set(action.keys).size !== action.keys.length) {
      ctx.addIssue({ code: 'custom', message: 'Repeated keys are not allowed', path: ['actions', index, 'keys'] });
    }
    if (action.type === 'look' && action.dx === 0 && action.dy === 0) {
      ctx.addIssue({ code: 'custom', message: 'Look movement cannot be zero', path: ['actions', index] });
    }
  }
});

export type GameAction = z.infer<typeof actionSchema>;
export type GamePlan = z.infer<typeof planSchema>;

export function parsePlan(text: string, game: Game = 'factorio'): GamePlan {
  const trimmed = text.trim();
  const json = trimmed.startsWith('```')
    ? trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    : trimmed;
  const plan = planSchema.parse(JSON.parse(json) as unknown);
  if (game === 'factorio' && plan.actions.some(action =>
    action.type === 'look' || action.type === 'keys' || action.type === 'mouse_button' ||
    (action.type === 'key' && ['shift', 'control'].includes(action.key)))) {
    throw new Error('Minecraft camera or modifier actions are not available in Factorio');
  }
  return plan;
}

import { z } from 'zod';
const name = z.string().regex(/^[a-z0-9_]{1,64}$/);
const position = z.object({x:z.number().finite().min(-30000000).max(30000000),y:z.number().finite().min(-64).max(320),z:z.number().finite().min(-30000000).max(30000000)}).strict();
export const Command = z.discriminatedUnion('kind',[
  z.object({kind:z.literal('wait'),seconds:z.number().min(0).max(10)}).strict(),
  z.object({kind:z.literal('move'),position}).strict(),
  z.object({kind:z.literal('collect'),block:name,count:z.number().int().min(1).max(16)}).strict(),
  z.object({kind:z.literal('craft'),item:name,count:z.number().int().min(1).max(16)}).strict(),
  z.object({kind:z.literal('equip'),item:name}).strict(),
  z.object({kind:z.literal('eat'),item:name}).strict(),
  z.object({kind:z.literal('place'),item:name,position}).strict(),
  z.object({kind:z.literal('attack'),entityId:z.number().int().nonnegative()}).strict(),
  z.object({kind:z.literal('chest'),operation:z.enum(['deposit','withdraw']),item:name,count:z.number().int().min(1).max(64),position}).strict(),
  z.object({kind:z.literal('give'),recipient:z.string().regex(/^qs-agent-\d{1,2}$/),item:name,count:z.number().int().min(1).max(64)}).strict(),
  z.object({kind:z.literal('post'),recipient:z.string().max(64),messageKind:z.enum(['observation','request','offer','commitment','result','warning']),body:z.string().min(1).max(2000)}).strict(),
  z.object({kind:z.literal('share'),label:name,position}).strict(),
  z.object({kind:z.literal('review'),id:z.string().max(128),state:z.enum(['confirmed','disputed','stale'])}).strict(),
]);
export type CommandValue=z.infer<typeof Command>;
export const Decision=z.object({action:Command,reason:z.string().min(1).max(1000),citations:z.array(z.string().max(128)).max(20)}).strict();
export const SYSTEM='You are one independent Minecraft agent. Use only the provided bounded commands and local observations. Cooperate through SpacetimeDB messages/knowledge only; no in-game chat, code, server commands or coordinator. Shared reports are unverified until observed. Cite reports you use. Work toward the shared goal. Do not assume failed actions succeeded. Return one action.';

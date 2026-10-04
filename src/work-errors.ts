export class PermanentWorkError extends Error {}
export class DeferredWorkError extends Error {}

export function isPermanent(error: unknown): boolean {
  if (error instanceof PermanentWorkError) return true;
  if (error instanceof DeferredWorkError) return false;
  const status = (error as { status?: number })?.status;
  if (status !== undefined) return status >= 400 && status < 500 && ![408, 409, 429].includes(status);
  const message = String(error);
  if (/paused|not active|lease expired|task not owned|connection|timeout|aborted|capacity busy|run access required|role not authorized/i.test(message)) return false;
  return /budget exhausted|monetary budget exhausted|attempts exhausted|no model price|pricing version|usage exceeded reservation|provider omitted usage|unknown evidence|no evidence|invalid|schema|ZodError|missing.*key|credentials|declined|truncated|incomplete/i.test(message);
}

import { createHash } from 'node:crypto';

// Preserve existing short IDs; long inputs get a collision-resistant, bounded derivation.
export function recordId(prefix: string, base: string, suffix = ''): string {
  const readable = `${prefix}${base}${suffix}`;
  if (readable.length <= 128) return readable;
  return `${prefix}${createHash('sha256').update(readable).digest('hex')}${suffix}`;
}

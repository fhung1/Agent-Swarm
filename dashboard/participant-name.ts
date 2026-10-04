/** Keep a readable label while guaranteeing a valid, stable local-board name. */
export function participantName(input: string, identity: string): string {
  const name = input.trim().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 64);
  return name || `browser-${identity.slice(-16)}`;
}

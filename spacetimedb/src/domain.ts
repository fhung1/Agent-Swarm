// Exact fixed-point comparisons for order quantities and prices; no floating-point fill totals.
export function decimal(value: string, digits: number, positive = false): bigint {
  if (typeof value !== 'string' || value.length > 40 || !new RegExp(`^(0|[1-9]\\d*)(\\.\\d{1,${digits}})?$`).test(value)) {
    throw new Error('Invalid decimal amount');
  }
  const [whole, fraction = ''] = value.split('.');
  const amount = BigInt(whole) * 10n ** BigInt(digits) + BigInt(fraction.padEnd(digits, '0'));
  if (positive && amount <= 0n) throw new Error('Amount must be positive');
  return amount;
}

const transitions: Record<string, readonly string[]> = {
  submitting: ['accepted', 'pending_new', 'new', 'partially_filled', 'filled', 'canceled', 'expired', 'rejected', 'pending_cancel', 'replaced', 'done_for_day'],
  pending_new: ['accepted', 'new', 'partially_filled', 'filled', 'pending_cancel', 'canceled', 'expired', 'rejected', 'replaced', 'done_for_day'],
  accepted: ['pending_new', 'new', 'partially_filled', 'filled', 'pending_cancel', 'canceled', 'expired', 'rejected', 'replaced', 'done_for_day'],
  new: ['partially_filled', 'filled', 'pending_cancel', 'canceled', 'expired', 'rejected', 'replaced', 'done_for_day'],
  partially_filled: ['filled', 'pending_cancel', 'canceled', 'expired', 'replaced', 'done_for_day'],
  pending_cancel: ['partially_filled', 'filled', 'canceled', 'expired', 'rejected', 'replaced', 'done_for_day'],
  done_for_day: ['new', 'partially_filled', 'filled', 'pending_cancel', 'canceled', 'expired', 'replaced'],
  filled: [], canceled: [], expired: [], rejected: [], replaced: [],
};

export function validOrderTransition(from: string, to: string): boolean {
  return Object.prototype.hasOwnProperty.call(transitions, from) && (from === to || transitions[from].includes(to));
}

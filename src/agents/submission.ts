import { evaluateRisk, type RiskInput, type RiskPolicy } from './risk.ts';

export interface SubmissionInput {
  connected: boolean;
  authorized: boolean;
  accountId: string;
  reservationAccountId: string;
  policyId: string;
  snapshotId: string;
  quoteId: string;
  risk: { outcome: string; expiresAt: Date; policyId: string; snapshotId: string; quoteId: string } | undefined;
  input: RiskInput;
  policy: RiskPolicy;
  reconciliationStatus: string | undefined;
}

// This supplements the module's risk-only reservation gate immediately before POST.
// Lookups/reconciliation are deliberately independent so a paused run can still recover an accepted order.
export function submissionBlock(input: SubmissionInput): string | undefined {
  if (!input.connected || !input.authorized) return 'Executor connection or grant is no longer valid';
  if (input.accountId !== input.reservationAccountId) return 'Reservation belongs to another account';
  if (input.reconciliationStatus === 'mismatch') return 'Account reconciliation has an unresolved mismatch';
  const risk = input.risk;
  if (!risk || risk.outcome !== 'pass' || risk.expiresAt.getTime() <= input.input.now.getTime()) return 'Risk pass expired or missing';
  if (risk.policyId !== input.policyId || risk.snapshotId !== input.snapshotId || risk.quoteId !== input.quoteId) return 'Risk inputs changed';
  const result = evaluateRisk(input.input, input.policy);
  if (result.outcome !== 'pass') return `Current risk rejects: ${result.checks.filter(c => !c.pass).map(c => c.name).join(', ')}`;
  return undefined;
}

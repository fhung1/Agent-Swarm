export type ReadinessStatus = 'implemented' | 'fixture-verified' | 'live-verified' | 'blocked';

export type ApplicationId = 'factorio' | 'minecraft' | 'paper';

export interface GateEvidence {
  implemented: boolean;
  fixtureVerified?: boolean;
  liveVerified?: boolean;
}

export function readinessStatus(evidence: GateEvidence): ReadinessStatus {
  if (evidence.liveVerified) return 'live-verified';
  if (evidence.fixtureVerified) return 'fixture-verified';
  if (evidence.implemented) return 'implemented';
  return 'blocked';
}

export function releaseStatus(liveGates: ReadinessStatus[]): ReadinessStatus {
  return liveGates.length > 0 && liveGates.every(status => status === 'live-verified')
    ? 'live-verified'
    : 'blocked';
}

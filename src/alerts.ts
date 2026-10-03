import { parseOpenOrders, parsePositions, type RiskPolicy } from './agents/risk.ts';

export type AlertSeverity = 'critical' | 'warning';
export type AlertRule = 'account_snapshot_stale' | 'market_quote_stale' | 'order_stuck' |
  'executor_silent' | 'trade_stream_silent' | 'order_rejected' | 'account_mismatch' |
  'market_clock_stale' | 'account_data_invalid' | 'exposure_breach';

export interface AlertThresholds {
  accountSnapshotMaxAgeMs: number;
  quoteMaxAgeMs: number;
  stuckOrderMs: number;
  serviceSilentMs: number;
}

export const DEFAULT_ALERT_THRESHOLDS: AlertThresholds = {
  accountSnapshotMaxAgeMs: 60_000,
  quoteMaxAgeMs: 120_000,
  stuckOrderMs: 300_000,
  serviceSilentMs: 45_000,
};

export interface AlertFinding {
  key: string;
  rule: AlertRule;
  subject: string;
  severity: AlertSeverity;
  message: string;
}

export interface AlertQuote { symbol: string; bidPrice: string; askPrice: string; asOf: Date }
export interface AlertOrder { id: string; status: string; updatedAt: Date }
export interface AlertServiceHeartbeat { role: string; status: string; lastSeen: Date }
export interface AlertReservation {
  symbol: string;
  side: string;
  notional: string;
  clientOrderId?: string;
}

export interface AlertAccountSnapshot {
  accountStatus: string;
  capturedAt: Date;
  positionsJson: string;
  openOrdersJson: string;
}

export interface AlertInput {
  accountId: string;
  now: Date;
  marketOpen: boolean;
  universeSymbols: readonly string[];
  snapshot?: AlertAccountSnapshot;
  quotes: readonly AlertQuote[];
  orders: readonly AlertOrder[];
  services: readonly AlertServiceHeartbeat[];
  marketClockLastSeen?: Date;
  reconciliation?: { status: string; details: string };
  policy?: RiskPolicy;
  reservations?: readonly AlertReservation[];
  tradeStreamExpected?: boolean;
  tradeStreamConnected?: boolean;
  tradeStreamLastMessageAt?: Date;
}

function age(now: Date, at: Date | undefined): number {
  return at ? now.getTime() - at.getTime() : Number.POSITIVE_INFINITY;
}

function stale(value: number, maxAgeMs: number): boolean {
  return !Number.isFinite(value) || value < 0 || value > maxAgeMs;
}

function ageLabel(value: number): string {
  return Number.isFinite(value) ? `${Math.max(0, Math.round(value / 1000))}s old` : 'age unknown';
}

function validThresholds(thresholds: AlertThresholds): void {
  for (const [name, value] of Object.entries(thresholds)) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`Invalid alert threshold ${name}`);
  }
}

export function parseAlertThresholds(value: unknown): AlertThresholds {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Alert config must be an object');
  const row = value as Record<string, unknown>;
  const expected = Object.keys(DEFAULT_ALERT_THRESHOLDS);
  if (Object.keys(row).length !== expected.length || expected.some(key => !(key in row))) {
    throw new Error(`Alert config must contain exactly: ${expected.join(', ')}`);
  }
  const thresholds = row as unknown as AlertThresholds;
  validThresholds(thresholds);
  return thresholds;
}

function quoteExposurePrice(quotes: readonly AlertQuote[], symbol: string, now: Date, maxAgeMs: number): number | undefined {
  const row = [...quotes].filter(q => q.symbol === symbol && age(now, q.asOf) >= 0 && age(now, q.asOf) <= maxAgeMs)
    .sort((a, b) => b.asOf.getTime() - a.asOf.getTime())[0];
  if (!row) return undefined;
  const bid = Number(row.bidPrice), ask = Number(row.askPrice);
  return Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask >= bid ? ask : undefined;
}

function exposureBySymbol(input: AlertInput, thresholds: AlertThresholds): Map<string, number> | undefined {
  const snapshot = input.snapshot;
  const policy = input.policy;
  if (!snapshot || !policy) return undefined;
  try {
    const values = new Map<string, number>();
    const add = (symbol: string, amount: number) => values.set(symbol, (values.get(symbol) ?? 0) + amount);
    for (const position of parsePositions(snapshot.positionsJson)) add(position.symbol, Math.abs(position.marketValue));

    const brokerOrders = parseOpenOrders(snapshot.openOrdersJson);
    const openClientIds = new Set(brokerOrders.map(order => order.clientOrderId).filter((id): id is string => !!id));
    for (const order of brokerOrders) {
      if (order.side !== 'buy') continue;
      const price = order.price ?? quoteExposurePrice(input.quotes, order.symbol, input.now, thresholds.quoteMaxAgeMs);
      if (order.notional === undefined && (price === undefined || order.remainingQty < 0)) return undefined;
      add(order.symbol, order.notional ?? order.remainingQty * price!);
    }
    for (const reservation of input.reservations ?? []) {
      if (reservation.side !== 'buy' || (reservation.clientOrderId && openClientIds.has(reservation.clientOrderId))) continue;
      if (!/^(0|[1-9]\d*)(\.\d+)?$/.test(reservation.notional)) return undefined;
      const notional = Number(reservation.notional);
      if (!Number.isFinite(notional)) return undefined;
      add(reservation.symbol, notional);
    }
    return values;
  } catch {
    return undefined;
  }
}

function finding(rule: AlertRule, subject: string, severity: AlertSeverity, message: string): AlertFinding {
  return { key: `${rule}:${subject}`, rule, subject, severity, message };
}

export function evaluateAlerts(input: AlertInput, thresholds: AlertThresholds = DEFAULT_ALERT_THRESHOLDS): AlertFinding[] {
  validThresholds(thresholds);
  const alerts: AlertFinding[] = [];
  const accountAge = age(input.now, input.snapshot?.capturedAt);
  if (!input.snapshot || stale(accountAge, thresholds.accountSnapshotMaxAgeMs) || input.snapshot.accountStatus !== 'ACTIVE') {
    const detail = !input.snapshot ? 'No account snapshot has been recorded' :
      `Account snapshot is ${ageLabel(accountAge)} or reports ${input.snapshot.accountStatus}`;
    alerts.push(finding('account_snapshot_stale', input.accountId, 'critical', detail));
  }

  if (input.marketOpen) {
    const latest = new Map<string, AlertQuote>();
    for (const quote of input.quotes) {
      const previous = latest.get(quote.symbol);
      if (!previous || quote.asOf.getTime() > previous.asOf.getTime()) latest.set(quote.symbol, quote);
    }
    for (const symbol of [...new Set(input.universeSymbols)].sort()) {
      const quote = latest.get(symbol);
      const quoteAge = age(input.now, quote?.asOf);
      if (!quote || stale(quoteAge, thresholds.quoteMaxAgeMs)) {
        const detail = !quote ? `No quote for ${symbol} during market hours` :
          `Quote for ${symbol} is ${ageLabel(quoteAge)}`;
        alerts.push(finding('market_quote_stale', symbol, 'critical', detail));
      }
    }
  }

  const clockAge = age(input.now, input.marketClockLastSeen);
  if (stale(clockAge, thresholds.serviceSilentMs)) {
    alerts.push(finding('market_clock_stale', input.accountId, 'critical',
      `Alpaca market clock is ${input.marketClockLastSeen ? ageLabel(clockAge) : 'not recorded'}`));
  }

  const stuckStatuses = new Set(['submitting', 'accepted', 'pending_new', 'new', 'partially_filled', 'pending_cancel', 'done_for_day']);
  for (const order of input.orders) {
    if (order.status === 'rejected') {
      alerts.push(finding('order_rejected', order.id, 'critical', `Order ${order.id} was rejected`));
    } else if (stuckStatuses.has(order.status)) {
      const orderAge = age(input.now, order.updatedAt);
      if (stale(orderAge, thresholds.stuckOrderMs)) {
        alerts.push(finding('order_stuck', order.id, 'warning',
          `Order ${order.id} has remained ${order.status} for ${ageLabel(orderAge)}`));
      }
    }
  }

  const executors = input.services.filter(service => service.role === 'executor');
  const executor = [...executors].sort((a, b) => b.lastSeen.getTime() - a.lastSeen.getTime())[0];
  const executorAge = age(input.now, executor?.lastSeen);
  const liveExecutor = executors.some(service => service.status === 'online' &&
    !stale(age(input.now, service.lastSeen), thresholds.serviceSilentMs));
  if (!liveExecutor) {
    const detail = !executor ? 'No executor heartbeat is visible' :
      `Executor heartbeat is ${executor.status}; last seen ${ageLabel(executorAge)}`;
    alerts.push(finding('executor_silent', input.accountId, 'critical', detail));
  }

  if (input.tradeStreamExpected && (!input.tradeStreamConnected || stale(age(input.now, input.tradeStreamLastMessageAt), thresholds.serviceSilentMs))) {
    const streamAge = age(input.now, input.tradeStreamLastMessageAt);
    alerts.push(finding('trade_stream_silent', input.accountId, 'critical',
      `Trade-update stream is ${input.tradeStreamConnected ? 'connected without a recent update' : 'disconnected'}; last update ${input.tradeStreamLastMessageAt ? ageLabel(streamAge) : 'not recorded'}`));
  }

  if (input.reconciliation?.status === 'mismatch') {
    alerts.push(finding('account_mismatch', input.accountId, 'critical',
      input.reconciliation.details || 'Account reconciliation has an unresolved mismatch'));
  }

  if (input.snapshot) {
    try {
      parsePositions(input.snapshot.positionsJson);
      parseOpenOrders(input.snapshot.openOrdersJson);
    } catch (error) {
      alerts.push(finding('account_data_invalid', input.accountId, 'critical', `Account snapshot cannot be parsed: ${String(error)}`));
    }
  }

  if (input.policy && input.snapshot) {
    const exposure = exposureBySymbol(input, thresholds);
    if (exposure) {
      const portfolioLimit = input.policy.maxPortfolioNotional;
      const portfolio = [...exposure.values()].reduce((sum, value) => sum + value, 0);
      if (portfolioLimit !== undefined && portfolio > portfolioLimit) {
        alerts.push(finding('exposure_breach', `${input.accountId}:portfolio`, 'critical',
          `Gross portfolio exposure ${portfolio.toFixed(2)} exceeds ${portfolioLimit.toFixed(2)}`));
      }
      for (const [symbol, value] of exposure) if (value > input.policy.maxPositionNotional) {
        alerts.push(finding('exposure_breach', `${input.accountId}:${symbol}`, 'critical',
          `${symbol} exposure ${value.toFixed(2)} exceeds ${input.policy.maxPositionNotional.toFixed(2)}`));
      }
    }
  }

  return alerts.sort((a, b) => a.severity.localeCompare(b.severity) || a.key.localeCompare(b.key));
}

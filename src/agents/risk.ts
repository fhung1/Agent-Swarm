// Deterministic paper-trading risk gate. No model is involved; the same inputs always give the same result.
// Amounts use JavaScript numbers, which is adequate for small paper notionals but not for live accounting.

export interface RiskPolicy {
  version: string;
  allowedSymbols: readonly string[];
  longOnly: boolean;
  maxOrderNotional: number;
  maxPositionNotional: number;
  maxQuoteAgeMs: number;
  maxAccountAgeMs: number;
  maxLimitDeviation: number; // Fraction of the quote midpoint, e.g. 0.05.
  approvalTtlMs: number;
}

export interface ProposalInput { symbol: string; side: string; quantity: string; orderType: string; limitPrice: string }
export interface QuoteInput { symbol: string; bidPrice: string; askPrice: string; asOf: Date }
export interface AccountInput {
  status: string; buyingPower: string; positionsJson: string; openOrdersJson: string; capturedAt: Date;
}
// Other proposals already past risk review (risk_passed, approved, submitting) that may not reach Alpaca yet.
export interface PendingIntent { proposalId: string; symbol: string; side: string }
export interface RiskInput {
  proposal: ProposalInput & { id: string };
  pendingIntents: PendingIntent[];
  quote?: QuoteInput;
  account?: AccountInput;
  runStatus: string;
  marketOpen: boolean; // From Alpaca's clock, not local time.
  now: Date;
}

export interface RiskCheck { name: string; pass: boolean; detail: string }
export interface RiskResult { outcome: 'pass' | 'reject'; checks: RiskCheck[]; expiresAt: Date }

interface Position { symbol: string; qty: number; marketValue: number }
interface OpenOrder { symbol: string; side: string; remainingQty: number; price?: number; notional?: number }

function num(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function rows(json: string): Record<string, unknown>[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) throw new Error('expected an array');
  return parsed.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object');
}

function parsePositions(json: string): Position[] {
  return rows(json).map(r => ({
    symbol: String(r.symbol ?? ''),
    qty: num(r.qty) ?? 0,
    marketValue: num(r.market_value) ?? 0,
  }));
}

function parseOpenOrders(json: string): OpenOrder[] {
  return rows(json).map(r => ({
    symbol: String(r.symbol ?? ''),
    side: String(r.side ?? ''),
    remainingQty: Math.max(0, (num(r.qty) ?? 0) - (num(r.filled_qty) ?? 0)),
    price: num(r.limit_price) ?? num(r.stop_price),
    notional: num(r.notional),
  }));
}

export function evaluateRisk(input: RiskInput, policy: RiskPolicy): RiskResult {
  const checks: RiskCheck[] = [];
  const check = (name: string, pass: boolean, detail: string) => { checks.push({ name, pass, detail }); return pass; };
  const { proposal, quote, account, now } = input;
  const qty = num(proposal.quantity);
  const limit = num(proposal.limitPrice);

  check('run_active', input.runStatus === 'active', `run status ${input.runStatus}`);
  check('symbol_allowed', policy.allowedSymbols.includes(proposal.symbol), proposal.symbol);
  check('market_open', input.marketOpen, input.marketOpen ? 'open' : 'closed');
  const validParams = check('order_params',
    ['buy', 'sell'].includes(proposal.side) && ['market', 'limit'].includes(proposal.orderType) &&
      qty !== undefined && qty > 0 && (proposal.orderType !== 'limit' || (limit !== undefined && limit > 0)),
    `${proposal.side} ${proposal.quantity} ${proposal.orderType} ${proposal.limitPrice}`.trim());

  // Market data
  const bid = num(quote?.bidPrice);
  const ask = num(quote?.askPrice);
  const quoteAge = quote ? now.getTime() - quote.asOf.getTime() : Infinity;
  const quoteOk = check('quote_fresh',
    !!quote && quote.symbol === proposal.symbol && quoteAge >= -5_000 && quoteAge <= policy.maxQuoteAgeMs &&
      bid !== undefined && ask !== undefined && bid > 0 && ask >= bid,
    quote ? `bid ${quote.bidPrice} ask ${quote.askPrice}, ${Math.round(quoteAge / 1000)}s old` : 'no quote');

  // Account state
  let positions: Position[] = [];
  let openOrders: OpenOrder[] = [];
  let accountOk = false;
  if (!account) {
    check('account_fresh', false, 'no account snapshot');
  } else {
    const age = now.getTime() - account.capturedAt.getTime();
    accountOk = check('account_fresh', age >= 0 && age <= policy.maxAccountAgeMs && account.status === 'ACTIVE',
      `status ${account.status}, ${Math.round(age / 1000)}s old`);
    try {
      positions = parsePositions(account.positionsJson);
      openOrders = parseOpenOrders(account.openOrdersJson);
    } catch (error) {
      accountOk = check('account_parse', false, String(error));
    }
  }

  if (validParams && quoteOk && accountOk && qty !== undefined && bid !== undefined && ask !== undefined) {
    const isBuy = proposal.side === 'buy';
    // Worst expected execution price: the limit for limit orders, the far side of the quote for market orders.
    const price = proposal.orderType === 'limit' ? limit! : isBuy ? ask : bid;
    const notional = qty * price;
    const mid = (bid + ask) / 2;
    const forSymbol = openOrders.filter(o => o.symbol === proposal.symbol);
    const orderValue = (o: OpenOrder) => o.notional ?? o.remainingQty * (o.price ?? mid);

    if (proposal.orderType === 'limit') {
      const deviation = Math.abs(limit! - mid) / mid;
      check('limit_near_quote', deviation <= policy.maxLimitDeviation,
        `limit ${limit} is ${(deviation * 100).toFixed(2)}% from mid ${mid.toFixed(4)}`);
    }
    check('order_notional', notional <= policy.maxOrderNotional,
      `${notional.toFixed(2)} vs cap ${policy.maxOrderNotional}`);
    const brokerDupes = forSymbol.filter(o => o.side === proposal.side).length;
    const swarmDupes = input.pendingIntents.filter(p =>
      p.proposalId !== proposal.id && p.symbol === proposal.symbol && p.side === proposal.side).length;
    check('no_duplicate_intent', brokerDupes + swarmDupes === 0,
      `${brokerDupes} open ${proposal.side} orders and ${swarmDupes} pending proposals for ${proposal.symbol}`);

    const held = positions.find(p => p.symbol === proposal.symbol);
    if (isBuy) {
      const pendingBuys = openOrders.filter(o => o.side === 'buy').reduce((sum, o) => sum + orderValue(o), 0);
      const buyingPower = num(account!.buyingPower) ?? 0;
      check('buying_power', notional + pendingBuys <= buyingPower,
        `${notional.toFixed(2)} + pending ${pendingBuys.toFixed(2)} vs ${buyingPower.toFixed(2)}`);
      const pendingSymbol = forSymbol.filter(o => o.side === 'buy').reduce((sum, o) => sum + orderValue(o), 0);
      const exposure = Math.abs(held?.marketValue ?? 0) + pendingSymbol + notional;
      check('position_limit', exposure <= policy.maxPositionNotional,
        `${exposure.toFixed(2)} vs cap ${policy.maxPositionNotional}`);
    } else if (policy.longOnly) {
      // Notional-only orders have no share quantity; convert them at the quote midpoint.
      const pendingSells = forSymbol.filter(o => o.side === 'sell')
        .reduce((sum, o) => sum + (o.remainingQty || (o.notional ?? 0) / mid), 0);
      const available = Math.max(0, (held?.qty ?? 0) - pendingSells);
      check('long_only_sell', qty <= available, `sell ${qty} vs ${available} available`);
    }
  }

  const outcome = checks.every(c => c.pass) ? 'pass' : 'reject';
  return { outcome, checks, expiresAt: new Date(now.getTime() + policy.approvalTtlMs) };
}

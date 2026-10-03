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
  maxPortfolioNotional?: number;
  maxOpenOrders?: number;
  maxDailyLoss?: number;
  maxProposalAgeMs: number; // Older proposals were decided on information that may have changed.
  requireMarketOpen: boolean; // When false, orders may queue at Alpaca for the next session.
}

export interface ProposalInput {
  symbol: string; side: string; quantity: string; orderType: string; limitPrice: string; createdAt: Date;
}
export interface QuoteInput { symbol: string; bidPrice: string; askPrice: string; asOf: Date }
export interface AccountInput {
  dailyPnl?: string;
  status: string; buyingPower: string; positionsJson: string; openOrdersJson: string; capturedAt: Date;
}
// Other proposals already past risk review (risk_passed, approved, submitting) that may not reach Alpaca yet.
export interface PendingIntent {
  proposalId: string; symbol: string; side: string; quantity?: string; notional?: string;
  clientOrderId?: string;
}
export interface RiskInput {
  proposal: ProposalInput & { id: string };
  pendingIntents: PendingIntent[];
  quote?: QuoteInput;
  quotes?: QuoteInput[];
  account?: AccountInput;
  runStatus: string;
  marketOpen: boolean; // From Alpaca's clock, not local time.
  now: Date;
}

export interface RiskCheck { name: string; pass: boolean; detail: string }
export interface RiskResult { outcome: 'pass' | 'reject'; checks: RiskCheck[]; expiresAt: Date }

interface Position { symbol: string; qty: number; marketValue: number }
interface OpenOrder { clientOrderId?: string; symbol: string; side: string; remainingQty: number; price?: number; notional?: number }

function num(value: unknown): number | undefined {
  if ((typeof value !== 'string' && typeof value !== 'number') || value === '' ||
      !/^-?(0|[1-9]\d*)(\.\d+)?$/.test(String(value))) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function requiredNumber(value: unknown, label: string, nonnegative = false): number {
  const n = num(value);
  if (n === undefined || (nonnegative && n < 0)) throw new Error(`Invalid ${label}`);
  return n;
}

function symbol(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Z][A-Z0-9.-]{0,15}$/.test(value)) throw new Error('Invalid position/order symbol');
  return value;
}

function rows(json: string): Record<string, unknown>[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed) || parsed.some(r => !r || typeof r !== 'object' || Array.isArray(r))) {
    throw new Error('Expected an array of account rows');
  }
  return parsed;
}

export function parsePositions(json: string): Position[] {
  const seen = new Set<string>();
  return rows(json).map(r => {
    const name = symbol(r.symbol);
    if (seen.has(name)) throw new Error(`Duplicate position ${name}`);
    seen.add(name);
    return { symbol: name, qty: requiredNumber(r.qty, 'position quantity'),
      marketValue: requiredNumber(r.market_value, 'position market value') };
  });
}

export function parseOpenOrders(json: string): OpenOrder[] {
  return rows(json).map(r => {
    const name = symbol(r.symbol);
    if (r.side !== 'buy' && r.side !== 'sell') throw new Error('Invalid open order side');
    const filled = requiredNumber(r.filled_qty ?? (r.qty == null ? '0' : undefined), 'filled quantity', true);
    const notional = r.notional == null ? undefined : requiredNumber(r.notional, 'open order notional', true);
    const qty = r.qty == null ? undefined : requiredNumber(r.qty, 'open order quantity', true);
    if (qty === undefined && !(notional && notional > 0)) throw new Error('Order needs quantity or notional');
    if (qty !== undefined && (qty <= 0 || filled > qty)) throw new Error('Invalid remaining order quantity');
    const priceField = r.limit_price ?? r.stop_price;
    const price = priceField == null ? undefined : requiredNumber(priceField, 'open order price', true);
    if (price !== undefined && price <= 0) throw new Error('Invalid open order price');
    return { symbol: name, side: r.side, remainingQty: qty === undefined ? 0 : qty - filled,
      price, notional, clientOrderId: typeof r.client_order_id === 'string' ? r.client_order_id : undefined };
  });
}

export function validatePolicy(policy: RiskPolicy): void {
  if (!policy.version || !Array.isArray(policy.allowedSymbols) || !policy.allowedSymbols.length ||
      policy.allowedSymbols.length > 50 || new Set(policy.allowedSymbols).size !== policy.allowedSymbols.length ||
      typeof policy.longOnly !== 'boolean' || typeof policy.requireMarketOpen !== 'boolean') throw new Error('Invalid risk policy');
  policy.allowedSymbols.forEach(symbol);
  for (const name of ['maxOrderNotional', 'maxPositionNotional', 'maxQuoteAgeMs', 'maxAccountAgeMs',
    'maxLimitDeviation', 'approvalTtlMs', 'maxProposalAgeMs'] as const) {
    if (!Number.isFinite(policy[name]) || policy[name] <= 0) throw new Error(`Invalid policy ${name}`);
  }
  for (const value of [policy.maxPortfolioNotional, policy.maxOpenOrders, policy.maxDailyLoss]) {
    if (value !== undefined && (!Number.isFinite(value) || value <= 0)) throw new Error('Invalid aggregate policy limit');
  }
}

export function evaluateRisk(input: RiskInput, policy: RiskPolicy): RiskResult {
  const checks: RiskCheck[] = [];
  const check = (name: string, pass: boolean, detail: string) => { checks.push({ name, pass, detail }); return pass; };
  const { proposal, quote, account, now } = input;
  try { validatePolicy(policy); } catch (error) {
    return { outcome: 'reject', checks: [{ name: 'policy_valid', pass: false, detail: String(error) }], expiresAt: now };
  }
  const qty = num(proposal.quantity);
  const limit = num(proposal.limitPrice);

  check('run_active', input.runStatus === 'active', `run status ${input.runStatus}`);
  check('symbol_allowed', policy.allowedSymbols.includes(proposal.symbol), proposal.symbol);
  check('market_open', input.marketOpen || !policy.requireMarketOpen,
    `${input.marketOpen ? 'open' : 'closed'}${policy.requireMarketOpen ? '' : ' (not required)'}`);
  const proposalAge = now.getTime() - proposal.createdAt.getTime();
  check('proposal_fresh', proposalAge >= -5_000 && proposalAge <= policy.maxProposalAgeMs,
    `${Math.round(proposalAge / 1000)}s old`);
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
      requiredNumber(account.buyingPower, 'buying power', true);
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
    const quoteFor = (name: string) => [quote!, ...(input.quotes ?? [])].find(q => {
      const age = now.getTime() - q.asOf.getTime();
      const qb = num(q.bidPrice), qa = num(q.askPrice);
      return q.symbol === name && age >= 0 && age <= policy.maxQuoteAgeMs &&
        qb !== undefined && qa !== undefined && qb > 0 && qa >= qb;
    });
    const orderValue = (o: OpenOrder) => {
      if (o.notional !== undefined) return o.notional;
      const mark = quoteFor(o.symbol);
      const price = o.price ?? (mark ? Number(mark.askPrice) : undefined);
      if (price === undefined) throw new Error(`No fresh price for pending ${o.symbol} order`);
      return o.remainingQty * price;
    };
    const pending = input.pendingIntents.filter(p => p.proposalId !== proposal.id &&
      !(p.clientOrderId && openOrders.some(o => o.clientOrderId === p.clientOrderId)));
    const brokerDupes = forSymbol.filter(o => o.side === proposal.side).length;
    const swarmDupes = pending.filter(p => p.symbol === proposal.symbol && p.side === proposal.side).length;
    check('no_duplicate_intent', brokerDupes + swarmDupes === 0,
      `${brokerDupes} open ${proposal.side} orders and ${swarmDupes} pending proposals for ${proposal.symbol}`);

    let reserved = 0;
    let reservedSymbol = 0;
    let reservedSellQty = 0;
    let pendingBuys = 0;
    let pendingSymbol = 0;
    try {
      for (const p of pending) {
        symbol(p.symbol);
        if (p.side !== 'buy' && p.side !== 'sell') throw new Error('Invalid pending side');
        const quantity = requiredNumber(p.quantity, 'pending quantity', true);
        const value = requiredNumber(p.notional, 'pending notional', true);
        if (quantity <= 0 || value <= 0) throw new Error('Invalid pending reservation');
        if (p.side === 'buy') { reserved += value; if (p.symbol === proposal.symbol) reservedSymbol += value; }
        else if (p.symbol === proposal.symbol) reservedSellQty += quantity;
      }
      pendingBuys = openOrders.filter(o => o.side === 'buy').reduce((sum, o) => sum + orderValue(o), 0);
      pendingSymbol = forSymbol.filter(o => o.side === 'buy').reduce((sum, o) => sum + orderValue(o), 0);
    } catch (error) {
      check('pending_exposure', false, String(error));
      return { outcome: 'reject', checks, expiresAt: new Date(now.getTime() + policy.approvalTtlMs) };
    }

    if (proposal.orderType === 'limit') {
      const deviation = Math.abs(limit! - mid) / mid;
      check('limit_near_quote', deviation <= policy.maxLimitDeviation,
        `limit ${limit} is ${(deviation * 100).toFixed(2)}% from mid ${mid.toFixed(4)}`);
    }
    check('order_notional', notional <= policy.maxOrderNotional,
      `${notional.toFixed(2)} vs cap ${policy.maxOrderNotional}`);
    if (policy.maxOpenOrders !== undefined) check('open_order_limit',
      openOrders.length + pending.length + 1 <= policy.maxOpenOrders, 'Broker orders plus reserved intents');
    if (policy.maxPortfolioNotional !== undefined && isBuy) check('portfolio_limit',
      positions.reduce((sum, p) => sum + Math.abs(p.marketValue), 0) + pendingBuys + reserved + notional <= policy.maxPortfolioNotional,
      'Current gross exposure plus pending buys and reservations');
    if (policy.maxDailyLoss !== undefined) {
      const pnl = num(account!.dailyPnl);
      check('daily_loss', pnl !== undefined && pnl > -policy.maxDailyLoss, 'Current account day P&L required');
    }
    const held = positions.find(p => p.symbol === proposal.symbol);
    if (isBuy) {

      const buyingPower = num(account!.buyingPower) ?? 0;
      check('buying_power', notional + pendingBuys + reserved <= buyingPower,
        `${notional.toFixed(2)} + pending ${(pendingBuys + reserved).toFixed(2)} vs ${buyingPower.toFixed(2)}`);

      const exposure = Math.abs(held?.marketValue ?? 0) + pendingSymbol + reservedSymbol + notional;
      check('position_limit', exposure <= policy.maxPositionNotional,
        `${exposure.toFixed(2)} vs cap ${policy.maxPositionNotional}`);
    } else if (policy.longOnly) {
      // Notional-only orders have no share quantity; convert them at the quote midpoint.
      const pendingSells = forSymbol.filter(o => o.side === 'sell')
        .reduce((sum, o) => sum + (o.remainingQty || (o.notional ?? 0) / mid), 0);
      const available = Math.max(0, (held?.qty ?? 0) - pendingSells - reservedSellQty);
      check('long_only_sell', qty <= available, `sell ${qty} vs ${available} available`);
    }
  }

  const outcome = checks.every(c => c.pass) ? 'pass' : 'reject';
  return { outcome, checks, expiresAt: new Date(now.getTime() + policy.approvalTtlMs) };
}

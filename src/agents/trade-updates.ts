import { createHash } from 'node:crypto';

const EVENTS = new Set([
  'new', 'fill', 'partial_fill', 'canceled', 'expired', 'done_for_day', 'replaced', 'rejected',
  'pending_new', 'pending_cancel', 'order_replace_rejected', 'order_cancel_rejected',
]);

export interface TradeUpdate {
  id: string;
  alpacaOrderId: string;
  clientOrderId: string;
  event: string;
  brokerStatus: string;
  executionId: string;
  brokerTimestamp: Date;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${label}`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, max = 256): string {
  if (typeof value !== 'string' || !value || value.length > max) throw new Error(`Invalid ${label}`);
  return value;
}

export function parseTradeUpdate(value: unknown): TradeUpdate | undefined {
  const envelope = object(value, 'trade update envelope');
  if (envelope.stream !== 'trade_updates') return undefined;
  const data = object(envelope.data, 'trade update');
  const event = text(data.event, 'trade update event', 64);
  if (!EVENTS.has(event)) throw new Error(`Unsupported trade update event ${event}`);
  const order = object(data.order, 'trade update order');
  const alpacaOrderId = text(order.id, 'Alpaca order ID', 128);
  const clientOrderId = text(order.client_order_id, 'client order ID', 128);
  const brokerStatus = text(order.status, 'broker order status', 64);
  const executionId = typeof data.execution_id === 'string' ? data.execution_id.slice(0, 128) : '';
  const rawTimestamp = text(data.timestamp ?? order.updated_at, 'trade update timestamp', 64);
  const brokerTimestamp = new Date(rawTimestamp);
  if (!Number.isFinite(brokerTimestamp.getTime())) throw new Error('Invalid trade update timestamp');
  const fingerprint = [alpacaOrderId, clientOrderId, event, brokerStatus, executionId, brokerTimestamp.toISOString(),
    String(order.filled_qty ?? ''), String(data.qty ?? ''), String(data.price ?? '')].join('\0');
  const id = `trade.${createHash('sha256').update(fingerprint).digest('hex')}`;
  return { id, alpacaOrderId, clientOrderId, event, brokerStatus, executionId, brokerTimestamp };
}

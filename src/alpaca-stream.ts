import { WebSocket } from 'undici';
import type { AlpacaCredentials } from './alpaca-client.js';
import { parseTradeUpdate, type TradeUpdate } from './agents/trade-updates.js';

const PAPER_STREAM = 'wss://paper-api.alpaca.markets/stream';

export interface TradeStream {
  stop(): void;
}

export function startTradeStream(
  credentials: AlpacaCredentials,
  onUpdate: (update: TradeUpdate) => void,
  onState: (connected: boolean, detail: string) => void,
): TradeStream {
  let socket: WebSocket | undefined;
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let attempts = 0;

  const messageText = async (data: string | ArrayBuffer | Blob): Promise<string> => {
    if (typeof data === 'string') return data;
    if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
    return await data.text();
  };

  const reconnect = (detail: string) => {
    onState(false, detail);
    if (stopped || timer) return;
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(attempts++, 5));
    timer = setTimeout(() => { timer = undefined; connect(); }, delay);
  };

  const connect = () => {
    if (stopped) return;
    socket = new WebSocket(PAPER_STREAM);
    socket.addEventListener('open', () => {
      socket?.send(JSON.stringify({ action: 'auth', key: credentials.apiKey, secret: credentials.apiSecret }));
    });
    socket.addEventListener('message', event => { void (async () => {
      try {
        // Alpaca's paper trade stream sends binary frames even when the negotiated codec is JSON.
        const message: unknown = JSON.parse(await messageText(event.data));
        const envelope = message && typeof message === 'object' ? message as Record<string, unknown> : undefined;
        if (envelope?.stream === 'authorization') {
          const data = envelope.data as Record<string, unknown> | undefined;
          if (data?.status !== 'authorized') { socket?.close(1008, 'authorization failed'); return; }
          attempts = 0;
          socket?.send(JSON.stringify({ action: 'listen', data: { streams: ['trade_updates'] } }));
          return;
        }
        if (envelope?.stream === 'listening') {
          const streams = (envelope.data as { streams?: unknown } | undefined)?.streams;
          if (!Array.isArray(streams) || !streams.includes('trade_updates')) {
            socket?.close(1008, 'trade_updates unavailable'); return;
          }
          onState(true, 'authorized and listening');
          return;
        }
        const update = parseTradeUpdate(message);
        if (update) onUpdate(update);
      } catch (error) {
        onState(false, `invalid trade update: ${String((error as Error).message ?? error)}`);
      }
    })(); });
    socket.addEventListener('error', () => reconnect('trade update socket error'));
    socket.addEventListener('close', event => reconnect(`trade update socket closed (${event.code})`));
  };

  connect();
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      socket?.close(1000, 'executor stopped');
    },
  };
}

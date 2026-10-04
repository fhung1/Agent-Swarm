export const RETRYABLE_TRANSPORT_FAILURE = 75;

const transientCodes = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET',
]);

/** Recognize provider transport failures and request timeouts wrapped by SDK. */
export function isTransientTransportFailure(error: unknown): boolean {
  const seen = new Set<object>();
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current && typeof current === 'object' && !seen.has(current); depth++) {
    seen.add(current);
    const value = current as { code?: unknown; cause?: unknown; name?: unknown; message?: unknown };
    if (typeof value.code === 'string' && transientCodes.has(value.code)) return true;
    if (typeof value.name === 'string' && /^(APIConnectionError|APIConnectionError2)$/.test(value.name)) return true;
    if ((value.name === 'TimeoutError' || value.name === 'AbortError') &&
      typeof value.message === 'string' && /timeout/i.test(value.message)) return true;
    current = value.cause;
  }
  return false;
}

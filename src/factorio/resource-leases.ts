/** Renew resources independently of model latency. Never reacquire a lost lease. */
export interface ResourceLease {
  path: string; holder: string; taskId: string;
  expiresAt: { microsSinceUnixEpoch: bigint };
}
export class ResourceLeases {
  private paths = new Set<string>();
  private timer?: ReturnType<typeof setInterval>;
  private inflight?: Promise<void>;
  private stopped = false;
  constructor(private options: {
    sender: string; taskId: string; snapshot: () => readonly ResourceLease[];
    validate: () => void; renew: (path: string) => Promise<unknown>;
    onLost: (error: unknown) => void; intervalMs?: number; timeoutMs?: number;
  }) {
    const interval = options.intervalMs ?? 15_000;
    const timeout = options.timeoutMs ?? 5_000;
    if (!Number.isInteger(interval) || interval < 1 || interval > 15_000 ||
        !Number.isInteger(timeout) || timeout < 1 || timeout > 5_000) throw Error('Invalid lease renewal limits');
  }
  track(path: string): void { this.paths.add(path); }
  release(path: string): void { this.paths.delete(path); }
  start(): void {
    if (this.stopped || this.timer) return;
    this.timer = setInterval(() => {
      void this.refresh().catch(error => {
        if (!this.stopped) { this.stop(); this.options.onLost(error); }
      });
    }, this.options.intervalMs ?? 15_000);
  }
  stop(): void { this.stopped = true; clearInterval(this.timer); this.timer = undefined; }
  refresh(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.inflight) return this.inflight;
    this.inflight = this.renewTracked().finally(() => { this.inflight = undefined; });
    return this.inflight;
  }
  private async renewTracked(): Promise<void> {
    for (const path of [...this.paths]) {
      if (this.stopped) return;
      if (!this.paths.has(path)) continue;
      this.options.validate();
      const lease = this.options.snapshot().find(row => row.path === path);
      if (!lease || lease.holder !== this.options.sender || lease.taskId !== this.options.taskId ||
          lease.expiresAt.microsSinceUnixEpoch <= BigInt(Date.now()) * 1000n) {
        throw Error(`Resource lease lost: ${path}; reconcile before acting`);
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([this.options.renew(path), new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(Error(`Resource renewal uncertain: ${path}; reconcile before acting`)),
            this.options.timeoutMs ?? 5_000);
        })]);
      } finally { clearTimeout(timer); }
    }
  }
}

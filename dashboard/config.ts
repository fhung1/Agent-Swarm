declare const __DASHBOARD_CONFIG__: { host?: string; database?: string } | undefined;

export function dashboardConfig(defaultDatabase: string): { host: string; database: string } {
  const configured = typeof __DASHBOARD_CONFIG__ === 'undefined' ? undefined : __DASHBOARD_CONFIG__;
  return { host: configured?.host ?? 'ws://127.0.0.1:3000', database: configured?.database ?? defaultDatabase };
}

export function dashboardTokenKey(kind: string, host: string, database: string): string {
  const prefix = `quant-swarm:${kind}:token`;
  const defaultDatabase = kind === 'dashboard' ? 'quant-swarm' : 'quant-swarm-coord';
  return host === 'ws://127.0.0.1:3000' && database === defaultDatabase ? prefix : `${prefix}:${host}:${database}`;
}

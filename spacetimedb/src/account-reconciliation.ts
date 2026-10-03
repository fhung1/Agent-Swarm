// Fixed-point cash and quantity reconciliation. Price changes affect equity, not the cash/quantity ledger.
function units(value:string,digits:number):bigint {
  if(typeof value!=='string'||value.length>40||!new RegExp(`^-?(0|[1-9]\\d*)(\\.\\d{1,${digits}})?$`).test(value))throw new Error('Invalid ledger decimal');
  const negative=value.startsWith('-');const [whole,fraction='']=value.replace(/^-/,'').split('.');
  return (BigInt(whole)*10n**BigInt(digits)+BigInt(fraction.padEnd(digits,'0')))*(negative?-1n:1n);
}
function positions(json:string):Map<string,bigint>{
  const rows=JSON.parse(json);if(!Array.isArray(rows))throw new Error('Positions must be an array');
  const result=new Map<string,bigint>();
  for(const row of rows){if(!row||typeof row.symbol!=='string'||!/^[A-Z][A-Z0-9.-]{0,15}$/.test(row.symbol)||result.has(row.symbol))throw new Error('Invalid or duplicate position');result.set(row.symbol,units(String(row.qty),6));}
  return result;
}
export interface LedgerFill {symbol:string;side:string;quantity:string;price:string}
export function accountDifferences(baseline:{cash:string;positionsJson:string},broker:{cash:string;positionsJson:string},fills:LedgerFill[]):string[]{
  let cash=units(baseline.cash,18);const expected=positions(baseline.positionsJson);const actual=positions(broker.positionsJson);
  for(const fill of fills){if(!['buy','sell'].includes(fill.side))throw new Error('Invalid fill side');const direction=fill.side==='buy'?1n:-1n;const qty=units(fill.quantity,6);const price=units(fill.price,12);if(qty<=0n||price<=0n)throw new Error('Invalid fill amount');expected.set(fill.symbol,(expected.get(fill.symbol)??0n)+direction*qty);cash-=direction*qty*price;}
  const issues:string[]=[];
  // Alpaca account cash is reported in cents; allow at most one cent of rounding.
  const delta=units(broker.cash,18)-cash;if(delta>10n**16n||delta<-(10n**16n))issues.push('Cash differs from baseline plus recorded fills (fees, transfers or external trades require reconciliation)');
  for(const symbol of new Set([...expected.keys(),...actual.keys()]))if((expected.get(symbol)??0n)!==(actual.get(symbol)??0n))issues.push(`Position quantity mismatch: ${symbol}`);
  return issues;
}

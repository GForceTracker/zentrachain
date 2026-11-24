import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Real-time blockchain activity for the community chat heading.
// Keyless public feeds: TRON global TRC20 transfers, Ethereum latest blocks
// (Blockscout v2), Bitcoin mempool (mempool.space). Each transaction is returned
// raw; the client assigns it to a community member name.

function response(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info", "Access-Control-Allow-Methods": "POST, OPTIONS", "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

type Tx = { asset: string; network: string; amount: number; tx_hash: string; ts: number | null };

let cache: { at: number; txs: Tx[] } = { at: 0, txs: [] };

async function getJson(url: string, init?: RequestInit, timeoutMs = 9000): Promise<unknown> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally { clearTimeout(t); }
}

async function tron(): Promise<Tx[]> {
  const d = await getJson("https://api.trongrid.io/v1/token_trc20/transfers?limit=20") as { data?: Array<{ transaction_id?: string; value?: string; token_info?: { symbol?: string; decimals?: number }; block_timestamp?: number }> };
  return (d.data || []).filter(t => String(t.token_info?.symbol || "").toUpperCase() === "USDT").map(t => ({
    asset: "USDT", network: "TRC20",
    amount: Number(t.value || 0) / 10 ** Number(t.token_info?.decimals ?? 6),
    tx_hash: String(t.transaction_id || ""), ts: Number(t.block_timestamp || 0) || null,
  })).filter(t => t.amount > 0 && t.tx_hash);
}

async function ethereum(): Promise<Tx[]> {
  const d = await getJson("https://eth.blockscout.com/api/v2/transactions?filter=validated") as { items?: Array<{ hash?: string; value?: string; timestamp?: string }> };
  return (d.items || []).slice(0, 20).map(t => ({
    asset: "ETH", network: "ETHEREUM",
    amount: Number(BigInt(String(t.value || "0"))) / 1e18,
    tx_hash: String(t.hash || ""), ts: t.timestamp ? Math.floor(Date.parse(t.timestamp) / 1000) : null,
  })).filter(t => t.amount > 0 && t.tx_hash);
}

async function bitcoin(): Promise<Tx[]> {
  const d = await getJson("https://mempool.space/api/mempool/recent", { headers: { Accept: "application/json" } }) as Array<{ txid?: string; value?: number }>;
  return (d || []).slice(0, 20).map(t => ({
    asset: "BTC", network: "BITCOIN",
    amount: Number(t.value || 0) / 1e8,
    tx_hash: String(t.txid || ""), ts: null,
  })).filter(t => t.amount > 0 && t.tx_hash);
}

function mix(a: Tx[], b: Tx[], c: Tx[]): Tx[] {
  const out: Tx[] = []; const max = Math.max(a.length, b.length, c.length);
  for (let i = 0; i < max; i++) { if (a[i]) out.push(a[i]); if (b[i]) out.push(b[i]); if (c[i]) out.push(c[i]); }
  return out;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Max-Age": "86400" } });
  if (req.method !== "POST") return response({ error: "Method not allowed" }, 405);
  try {
    if (Date.now() - cache.at < 10000 && cache.txs.length) return response({ ok: true, txs: cache.txs });
    const results = await Promise.allSettled([tron(), ethereum(), bitcoin()]);
    const txs = mix(
      results[0].status === "fulfilled" ? results[0].value : [],
      results[1].status === "fulfilled" ? results[1].value : [],
      results[2].status === "fulfilled" ? results[2].value : []
    ).slice(0, 16).map(t => ({ ...t, amount: Math.round(t.amount * 1e6) / 1e6 }));
    if (txs.length) cache = { at: Date.now(), txs };
    return response({ ok: true, txs, sources: results.map(r => r.status) });
  } catch (e) {
    console.error("chat-activity failed", e);
    return response({ error: "Live chain activity is temporarily unavailable" }, 500);
  }
});

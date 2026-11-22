// verify-payout: checks a withdrawal transaction hash against free public
// blockchain APIs before an admin records the payout.
// POST {asset, network, tx_hash} -> {verified, status, confirmations, ...}
// Free, no-key sources: mempool.space (BTC), blockchair (ETH/DOGE),
// BSC public RPC (BEP20), Tronscan public API (TRON), Solana public RPC (SOL).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const reply = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

async function getJson(url: string, init?: RequestInit, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...init, signal: ctrl.signal });
    const text = await r.text();
    let data: unknown = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    return { ok: r.ok, status: r.status, data };
  } finally {
    clearTimeout(t);
  }
}

function explorerUrl(network: string, hash: string) {
  const n = network.toUpperCase();
  if (n === "TRC20" || n === "TRON" || n === "TRX") return `https://tronscan.org/#/transaction/${hash}`;
  if (n === "ERC20" || n === "ETHEREUM") return `https://etherscan.io/tx/${hash}`;
  if (n === "BEP20" || n === "BNB") return `https://bscscan.com/tx/${hash}`;
  if (n === "BITCOIN" || n === "BTC") return `https://mempool.space/tx/${hash}`;
  if (n === "DOGECOIN" || n === "DOGE") return `https://blockchair.com/dogecoin/transaction/${hash}`;
  if (n === "SOLANA" || n === "SOL") return `https://solscan.io/tx/${hash}`;
  return "";
}

type Verdict = { verified: boolean; status: string; confirmations: number | null; note: string };

async function checkBitcoin(hash: string): Promise<Verdict> {
  const tx = await getJson(`https://mempool.space/api/tx/${hash}`);
  if (!tx.ok || !tx.data || typeof tx.data !== "object") {
    return { verified: false, status: "not_found", confirmations: null, note: "Transaction not found on Bitcoin." };
  }
  const st = (tx.data as { status?: { confirmed?: boolean; block_height?: number } }).status || {};
  if (!st.confirmed || !st.block_height) {
    return { verified: false, status: "pending", confirmations: 0, note: "Transaction is in the mempool but not confirmed yet." };
  }
  const tip = await getJson("https://mempool.space/api/blocks/tip/height");
  const tipH = typeof tip.data === "number" ? tip.data : null;
  const conf = tipH != null ? Math.max(1, tipH - st.block_height + 1) : null;
  return { verified: true, status: "confirmed", confirmations: conf, note: `Confirmed in Bitcoin block ${st.block_height}.` };
}

async function checkBlockchair(chain: "ethereum" | "dogecoin", label: string, hash: string): Promise<Verdict> {
  const r = await getJson(`https://api.blockchair.com/${chain}/dashboards/transaction/${hash}`);
  const rec = (r.data as { data?: Record<string, { transaction?: { block_id?: number } }> } | null)?.data?.[hash];
  const blockId = rec?.transaction?.block_id;
  if (!r.ok || blockId == null) {
    return { verified: false, status: "not_found", confirmations: null, note: `Transaction not found on ${label}.` };
  }
  if (blockId <= 0) {
    return { verified: false, status: "pending", confirmations: 0, note: `Transaction is seen on ${label} but not confirmed yet.` };
  }
  return { verified: true, status: "confirmed", confirmations: null, note: `Confirmed on ${label} in block ${blockId}.` };
}

async function checkBsc(hash: string): Promise<Verdict> {
  const rpc = "https://bsc-dataseed.binance.org";
  const hdr = { "Content-Type": "application/json" };
  const rcpt = await getJson(rpc, { method: "POST", headers: hdr, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [hash] }) });
  const receipt = (rcpt.data as { result?: { status?: string; blockNumber?: string } | null } | null)?.result;
  if (!rcpt.ok || !receipt) {
    return { verified: false, status: "not_found", confirmations: null, note: "Transaction not found on BNB Smart Chain." };
  }
  if (receipt.status !== "0x1") {
    return { verified: false, status: "failed", confirmations: null, note: "Transaction exists on BNB Smart Chain but it FAILED." };
  }
  const tip = await getJson(rpc, { method: "POST", headers: hdr, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "eth_blockNumber", params: [] }) });
  const tipN = (tip.data as { result?: string } | null)?.result;
  const conf = tipN && receipt.blockNumber ? Math.max(1, parseInt(tipN, 16) - parseInt(receipt.blockNumber, 16) + 1) : null;
  return { verified: true, status: "confirmed", confirmations: conf, note: "Confirmed on BNB Smart Chain." };
}

async function checkTron(hash: string): Promise<Verdict> {
  const r = await getJson(`https://apilist.tronscanapi.com/api/transaction-info?hash=${hash}`);
  const d = r.data as { contractRet?: string; confirmed?: boolean; confirmations?: number; confirmedTimes?: number } | null;
  if (!r.ok || !d || (!d.contractRet && d.confirmed !== true && d.confirmations == null && d.confirmedTimes == null)) {
    return { verified: false, status: "not_found", confirmations: null, note: "Transaction not found on TRON." };
  }
  if (d.contractRet && d.contractRet !== "SUCCESS") {
    return { verified: false, status: "failed", confirmations: null, note: `Transaction on TRON returned ${d.contractRet}.` };
  }
  const conf = d.confirmedTimes ?? d.confirmations ?? null;
  return { verified: true, status: "confirmed", confirmations: typeof conf === "number" ? conf : null, note: "Confirmed on TRON." };
}

async function checkSolana(hash: string): Promise<Verdict> {
  const r = await getJson("https://api.mainnet-beta.solana.com", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTransaction", params: [hash, { encoding: "json", maxSupportedTransactionVersion: 0 }] }),
  });
  const tx = (r.data as { result?: { meta?: { err?: unknown }; slot?: number } | null } | null)?.result;
  if (!r.ok || !tx) {
    return { verified: false, status: "not_found", confirmations: null, note: "Transaction not found on Solana." };
  }
  if (tx.meta && tx.meta.err != null) {
    return { verified: false, status: "failed", confirmations: null, note: "Transaction exists on Solana but it FAILED." };
  }
  return { verified: true, status: "confirmed", confirmations: null, note: `Confirmed on Solana (slot ${tx.slot ?? "?"}).` };
}

function normalizeNetwork(network: string): string {
  const n = String(network || "").trim().toUpperCase();
  if (n === "BTC") return "BITCOIN";
  if (n === "ETH") return "ETHEREUM";
  if (n === "BNB") return "BEP20";
  if (n === "DOGE") return "DOGECOIN";
  if (n === "TRX") return "TRON";
  if (n === "SOL") return "SOLANA";
  return n;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply({ error: "Method not allowed" }, 405);
  let body: { asset?: string; network?: string; tx_hash?: string };
  try {
    body = await req.json();
  } catch {
    return reply({ error: "Invalid JSON body." }, 400);
  }
  const asset = String(body.asset || "").trim().toUpperCase();
  const network = normalizeNetwork(String(body.network || ""));
  const txHash = String(body.tx_hash || "").trim();
  if (!network || !txHash) return reply({ error: "network and tx_hash are required." }, 400);
  if (!/^[A-Za-z0-9]{20,150}$/.test(txHash)) {
    return reply({ verified: false, status: "invalid", confirmations: null, asset, network, tx_hash: txHash, explorer_url: explorerUrl(network, txHash), checked_at: new Date().toISOString(), note: "The hash does not look like a blockchain transaction id." });
  }
  let verdict: Verdict;
  try {
    switch (network) {
      case "BITCOIN": verdict = await checkBitcoin(txHash); break;
      case "DOGECOIN": verdict = await checkBlockchair("dogecoin", "Dogecoin", txHash); break;
      case "ETHEREUM":
      case "ERC20": verdict = await checkBlockchair("ethereum", "Ethereum", txHash); break;
      case "BEP20": verdict = await checkBsc(txHash); break;
      case "TRC20":
      case "TRON": verdict = await checkTron(txHash); break;
      case "SOLANA": verdict = await checkSolana(txHash); break;
      default:
        return reply({ verified: false, status: "unsupported", confirmations: null, asset, network, tx_hash: txHash, explorer_url: explorerUrl(network, txHash), checked_at: new Date().toISOString(), note: `Network ${network} is not supported for automatic verification.` });
    }
  } catch (e) {
    return reply({ verified: false, status: "error", confirmations: null, asset, network, tx_hash: txHash, explorer_url: explorerUrl(network, txHash), checked_at: new Date().toISOString(), note: `Verification service error: ${e instanceof Error ? e.message : "unknown"}.` });
  }
  return reply({ ...verdict, asset, network, tx_hash: txHash, explorer_url: explorerUrl(network, txHash), checked_at: new Date().toISOString() });
});

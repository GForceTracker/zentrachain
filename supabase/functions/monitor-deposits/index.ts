import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Automatic on-chain deposit monitor.
// Scans every active deposit address on public blockchain APIs, records incoming
// transfers in `blockchain_deposits` and credits confirmed transfers to the user's
// deposit balance (deposit_requests + ledger_entries). Safe to call repeatedly:
// transfers are deduped by (network_code, tx_hash, event_index).

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const USDT_CONTRACTS: Record<string, string> = {
  ERC20: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
  BEP20: "0x55d398326f99059fF775485246999027B3197955",
};
const SOL_USDT_MINT = "Es9vMFrzaCERmJfreucTsc4GZvv1nNwUEvfRfmKg6tF";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const REQUIRED_CONFIRMATIONS: Record<string, number> = {
  TRC20: 19, ERC20: 12, BEP20: 15, BITCOIN: 2, TRON: 19, DOGECOIN: 20, SOLANA: 1, ETHEREUM: 12,
};

const COINGECKO_IDS: Record<string, string> = {
  BTC: "bitcoin", ETH: "ethereum", SOL: "solana", TRX: "tron", DOGE: "dogecoin", USDT: "tether",
};

function response(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info, x-zc-cron-secret", "Access-Control-Allow-Methods": "POST, OPTIONS", "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

async function getJson(url: string, init?: RequestInit, timeoutMs = 12000): Promise<unknown> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
    return await res.json();
  } finally { clearTimeout(t); }
}

function hexToBigInt(hex: string) { return BigInt(hex.startsWith("0x") ? hex : "0x" + hex); }
function padAddressTopic(addr: string) { return "0x" + "0".repeat(24) + addr.replace(/^0x/, ""); }

type Candidate = {
  tx_hash: string; event_index: number; from_address: string | null; to_address: string;
  amount: number; confirmations: number | null; chain_timestamp: string | null; raw: unknown;
};

// ---------- TRON ----------
const BASE32_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58Encode(bytes: Uint8Array): string {
  let n = BigInt("0x" + Array.from(bytes, b => b.toString(16).padStart(2, "0")).join(""));
  let out = "";
  while (n > 0n) { out = BASE32_ALPHABET[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b === 0) out = "1" + out; else break; }
  return out;
}
async function sha256Hex(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer));
}
async function hexToBase58Check(hex: string): Promise<string> {
  const payload = Uint8Array.from(hex.match(/../g)!.map(x => parseInt(x, 16)));
  const h1 = await sha256Hex(payload); const h2 = await sha256Hex(h1);
  return base58Encode(new Uint8Array([...payload, ...h2.slice(0, 4)]));
}

async function scanTronToken(addr: string): Promise<Candidate[]> {
  const data = await getJson(`https://api.trongrid.io/v1/accounts/${addr}/transactions/trc20?only_to=true&limit=50`) as { data?: Array<{ transaction_id?: string; from?: string; to?: string; value?: string; token_info?: { address?: string; symbol?: string; decimals?: number }; block_timestamp?: number }> };
  const out: Candidate[] = [];
  for (const t of data.data || []) {
    const symbol = String(t.token_info?.symbol || "").toUpperCase();
    if (symbol !== "USDT") continue;
    const decimals = Number(t.token_info?.decimals ?? 6);
    const amount = Number(t.value || 0) / 10 ** decimals;
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const ts = Number(t.block_timestamp || 0);
    out.push({
      tx_hash: String(t.transaction_id || ""), event_index: 0, from_address: t.from || null, to_address: addr,
      amount, confirmations: ts > 0 ? Math.floor((Date.now() - ts) / 3000) : null,
      chain_timestamp: ts > 0 ? new Date(ts).toISOString() : null, raw: t,
    });
  }
  return out;
}

async function scanTronNative(addr: string): Promise<Candidate[]> {
  const data = await getJson(`https://api.trongrid.io/v1/accounts/${addr}/transactions?only_to=true&limit=50`) as { data?: Array<{ txID?: string; blockTimestamp?: number; raw_data?: { contract?: Array<{ type?: string; parameter?: { value?: { to_address?: string; owner_address?: string; amount?: number } } }> } }> };
  const out: Candidate[] = [];
  for (const tx of data.data || []) {
    for (let i = 0; i < (tx.raw_data?.contract || []).length; i++) {
      const c = tx.raw_data!.contract[i];
      if (c.type !== "TransferContract") continue;
      const toHex = String(c.parameter?.value?.to_address || "");
      if (!toHex) continue;
      const to = await hexToBase58Check(toHex);
      if (to !== addr) continue;
      const amount = Number(c.parameter?.value?.amount || 0) / 1e6;
      if (!Number.isFinite(amount) || amount <= 0) continue;
      const ts = Number(tx.blockTimestamp || 0);
      out.push({
        tx_hash: String(tx.txID || ""), event_index: i, from_address: c.parameter?.value?.owner_address ? await hexToBase58Check(String(c.parameter.value.owner_address)) : null,
        to_address: addr, amount, confirmations: ts > 0 ? Math.floor((Date.now() - ts) / 3000) : null,
        chain_timestamp: ts > 0 ? new Date(ts).toISOString() : null, raw: c,
      });
    }
  }
  return out;
}

// ---------- EVM (Blockscout: Ethereum native + tokens) ----------
async function scanBlockscout(network: string, addr: string, asset: string): Promise<Candidate[]> {
  const host = network === "ERC20" || network === "ETHEREUM" ? "https://eth.blockscout.com" : "";
  if (!host) return [];
  const out: Candidate[] = [];
  if (asset === "ETH") {
    const data = await getJson(`${host}/api?module=account&action=txlist&address=${addr}&limit=50&sort=desc`) as { result?: Array<{ hash?: string; from?: string; to?: string; value?: string; isError?: string; confirmations?: string; timeStamp?: string }> };
    for (const tx of data.result || []) {
      if (String(tx.to || "").toLowerCase() !== addr.toLowerCase()) continue;
      if (String(tx.isError || "0") === "1") continue;
      const amount = Number(tx.value || 0) / 1e18;
      if (!Number.isFinite(amount) || amount <= 0) continue;
      const ts = Number(tx.timeStamp || 0) * 1000;
      out.push({
        tx_hash: String(tx.hash || ""), event_index: 0, from_address: tx.from || null, to_address: addr,
        amount, confirmations: Number(tx.confirmations || 0) || null,
        chain_timestamp: ts > 0 ? new Date(ts).toISOString() : null, raw: tx,
      });
    }
  }
  if (asset === "USDT") {
    const data = await getJson(`${host}/api?module=account&action=tokentx&address=${addr}&limit=50&sort=desc`) as { result?: Array<{ hash?: string; from?: string; to?: string; value?: string; tokenSymbol?: string; tokenDecimal?: string; timeStamp?: string; confirmations?: string }> };
    for (let i = 0; i < (data.result || []).length; i++) {
      const t = data.result![i];
      if (String(t.to || "").toLowerCase() !== addr.toLowerCase()) continue;
      if (String(t.tokenSymbol || "").toUpperCase() !== "USDT") continue;
      const amount = Number(t.value || 0) / 10 ** Number(t.tokenDecimal || 6);
      if (!Number.isFinite(amount) || amount <= 0) continue;
      const ts = Number(t.timeStamp || 0) * 1000;
      out.push({
        tx_hash: String(t.hash || ""), event_index: i, from_address: t.from || null, to_address: addr,
        amount, confirmations: Number(t.confirmations || 0) || null,
        chain_timestamp: ts > 0 ? new Date(ts).toISOString() : null, raw: t,
      });
    }
  }
  return out;
}

// ---------- EVM (public RPC getLogs for BEP20 USDT) ----------
async function scanEvmLogs(rpc: string, usdtContract: string, addr: string): Promise<Candidate[]> {
  const head = await getJson(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }) }) as { result?: string };
  const latest = Number(hexToBigInt(String(head.result || "0x0")));
  if (!latest) return [];
  const fromBlock = Math.max(0, latest - 4800);
  const data = await getJson(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "eth_getLogs", params: [{ fromBlock: "0x" + fromBlock.toString(16), toBlock: "latest", address: usdtContract, topics: [TRANSFER_TOPIC, null, padAddressTopic(addr)] }] }) }) as { result?: Array<{ transactionHash: string; blockNumber: string; topics: string[]; data: string }> };
  const out: Candidate[] = [];
  for (const log of data.result || []) {
    const valueHex = log.data?.replace(/^0x/, "").slice(0, 64);
    if (!valueHex) continue;
    const amount = Number(BigInt("0x" + valueHex)) / 1e18;
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const block = Number(hexToBigInt(log.blockNumber));
    out.push({
      tx_hash: String(log.transactionHash || ""), event_index: 0, from_address: null, to_address: addr,
      amount, confirmations: Math.max(0, latest - block + 1), chain_timestamp: null, raw: log,
    });
  }
  return out;
}

// ---------- Bitcoin ----------
async function scanBitcoin(addr: string): Promise<Candidate[]> {
  let tip = 0;
  try {
    const res = await fetch("https://mempool.space/api/blocks/tip/height", { headers: { Accept: "text/plain" } });
    if (res.ok) tip = Number((await res.text()).trim());
  } catch { /* tip optional */ }
  const txs = await getJson(`https://mempool.space/api/address/${addr}/txs`) as Array<{ txid?: string; vout?: Array<{ scriptpubkey_address?: string; value?: number }>; vin?: Array<{ prevout?: { scriptpubkey_address?: string; value?: number } }>; status?: { confirmed?: boolean; block_height?: number }; blocktime?: number }>;
  const out: Candidate[] = [];
  for (const tx of txs.slice(0, 25)) {
    for (let i = 0; i < (tx.vout || []).length; i++) {
      const v = tx.vout![i];
      if (v.scriptpubkey_address !== addr) continue;
      const amount = Number(v.value || 0) / 1e8;
      if (!Number.isFinite(amount) || amount <= 0) continue;
      const spent = (tx.vin || []).some(vi => vi.prevout?.scriptpubkey_address === addr);
      const conf = tx.status?.confirmed && tx.status.block_height && tip > tx.status.block_height ? tip - tx.status.block_height + 1 : (tx.status?.confirmed ? 1 : 0);
      out.push({
        tx_hash: String(tx.txid || ""), event_index: i, from_address: spent ? addr : null, to_address: addr,
        amount, confirmations: conf || 0,
        chain_timestamp: tx.blocktime ? new Date(tx.blocktime * 1000).toISOString() : null, raw: { txid: tx.txid, vout: v },
      });
    }
  }
  return out;
}

// ---------- Dogecoin (Trezor blockbook) ----------
async function scanDogecoin(addr: string): Promise<Candidate[]> {
  const hosts = ["https://doge1.trezor.io/api/v2/address/", "https://doge2.trezor.io/api/v2/address/"];
  let data: { txids?: string[] } | null = null;
  for (const host of hosts) {
    try { data = await getJson(host + addr + "?details=txs&pageSize=15") as { txids?: string[] }; break; } catch { /* try next host */ }
  }
  if (!data || !Array.isArray(data.txids)) return [];
  const out: Candidate[] = [];
  for (const txid of data.txids.slice(0, 8)) {
    try {
      const tx = await getJson(`https://doge1.trezor.io/api/v2/tx/${txid}`) as { txid?: string; vout?: Array<{ n?: number; addresses?: string[]; value?: string }>; confirmations?: number; blockTime?: number };
      for (const v of tx.vout || []) {
        if (!(v.addresses || []).includes(addr)) continue;
        const amount = Number(v.value || 0) / 1e8;
        if (!Number.isFinite(amount) || amount <= 0) continue;
        out.push({
          tx_hash: String(tx.txid || txid), event_index: Number(v.n || 0), from_address: null, to_address: addr,
          amount, confirmations: Number(tx.confirmations || 0), chain_timestamp: tx.blockTime ? new Date(tx.blockTime * 1000).toISOString() : null, raw: v,
        });
      }
    } catch { /* skip tx */ }
  }
  return out;
}

// ---------- Solana ----------
async function scanSolana(addr: string, asset: string): Promise<Candidate[]> {
  const rpc = "https://api.mainnet-beta.solana.com";
  const call = (method: string, params: unknown[]) => getJson(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }) as Promise<{ result?: unknown; error?: unknown }>;
  const sigs = await call("getSignaturesForAddress", [addr, { limit: 12 }]) as { result?: Array<{ signature: string; confirmationStatus?: string; blockTime?: number }> };
  const out: Candidate[] = [];
  for (const s of (sigs.result || []).slice(0, 8)) {
    if (!s.signature) continue;
    if (s.confirmationStatus && s.confirmationStatus !== "finalized") continue;
    try {
      const tx = await call("getTransaction", [s.signature, { encoding: "json", commitment: "finalized", maxSupportedTransactionVersion: 0 }]) as { result?: { meta?: { preBalances?: number[]; postBalances?: number[]; preTokenBalances?: Array<{ owner?: string; mint?: string; uiTokenAmount?: { uiAmount?: number } }> | null; postTokenBalances?: Array<{ owner?: string; mint?: string; uiTokenAmount?: { uiAmount?: number } }> | null; status?: { Err?: unknown } }; transaction?: { message?: { accountKeys?: string[] } } } };
      const meta = tx.result?.meta, keys = tx.result?.transaction?.message?.accountKeys || [];
      if (!meta || meta.status?.Err) continue;
      if (asset === "SOL") {
        const idx = keys.indexOf(addr);
        if (idx >= 0) {
          const amount = ((meta.postBalances?.[idx] || 0) - (meta.preBalances?.[idx] || 0)) / 1e9;
          if (amount > 0) out.push({ tx_hash: s.signature, event_index: 0, from_address: null, to_address: addr, amount, confirmations: 32, chain_timestamp: s.blockTime ? new Date(s.blockTime * 1000).toISOString() : null, raw: { signature: s.signature, delta: amount } });
        }
      }
      if (asset === "USDT") {
        const pre = meta.preTokenBalances || [], post = meta.postTokenBalances || [];
        const pick = (arr: typeof post) => arr.filter(b => b.owner === addr && b.mint === SOL_USDT_MINT).reduce((s2, b) => s2 + Number(b.uiTokenAmount?.uiAmount || 0), 0);
        const amount = pick(post) - pick(pre);
        if (amount > 0) out.push({ tx_hash: s.signature, event_index: 1, from_address: null, to_address: addr, amount, confirmations: 32, chain_timestamp: s.blockTime ? new Date(s.blockTime * 1000).toISOString() : null, raw: { signature: s.signature, delta: amount } });
      }
    } catch { /* skip tx */ }
  }
  return out;
}

async function scanAddress(row: AddressRow): Promise<Candidate[]> {
  const asset = String(row.asset_code || "").toUpperCase(), network = String(row.network_code || "").toUpperCase(), addr = row.address;
  try {
    if (network === "TRC20" && asset === "USDT") return await scanTronToken(addr);
    if (network === "TRON" && asset === "TRX") return await scanTronNative(addr);
    if (network === "ERC20" || network === "ETHEREUM") return await scanBlockscout(network, addr, asset);
    if (network === "BEP20" && asset === "USDT") return await scanEvmLogs("https://bsc-dataseed.binance.org", USDT_CONTRACTS.BEP20, addr);
    if (network === "BITCOIN" && asset === "BTC") return await scanBitcoin(addr);
    if (network === "DOGECOIN" && asset === "DOGE") return await scanDogecoin(addr);
    if (network === "SOLANA") return await scanSolana(addr, asset);
    return [];
  } catch (e) {
    console.warn(`scan failed for ${network} ${addr}`, e);
    return [];
  }
}

type AddressRow = { id: string; user_id: string; asset_network_id: string; asset_code: string; network_code: string; address: string };

async function rest(path: string, init: RequestInit): Promise<Response> {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...init, headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json", ...(init.headers || {}) } });
}

async function loadPrices(): Promise<Record<string, number>> {
  const prices: Record<string, number> = { USDT: 1 };
  try {
    const ids = Object.values(COINGECKO_IDS).join(",");
    const data = await getJson(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`) as Record<string, { usd?: number }>;
    for (const [asset, id] of Object.entries(COINGECKO_IDS)) {
      const p = Number(data[id]?.usd);
      if (Number.isFinite(p) && p > 0) prices[asset] = p;
    }
  } catch (e) { console.warn("price feed unavailable, only stables will credit", e); }
  return prices;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info, x-zc-cron-secret", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Max-Age": "86400", "Vary": "Origin" } });
  if (req.method !== "POST") return response({ error: "Method not allowed" }, 405);
  try {
    if (!SUPABASE_URL || !SERVICE_KEY) return response({ error: "Deposit monitoring is not configured" }, 503);
    // Auth: any signed-in member may trigger a scan, or a cron secret for scheduled runs.
    const cronSecret = Deno.env.get("ZC_CRON_SECRET") ?? "";
    const providedSecret = req.headers.get("x-zc-cron-secret") ?? "";
    let requesterId: string | null = null;
    const authHeader = req.headers.get("Authorization") ?? "";
    if (cronSecret && providedSecret && providedSecret === cronSecret) {
      requesterId = null;
    } else if (authHeader.startsWith("Bearer ")) {
      const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SERVICE_KEY, Authorization: authHeader } });
      if (!userRes.ok) return response({ error: "Invalid session" }, 401);
      const user = await userRes.json();
      if (!user?.id) return response({ error: "Invalid session" }, 401);
      requesterId = user.id as string;
    } else {
      return response({ error: "Authentication required" }, 401);
    }

    const addrRes = await rest("user_deposit_addresses?address_status=eq.active&select=id,user_id,asset_network_id,asset_code,network_code,address", { method: "GET" });
    if (!addrRes.ok) throw new Error("Could not load deposit addresses");
    const addresses = await addrRes.json() as AddressRow[];

    const prices = await loadPrices();
    const requiredFor = (network: string) => REQUIRED_CONFIRMATIONS[String(network || "").toUpperCase()] ?? 12;

    // 1. Record newly detected transfers.
    const pendingRows: Array<Record<string, unknown>> = [];
    const concurrency = 4;
    for (let i = 0; i < addresses.length; i += concurrency) {
      const batch = addresses.slice(i, i + concurrency);
      const scanned = await Promise.all(batch.map(async row => ({ row, candidates: await scanAddress(row) })));
      for (const { row, candidates } of scanned) {
        for (const c of candidates) {
          if (!c.tx_hash || !Number.isFinite(c.amount) || c.amount <= 0) continue;
          const find = await rest(`blockchain_deposits?network_code=eq.${encodeURIComponent(row.network_code)}&tx_hash=eq.${encodeURIComponent(c.tx_hash)}&event_index=eq.${c.event_index}&select=id,deposit_status,user_id,asset_code,network_code,tx_hash,amount`, { method: "GET" });
          if (find.ok) {
            const existing = (await find.json()) as Array<{ id: string; deposit_status: string; user_id: string; asset_code: string; network_code: string; tx_hash: string; amount: string }>;
            if (existing.length) {
              // Already recorded. Promote confirming rows to confirmed once enough confirmations are reached.
              const ex = existing[0];
              if (ex.deposit_status === "confirming") {
                const conf2 = Number.isFinite(c.confirmations) ? Number(c.confirmations) : 0;
                if (conf2 >= requiredFor(ex.network_code)) {
                  const upd = await rest(`blockchain_deposits?id=eq.${ex.id}`, { method: "PATCH", body: JSON.stringify({ deposit_status: "confirmed", confirmations: conf2 }) });
                  if (upd.ok) pendingRows.push({ ...ex, deposit_status: "confirmed" });
                } else if (conf2 > 0) {
                  await rest(`blockchain_deposits?id=eq.${ex.id}`, { method: "PATCH", body: JSON.stringify({ confirmations: conf2 }) });
                }
              }
              continue;
            }
          }
          const required = requiredFor(row.network_code);
          const conf = Number.isFinite(c.confirmations) ? Number(c.confirmations) : 0;
          const status = conf >= required ? "confirmed" : "confirming";
          const insert = await rest("blockchain_deposits", {
            method: "POST",
            headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
            body: JSON.stringify({
              user_id: row.user_id, address_id: row.id, asset_network_id: row.asset_network_id,
              asset_code: row.asset_code, network_code: row.network_code, tx_hash: c.tx_hash, event_index: c.event_index,
              from_address: c.from_address, to_address: c.to_address, amount: c.amount,
              confirmations: conf, required_confirmations: required, deposit_status: status,
              chain_timestamp: c.chain_timestamp, raw_event: c.raw ?? {},
            }),
          });
          if (!insert.ok) { console.warn("insert failed", await insert.text()); continue; }
          const rows = await insert.json() as Array<{ id: string; user_id: string; asset_code: string; network_code: string; tx_hash: string; amount: string; deposit_status: string }>;
          if (rows.length && rows[0].deposit_status === "confirmed") pendingRows.push(rows[0]);
        }
      }
    }

    // 2. Backlog: rows confirmed earlier but not credited yet (e.g. price feed was down).
    const backlog = await rest("blockchain_deposits?deposit_status=eq.confirmed&select=id,user_id,asset_code,network_code,tx_hash,amount", { method: "GET" });
    if (backlog.ok) for (const row of (await backlog.json()) as Array<Record<string, unknown>>) {
      if (!pendingRows.some(p => p.id === row.id)) pendingRows.push(row);
    }

    // 3. Credit confirmed transfers through one database transaction.
    // The RPC deduplicates by blockchain_deposit_id, reuses a matching manual
    // deposit request where possible, and purchases only the plan linked to
    // the member's active plan-deposit intent when the credited USD is in range.
    const credited: Array<{ user_id: string; amount_usd: number; asset: string; network: string; tx_hash: string; auto_purchase_status?: string }> = [];
    for (const row of pendingRows) {
      const asset = String(row.asset_code || "").toUpperCase(), network = String(row.network_code || "");
      const price = prices[asset];
      if (!Number.isFinite(price) || price <= 0) continue; // stays in backlog until a price is available
      const usd = Math.round(Number(row.amount) * price * 1e6) / 1e6;
      if (!Number.isFinite(usd) || usd <= 0) continue;
      const processedRes = await rest("rpc/process_confirmed_monitored_deposit", {
        method: "POST",
        body: JSON.stringify({ p_blockchain_deposit_id: row.id, p_amount_usd: usd }),
      });
      if (!processedRes.ok) {
        console.warn("confirmed deposit processing failed", await processedRes.text());
        continue;
      }
      const processed = await processedRes.json() as {
        ok?: boolean;
        already_credited?: boolean;
        user_id?: string;
        amount_usd?: number;
        auto_purchase?: { status?: string };
      };
      if (processed?.ok !== true) {
        console.warn("confirmed deposit RPC returned an unexpected response", processed);
        continue;
      }
      credited.push({
        user_id: String(row.user_id),
        amount_usd: Number(processed.amount_usd ?? usd),
        asset,
        network,
        tx_hash: String(row.tx_hash ?? ""),
        auto_purchase_status: processed.auto_purchase?.status || (processed.already_credited ? "already_credited" : "not_requested"),
      });
    }

    const mine = requesterId ? credited.filter(c => c.user_id === requesterId) : credited;
    return response({ ok: true, scanned: addresses.length, credited: mine, creditedTotal: credited.length });
  } catch (e) {
    console.error("deposit monitor failed", e);
    return response({ error: "Deposit monitoring failed. Please try again later." }, 500);
  }
});

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Automatic on-chain deposit monitor.
// Scans every active deposit address on public blockchain APIs, records incoming
// transfers in `blockchain_deposits` and credits confirmed transfers to the user's
// deposit balance (deposit_requests + ledger_entries). Safe to call repeatedly:
// transfers are deduped by (network_code, tx_hash, event_index).

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TRONGRID_API_KEY = Deno.env.get("TRONGRID_API_KEY") ?? "";
const ETHEREUM_RPC_URL = Deno.env.get("ETHEREUM_RPC_URL") ?? "https://ethereum-rpc.publicnode.com";

const TRON_USDT_CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const USDT_CONTRACTS: Record<string, string> = {
  ERC20: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
  BEP20: "0x55d398326f99059fF775485246999027B3197955",
};
const SOL_USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
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

function constantTimeEqual(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  let diff = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i++) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}

async function getJson(url: string, init?: RequestInit, timeoutMs = 12000): Promise<unknown> {
  let lastError: unknown = new Error("Request failed");
  for (let attempt = 0; attempt < 4; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: ctrl.signal });
      if (res.ok) return await res.json();
      const message = `HTTP ${res.status} from ${new URL(url).host}`;
      if (res.status !== 429 && res.status < 500) throw new Error(message);
      lastError = new Error(message);
      if (attempt === 3) break;
      const retryAfter = Number(res.headers.get("retry-after") || 0) * 1000;
      await new Promise(resolve => setTimeout(resolve, Math.max(retryAfter, 250 * (2 ** attempt))));
    } catch (error) {
      lastError = error;
      const message = String((error as Error)?.message || error);
      if (message.startsWith("HTTP 4") && !message.startsWith("HTTP 429")) throw error;
      if (attempt === 3) break;
      await new Promise(resolve => setTimeout(resolve, 250 * (2 ** attempt)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Blockchain provider request failed");
}
function tronHeaders(): Record<string, string> {
  return { Accept: "application/json", ...(TRONGRID_API_KEY ? { "TRON-PRO-API-KEY": TRONGRID_API_KEY } : {}) };
}
let cachedEthHead = { value: 0, at: 0 };
async function getEthLatestBlock(): Promise<number> {
  if (cachedEthHead.value > 0 && Date.now() - cachedEthHead.at < 15000) return cachedEthHead.value;
  const data = (await getJson(ETHEREUM_RPC_URL, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
  })) as { result?: string; error?: unknown };
  if (data.error || !data.result) throw new Error("Ethereum latest block unavailable");
  const value = Number(hexToBigInt(data.result));
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Ethereum latest block was invalid");
  cachedEthHead = { value, at: Date.now() };
  return value;
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

let tronUsdtEventCache: { loadedAt: number; byAddress: Map<string, Candidate[]> } | null = null;
let tronUsdtEventLoad: Promise<Map<string, Candidate[]>> | null = null;

async function normalizeTronEventAddress(input: unknown): Promise<string> {
  const raw = String(input || "");
  if (!raw) return "";
  if (/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(raw)) return raw;
  const hex = raw.replace(/^0x/i, "");
  if (hex.length === 40) return await hexToBase58Check("41" + hex);
  if (hex.length === 42 && hex.slice(0, 2).toLowerCase() === "41") {
    return await hexToBase58Check(hex);
  }
  return "";
}

async function loadTronUsdtEvents(): Promise<Map<string, Candidate[]>> {
  const byAddress = new Map<string, Candidate[]>();
  const minTimestamp = Date.now() - 3 * 60 * 1000;
  let fingerprint = "";

  // Read the official USDT contract event feed once, then route transfers
  // only to addresses issued by this project. The 3-minute overlap makes
  // short scheduler/network interruptions recoverable; DB dedupe is authoritative.
  for (let page = 0; page < 4; page++) {
    const params = new URLSearchParams({
      event_name: "Transfer",
      only_confirmed: "true",
      min_timestamp: String(minTimestamp),
      limit: "200",
      order_by: "block_timestamp,desc",
    });
    if (fingerprint) params.set("fingerprint", fingerprint);

    const data = (await getJson(
      `https://api.trongrid.io/v1/contracts/${TRON_USDT_CONTRACT}/events?${params.toString()}`,
      { headers: tronHeaders() },
    )) as {
      data?: Array<{
        contract_address?: string;
        event_name?: string;
        event_index?: number;
        transaction_id?: string;
        block_timestamp?: number;
        _unconfirmed?: boolean;
        success?: boolean;
        result?: Record<string, string>;
      }>;
      meta?: { fingerprint?: string };
    };

    for (const event of data.data || []) {
      if (String(event.contract_address || "").toLowerCase() !== TRON_USDT_CONTRACT.toLowerCase()) continue;
      if (event.event_name !== "Transfer" || event._unconfirmed === true || event.success === false) continue;

      const result = event.result || {};
      const toAddress = await normalizeTronEventAddress(result.to);
      if (!toAddress) continue;
      const fromAddress = await normalizeTronEventAddress(result.from);
      let amount = 0;
      try {
        amount = Number(BigInt(String(result.value || "0"))) / 1e6;
      } catch {
        continue;
      }
      if (!Number.isFinite(amount) || amount <= 0) continue;

      const timestamp = Number(event.block_timestamp || 0);
      const candidate: Candidate = {
        tx_hash: String(event.transaction_id || ""),
        event_index: Number(event.event_index ?? 0),
        from_address: fromAddress || null,
        to_address: toAddress,
        amount,
        confirmations: REQUIRED_CONFIRMATIONS.TRC20,
        chain_timestamp: timestamp > 0 ? new Date(timestamp).toISOString() : null,
        raw: event,
      };
      if (!candidate.tx_hash) continue;
      const list = byAddress.get(toAddress) || [];
      list.push(candidate);
      byAddress.set(toAddress, list);
    }

    const nextFingerprint = String(data.meta?.fingerprint || "");
    if (!nextFingerprint || nextFingerprint === fingerprint) break;
    fingerprint = nextFingerprint;
  }

  return byAddress;
}

async function getTronUsdtEvents(): Promise<Map<string, Candidate[]>> {
  if (tronUsdtEventCache && Date.now() - tronUsdtEventCache.loadedAt < 20000) {
    return tronUsdtEventCache.byAddress;
  }
  if (tronUsdtEventLoad) return await tronUsdtEventLoad;

  tronUsdtEventLoad = loadTronUsdtEvents();
  try {
    const byAddress = await tronUsdtEventLoad;
    tronUsdtEventCache = { loadedAt: Date.now(), byAddress };
    return byAddress;
  } finally {
    tronUsdtEventLoad = null;
  }
}

async function scanTronToken(addr: string): Promise<Candidate[]> {
  const events = await getTronUsdtEvents();
  return events.get(addr) || [];
}

async function scanTronNative(addr: string): Promise<Candidate[]> {
  const data = (await getJson(
    `https://api.trongrid.io/v1/accounts/${encodeURIComponent(addr)}/transactions?only_to=true&only_confirmed=true&limit=20`,
    { headers: tronHeaders() },
  )) as { data?: Array<{
    txID?: string; block_timestamp?: number; blockTimestamp?: number;
    raw_data?: { contract?: Array<{ type?: string; parameter?: { value?: { to_address?: string; owner_address?: string; amount?: number } } }> };
  }> };
  const out: Candidate[] = [];
  for (const tx of data.data || []) {
    for (let i = 0; i < (tx.raw_data?.contract || []).length; i++) {
      const contract = tx.raw_data!.contract[i];
      if (contract.type !== "TransferContract") continue;
      const value = contract.parameter?.value;
      const toHex = String(value?.to_address || "");
      if (!toHex) continue;
      const to = await hexToBase58Check(toHex);
      if (to !== addr) continue;
      const amount = Number(value?.amount || 0) / 1e6;
      if (!Number.isFinite(amount) || amount <= 0) continue;
      const ts = Number(tx.block_timestamp || tx.blockTimestamp || 0);
      out.push({
        tx_hash: String(tx.txID || ""), event_index: i,
        from_address: value?.owner_address ? await hexToBase58Check(String(value.owner_address)) : null,
        to_address: addr, amount, confirmations: REQUIRED_CONFIRMATIONS.TRON,
        chain_timestamp: ts > 0 ? new Date(ts).toISOString() : null, raw: contract,
      });
    }
  }
  return out;
}

// ---------- EVM (Blockscout API v2: Ethereum native + official USDT token) ----------
async function scanBlockscout(network: string, addr: string, asset: string): Promise<Candidate[]> {
  if (network !== "ERC20" && network !== "ETHEREUM") return [];
  const base = "https://eth.blockscout.com/api/v2";
  const out: Candidate[] = [];
  const latest = await getEthLatestBlock();
  if (asset === "ETH") {
    const data = (await getJson(`${base}/addresses/${encodeURIComponent(addr)}/transactions?filter=to`)) as { items?: Array<{
      hash?: string; from?: { hash?: string } | string; to?: { hash?: string } | string;
      value?: string; block_number?: number; timestamp?: string; result?: string; status?: string;
      confirmations?: number;
    }> };
    for (const tx of data.items || []) {
      const toAddress = typeof tx.to === "string" ? tx.to : tx.to?.hash;
      if (String(toAddress || "").toLowerCase() !== addr.toLowerCase()) continue;
      const status = String(tx.result || tx.status || "").toLowerCase();
      if (status.includes("fail") || status.includes("error") || status.includes("revert")) continue;
      const amount = Number(BigInt(tx.value || "0")) / 1e18;
      if (!Number.isFinite(amount) || amount <= 0) continue;
      const blockNumber = Number(tx.block_number || 0);
      const confirmations = blockNumber > 0 ? Math.max(0, latest - blockNumber + 1) : Number(tx.confirmations || 0);
      const fromAddress = typeof tx.from === "string" ? tx.from : tx.from?.hash;
      const ts = tx.timestamp ? new Date(tx.timestamp).getTime() : 0;
      out.push({
        tx_hash: String(tx.hash || ""), event_index: 0, from_address: fromAddress || null,
        to_address: addr, amount, confirmations,
        chain_timestamp: ts > 0 ? new Date(ts).toISOString() : null, raw: tx,
      });
    }
  }
  if (asset === "USDT") {
    const contract = USDT_CONTRACTS.ERC20;
    const data = (await getJson(
      `${base}/addresses/${encodeURIComponent(addr)}/token-transfers?type=ERC-20&filter=to&token=${contract}`
    )) as { items?: Array<{
      transaction_hash?: string; log_index?: number; block_number?: number; timestamp?: string;
      from?: { hash?: string } | string; to?: { hash?: string } | string;
      token?: { address_hash?: string; decimals?: string | number };
      total?: { value?: string; decimals?: string | number };
    }> };
    for (const transfer of data.items || []) {
      const tokenAddress = String(transfer.token?.address_hash || "").toLowerCase();
      const toAddress = typeof transfer.to === "string" ? transfer.to : transfer.to?.hash;
      if (tokenAddress !== contract.toLowerCase()) continue;
      if (String(toAddress || "").toLowerCase() !== addr.toLowerCase()) continue;
      const decimals = Number(transfer.total?.decimals ?? transfer.token?.decimals ?? 6);
      if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) continue;
      const amount = Number(BigInt(transfer.total?.value || "0")) / 10 ** decimals;
      if (!Number.isFinite(amount) || amount <= 0) continue;
      const blockNumber = Number(transfer.block_number || 0);
      const confirmations = blockNumber > 0 ? Math.max(0, latest - blockNumber + 1) : 0;
      const fromAddress = typeof transfer.from === "string" ? transfer.from : transfer.from?.hash;
      const ts = transfer.timestamp ? new Date(transfer.timestamp).getTime() : 0;
      out.push({
        tx_hash: String(transfer.transaction_hash || ""),
        event_index: Number(transfer.log_index ?? 0), from_address: fromAddress || null,
        to_address: addr, amount, confirmations,
        chain_timestamp: ts > 0 ? new Date(ts).toISOString() : null, raw: transfer,
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
  const data = await getJson(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "eth_getLogs", params: [{ fromBlock: "0x" + fromBlock.toString(16), toBlock: "latest", address: usdtContract, topics: [TRANSFER_TOPIC, null, padAddressTopic(addr)] }] }) }) as { result?: Array<{ transactionHash: string; blockNumber: string; logIndex?: string; topics: string[]; data: string }> };
  const out: Candidate[] = [];
  for (const log of data.result || []) {
    const valueHex = log.data?.replace(/^0x/, "").slice(0, 64);
    if (!valueHex) continue;
    const amount = Number(BigInt("0x" + valueHex)) / 1e18;
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const block = Number(hexToBigInt(log.blockNumber));
    out.push({
      tx_hash: String(log.transactionHash || ""),
      event_index: log.logIndex ? Number(hexToBigInt(log.logIndex)) : 0,
      from_address: log.topics?.[1] ? "0x" + log.topics[1].slice(-40) : null,
      to_address: addr,
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
    const providedSecret = req.headers.get("x-zc-cron-secret") ?? "";
    let cronAuthorized = false;
    if (providedSecret) {
      const secretCheck = await rest("rpc/verify_zc_monitor_cron_secret", {
        method: "POST", body: JSON.stringify({ p_secret: providedSecret }),
      });
      if (!secretCheck.ok) return response({ error: "Scheduled monitor authorization failed" }, 401);
      cronAuthorized = (await secretCheck.json()) === true;
      if (!cronAuthorized) return response({ error: "Scheduled monitor authorization failed" }, 401);
    }
    let requesterId: string | null = null;
    if (!cronAuthorized) {
      const authHeader = req.headers.get("Authorization") ?? "";
      if (!authHeader.startsWith("Bearer ")) return response({ error: "Administrator authentication or scheduled-job authorization is required" }, 401);
      const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
        headers: { apikey: SERVICE_KEY, Authorization: authHeader },
      });
      if (!userRes.ok) return response({ error: "Invalid session" }, 401);
      const user = await userRes.json();
      if (!user?.id) return response({ error: "Invalid session" }, 401);
      const profileRes = await fetch(
        `${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(String(user.id))}&select=role&limit=1`,
        { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } },
      );
      if (!profileRes.ok) return response({ error: "Could not verify administrator access" }, 503);
      const profileRows = await profileRes.json();
      if (!Array.isArray(profileRows) || profileRows[0]?.role !== "admin") return response({ error: "Administrator access required" }, 403);
      requesterId = String(user.id);
    }

    const addrRes = await rest("rpc/next_zc_deposit_monitor_batch", {
      method: "POST", body: JSON.stringify({ p_limit: 6 }),
    });
    if (!addrRes.ok) throw new Error("Could not load the next deposit-monitor batch");
    const addresses = await addrRes.json() as AddressRow[];

    const prices = await loadPrices();
    const minimumRes = await rest("site_settings?setting_key=eq.minimum_deposit_usd&select=numeric_value&limit=1", { method: "GET" });
    const minimumRows = minimumRes.ok ? await minimumRes.json() as Array<{ numeric_value?: number | string }> : [];
    const minimumUsd = Number(minimumRows[0]?.numeric_value ?? 10);
    const requiredFor = (network: string) => REQUIRED_CONFIRMATIONS[String(network || "").toUpperCase()] ?? 12;

    // 1. Record newly detected transfers.
    const pendingRows: Array<Record<string, unknown>> = [];
    const concurrency = 3;
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
      if (!Number.isFinite(usd) || usd < minimumUsd || usd > 10000000) continue;
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
    return response({ ok: true, scanned: addresses.length, credited: mine, creditedTotal: credited.length, minimum_usd: minimumUsd });
  } catch (e) {
    console.error("deposit monitor failed", e);
    return response({ error: "Deposit monitoring failed. Please try again later." }, 500);
  }
});

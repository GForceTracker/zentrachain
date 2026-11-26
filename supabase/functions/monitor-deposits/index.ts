import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Automatic on-chain deposit monitor.
// Scans every active deposit address on public blockchain APIs, records incoming
// transfers in `blockchain_deposits` and credits confirmed transfers to the user's
// deposit balance (deposit_requests + ledger_entries). Safe to call repeatedly:
// transfers are deduped by (network_code, tx_hash, event_index).

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TRON_RPC_URL = Deno.env.get("TRON_RPC_URL") ?? "https://tron-evm-rpc.publicnode.com";
const TRON_SOLIDITY_HTTP_URL = Deno.env.get("TRON_SOLIDITY_HTTP_URL") ?? "https://tron-solidity-rpc.publicnode.com";
const ETHEREUM_RPC_URL = Deno.env.get("ETHEREUM_RPC_URL") ?? "https://ethereum-rpc.publicnode.com";

const TRON_EVM_RPC_URLS = [...new Set([TRON_RPC_URL, "https://tron-evm-rpc.publicnode.com", "https://tron-evm.publicnode.com", "https://api.trongrid.io/jsonrpc"])];
const ETHEREUM_RPC_URLS = [...new Set([ETHEREUM_RPC_URL, "https://eth.llamarpc.com", "https://1rpc.io/eth"])];
const BSC_RPC_URLS = ["https://bsc-rpc.publicnode.com", "https://bsc-dataseed.binance.org", "https://1rpc.io/bnb"];
const SOLANA_RPC_URLS = ["https://solana-rpc.publicnode.com", "https://api.mainnet-beta.solana.com"];
const BITCOIN_API_BASES = ["https://mempool.space/api", "https://blockstream.info/api"];

const TRON_USDT_CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const TRON_USDT_CONTRACT_EVM = "0xa614f803b6fd780986a42c78ec9c7f77e6ded13c";
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

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
function retryAfterMs(value: string | null): number {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
}
async function getJson(url: string, init?: RequestInit, timeoutMs = 10000): Promise<unknown> {
  let lastError: unknown = new Error("Request failed");
  for (let attempt = 0; attempt < 3; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: ctrl.signal });
      if (res.ok) return await res.json();
      const message = `HTTP ${res.status} from ${new URL(url).host}`;
      const retryable = res.status === 408 || res.status === 425 || res.status === 429 || res.status >= 500;
      if (!retryable) throw new Error(message);
      lastError = new Error(message);
      if (attempt === 2) break;
      const backoff = 350 * (2 ** attempt) + Math.floor(Math.random() * 250);
      await wait(Math.min(Math.max(retryAfterMs(res.headers.get("retry-after")), backoff), 5000));
    } catch (error) {
      lastError = error;
      const message = String((error as Error)?.message || error);
      if (message.startsWith("HTTP ") && !/^HTTP (408|425|429|5\d\d) /.test(message)) throw error;
      if (attempt === 2) break;
      await wait(350 * (2 ** attempt) + Math.floor(Math.random() * 250));
    } finally { clearTimeout(timer); }
  }
  throw lastError instanceof Error ? lastError : new Error("Blockchain provider request failed");
}
async function getJsonWithFallback(urls: string[], init?: RequestInit, timeoutMs = 10000): Promise<unknown> {
  let lastError: unknown = new Error("No blockchain provider configured");
  for (const url of [...new Set(urls.filter(Boolean))]) {
    try { return await getJson(url, init, timeoutMs); }
    catch (error) {
      lastError = error;
      console.warn("Blockchain provider failed; trying a backup", new URL(url).host, String((error as Error)?.message || error));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("All public blockchain providers failed");
}
async function getTextWithFallback(urls: string[], timeoutMs = 10000): Promise<string> {
  let lastError: unknown = new Error("No text provider configured");
  for (const url of [...new Set(urls.filter(Boolean))]) {
    for (let attempt=0; attempt<2; attempt++) {
      const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(url, {headers:{Accept:"text/plain"},signal:ctrl.signal});
        if (res.ok) return (await res.text()).trim();
        const message = `HTTP ${res.status} from ${new URL(url).host}`;
        if (res.status!==408 && res.status!==425 && res.status!==429 && res.status<500) throw new Error(message);
        lastError = new Error(message);
        if (attempt===0) await wait(Math.min(Math.max(retryAfterMs(res.headers.get("retry-after")),500),3000));
      } catch(error) {
        lastError=error;
        const message=String((error as Error)?.message||error);
        if(message.startsWith("HTTP ")&&!/^HTTP (408|425|429|5\d\d) /.test(message)) throw error;
        if(attempt===0) await wait(400);
      } finally { clearTimeout(timer); }
    }
    console.warn("Text provider failed; trying backup",new URL(url).host,String((lastError as Error)?.message||lastError));
  }
  throw lastError instanceof Error ? lastError : new Error("All text providers failed");
}
async function rpcJsonWithFallback(urls: string[], method: string, params: unknown[]): Promise<{result?:unknown;error?:unknown}> {
  let lastError: unknown = new Error("No RPC provider configured");
  const body=JSON.stringify({jsonrpc:"2.0",id:1,method,params});
  for(const url of [...new Set(urls.filter(Boolean))]) {
    try {
      const data=await getJson(url,{method:"POST",headers:{"Content-Type":"application/json"},body}) as {result?:unknown;error?:unknown};
      if(data?.error) throw new Error(`RPC ${method} failed at ${new URL(url).host}: ${JSON.stringify(data.error)}`);
      return data;
    } catch(error) {
      lastError=error;
      console.warn("RPC provider failed; trying backup",new URL(url).host,String((error as Error)?.message||error));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`All RPC providers failed for ${method}`);
}
let cachedEthHead = { value: 0, at: 0 };
async function getEthLatestBlock(): Promise<number> {
  if (cachedEthHead.value > 0 && Date.now() - cachedEthHead.at < 15000) return cachedEthHead.value;
  const data=await rpcJsonWithFallback(ETHEREUM_RPC_URLS,"eth_blockNumber",[]);
  if(typeof data.result!=="string") throw new Error("Ethereum latest block unavailable");
  const value=Number(hexToBigInt(data.result));
  if(!Number.isSafeInteger(value)||value<=0) throw new Error("Ethereum latest block was invalid");
  cachedEthHead={value,at:Date.now()};
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

async function base58Decode(value: string): Promise<Uint8Array> {
  let number = 0n;
  for (const char of value) {
    const digit = BASE32_ALPHABET.indexOf(char);
    if (digit < 0) throw new Error("Invalid Base58 address");
    number = number * 58n + BigInt(digit);
  }
  let hex = number.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  const body = hex ? (hex.match(/../g) || []).map(v => parseInt(v, 16)) : [];
  let leadingZeroes = 0;
  while (leadingZeroes < value.length && value[leadingZeroes] === "1") leadingZeroes++;
  return new Uint8Array([...new Array(leadingZeroes).fill(0), ...body]);
}

async function tronAddressToEvmAddress(address: string): Promise<string> {
  const decoded = await base58Decode(address);
  if (decoded.length !== 25) throw new Error("Invalid TRON Base58Check address length");
  const payload = decoded.slice(0, 21);
  if (payload[0] !== 0x41) throw new Error("Invalid TRON mainnet address prefix");
  const first = await sha256Hex(payload);
  const second = await sha256Hex(first);
  const checksum = decoded.slice(21);
  for (let i = 0; i < 4; i++) {
    if (checksum[i] !== second[i]) throw new Error("Invalid TRON Base58Check checksum");
  }
  return "0x" + Array.from(payload.slice(1), b => b.toString(16).padStart(2, "0")).join("");
}

let cachedTronHead = { value: 0, at: 0 };
async function getTronLatestBlock(): Promise<number> {
  if (cachedTronHead.value > 0 && Date.now()-cachedTronHead.at<15000) return cachedTronHead.value;
  const data=await rpcJsonWithFallback(TRON_EVM_RPC_URLS,"eth_blockNumber",[]);
  if(typeof data.result!=="string") throw new Error("TRON latest block unavailable");
  const value=Number(hexToBigInt(data.result));
  if(!Number.isSafeInteger(value)||value<=0) throw new Error("TRON latest block was invalid");
  cachedTronHead={value,at:Date.now()};
  return value;
}

async function scanTronToken(addr: string): Promise<Candidate[]> {
  const recipient = await tronAddressToEvmAddress(addr);
  const latest = await getTronLatestBlock();
  const fromBlock = Math.max(0, latest - 4800);
  const recipientTopic = padAddressTopic(recipient);
  const data = await rpcJsonWithFallback(TRON_EVM_RPC_URLS,"eth_getLogs",[{
    fromBlock:"0x"+fromBlock.toString(16),toBlock:"latest",
    address:TRON_USDT_CONTRACT_EVM,topics:[TRANSFER_TOPIC,null,recipientTopic],
  }]) as {result?:Array<{
    transactionHash?:string;blockNumber?:string;logIndex?:string;topics?:string[];data?:string;removed?:boolean;
  } >};

  const out: Candidate[] = [];
  for (const log of data.result || []) {
    if (log.removed === true) continue;
    if (String(log.topics?.[2] || "").toLowerCase() !== recipientTopic.toLowerCase()) continue;
    const valueHex = String(log.data || "").replace(/^0x/, "");
    if (!/^[0-9a-fA-F]{1,64}$/.test(valueHex)) continue;
    const amount = Number(BigInt("0x" + valueHex)) / 1e6;
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const blockNumber = Number(hexToBigInt(String(log.blockNumber || "0x0")));
    const confirmations = Math.max(0, latest - blockNumber + 1);
    if (confirmations < REQUIRED_CONFIRMATIONS.TRC20) continue;
    const fromHex = String(log.topics?.[1] || "").replace(/^0x/, "").slice(-40);
    let fromAddress: string | null = null;
    if (/^[0-9a-fA-F]{40}$/.test(fromHex)) {
      try { fromAddress = await hexToBase58Check("41" + fromHex); } catch { fromAddress = null; }
    }
    out.push({
      tx_hash: String(log.transactionHash || ""),
      event_index: Number(hexToBigInt(String(log.logIndex || "0x0"))),
      from_address: fromAddress,
      to_address: addr,
      amount,
      confirmations,
      chain_timestamp: null,
      raw: log,
    });
  }
  return out;
}

type TronNativeTx = {
  txID?: string;
  raw_data?: {
    timestamp?: number;
    contract?: Array<{
      type?: string;
      parameter?: { value?: { to_address?: string; owner_address?: string; amount?: number } };
    }>;
  };
  ret?: Array<{ ret?: string; contractRet?: string }>;
};
type TronNativeBlock = {
  block_header?: { raw_data?: { number?: number; timestamp?: number } };
  transactions?: TronNativeTx[];
};
type TronNativeBlockBatch = { blocks: TronNativeBlock[]; provider: string };

let cachedTronNativeBlockBatch: {
  promise: Promise<TronNativeBlockBatch>;
  fetchedAt: number;
} | null = null;

async function getRecentTronNativeBlocks(): Promise<TronNativeBlockBatch> {
  // Function isolates may be reused between cron invocations. Refresh the
  // shared batch at least every 15 seconds so we never keep scanning stale blocks.
  if (!cachedTronNativeBlockBatch || Date.now() - cachedTronNativeBlockBatch.fetchedAt > 15000) {
    const promise = (async () => {
      const endpoints = [
        { name: "PublicNode Solidity HTTP", base: TRON_SOLIDITY_HTTP_URL, path: "/walletsolidity/getblockbylatestnum" },
        // No-key backup node endpoint. This is a block query, not an indexed per-address history request.
        { name: "TronGrid public Solidity HTTP fallback", base: "https://api.trongrid.io", path: "/walletsolidity/getblockbylatestnum" },
      ];
      let lastError: unknown = new Error("No public TRON block provider responded");
      for (const endpoint of endpoints) {
        try {
          const data = await getJson(endpoint.base + endpoint.path, {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify({ num: 99, visible: true }),
          }) as { block?: TronNativeBlock[]; Error?: string };
          if (data.Error) throw new Error(String(data.Error));
          if (!Array.isArray(data.block) || data.block.length === 0) {
            throw new Error("TRON public node returned no solidified blocks");
          }
          const validBlocks = data.block.filter(block =>
            Number.isSafeInteger(Number(block.block_header?.raw_data?.number))
          );
          if (validBlocks.length === 0) throw new Error("TRON public node returned invalid block data");
          console.info("TRX native scanner loaded solidified blocks", {
            provider: endpoint.name,
            blocks: validBlocks.length,
            latest_block: Math.max(...validBlocks.map(block => Number(block.block_header?.raw_data?.number))),
          });
          return { blocks: validBlocks, provider: endpoint.name };
        } catch (error) {
          lastError = error;
          console.warn("TRX native block provider unavailable", endpoint.name, String((error as Error)?.message || error));
        }
      }
      throw lastError instanceof Error ? lastError : new Error("No public TRON block provider responded");
    })();
    cachedTronNativeBlockBatch = { promise, fetchedAt: Date.now() };
  }
  const activeBatch = cachedTronNativeBlockBatch;
  try {
    return await activeBatch.promise;
  } catch (error) {
    if (cachedTronNativeBlockBatch === activeBatch) cachedTronNativeBlockBatch = null;
    throw error;
  }
}

async function scanTronNative(addr: string): Promise<Candidate[]> {
  // Read solidified TRON blocks once per monitor run, then match them against
  // each active deposit address. No TronGrid API key or account-history API is used.
  const batch = await getRecentTronNativeBlocks();
  const out: Candidate[] = [];
  for (const block of batch.blocks) {
    const blockNumber = Number(block.block_header?.raw_data?.number || 0);
    const blockTimestamp = Number(block.block_header?.raw_data?.timestamp || 0);
    for (const tx of block.transactions || []) {
      const results = tx.ret || [];
      const failed = results.some(result => {
        const code = String(result.ret || "").toUpperCase();
        const contractResult = String(result.contractRet || "").toUpperCase();
        return code === "FAILED" || (contractResult !== "" && !["SUCCESS", "DEFAULT"].includes(contractResult));
      });
      if (failed) continue;

      for (let i = 0; i < (tx.raw_data?.contract || []).length; i++) {
        const contract = tx.raw_data!.contract[i];
        if (contract.type !== "TransferContract") continue;
        const value = contract.parameter?.value;
        const rawTo = String(value?.to_address || "");
        if (!rawTo) continue;

        let toAddress = "";
        try {
          toAddress = rawTo.startsWith("T")
            ? rawTo
            : await hexToBase58Check(rawTo.replace(/^0x/i, ""));
        } catch {
          continue;
        }
        if (toAddress !== addr) continue;

        const amount = Number(value?.amount || 0) / 1e6;
        if (!Number.isFinite(amount) || amount <= 0) continue;
        const rawFrom = String(value?.owner_address || "");
        let fromAddress: string | null = null;
        if (rawFrom) {
          try {
            fromAddress = rawFrom.startsWith("T")
              ? rawFrom
              : await hexToBase58Check(rawFrom.replace(/^0x/i, ""));
          } catch {
            fromAddress = null;
          }
        }
        const timestamp = blockTimestamp || Number(tx.raw_data?.timestamp || 0);
        out.push({
          tx_hash: String(tx.txID || ""),
          event_index: i,
          from_address: fromAddress,
          to_address: addr,
          amount,
          // The Solidity HTTP endpoint serves already-solidified blocks.
          confirmations: REQUIRED_CONFIRMATIONS.TRON,
          chain_timestamp: timestamp > 0 ? new Date(timestamp).toISOString() : null,
          raw: { block_number: blockNumber, provider: batch.provider, contract },
        });
      }
    }
  }
  return out;
}

// ---------- EVM (Blockscout API v2: Ethereum native + official USDT token) ----------
let routescanQueue:Promise<void>=Promise.resolve();
function queuedRoutescan<T>(task:()=>Promise<T>):Promise<T>{
  const run=routescanQueue.then(async()=>{await wait(550);return await task();});
  routescanQueue=run.then(()=>undefined,()=>undefined);
  return run;
}
async function scanRoutescanEthereum(addr:string,asset:string,latest:number):Promise<Candidate[]>{
  const params=new URLSearchParams({module:"account",action:asset==="ETH"?"txlist":"tokentx",address:addr,page:"1",offset:"25",sort:"desc"});
  if(asset==="USDT")params.set("contractaddress",USDT_CONTRACTS.ERC20);
  const url=`https://api.routescan.io/v2/network/mainnet/evm/1/etherscan/api?${params.toString()}`;
  const data=await queuedRoutescan(()=>getJson(url)) as {
    status?:string;message?:string;
    result?:Array<{hash?:string;blockNumber?:string;timeStamp?:string;from?:string;to?:string;value?:string;
      isError?:string;txreceipt_status?:string;logIndex?:string;tokenDecimal?:string;contractAddress?:string}>|string;
  };
  if(!Array.isArray(data.result)){
    const message=String(data.message||data.result||"Routescan returned no transactions");
    if(message.toLowerCase().includes("no transactions"))return [];
    throw new Error(`Routescan Ethereum history unavailable: ${message}`);
  }
  const out:Candidate[]=[];
  for(const tx of data.result){
    if(String(tx.isError||"0")==="1"||String(tx.txreceipt_status||"1")==="0")continue;
    if(String(tx.to||"").toLowerCase()!==addr.toLowerCase())continue;
    if(asset==="USDT"&&String(tx.contractAddress||"").toLowerCase()!==USDT_CONTRACTS.ERC20.toLowerCase())continue;
    const block=Number(tx.blockNumber||0),decimals=asset==="ETH"?18:Number(tx.tokenDecimal||6);
    if(!Number.isInteger(decimals)||decimals<0||decimals>18)continue;
    const amount=Number(BigInt(tx.value||"0"))/10**decimals;
    if(!Number.isFinite(amount)||amount<=0)continue;
    const ts=Number(tx.timeStamp||0);
    out.push({tx_hash:String(tx.hash||""),event_index:asset==="ETH"?0:Number(tx.logIndex||0),
      from_address:tx.from||null,to_address:addr,amount,
      confirmations:block>0?Math.max(0,latest-block+1):0,
      chain_timestamp:ts>0?new Date(ts*1000).toISOString():null,raw:tx});
  }
  return out;
}
async function scanBlockscout(network:string,addr:string,asset:string):Promise<Candidate[]>{
  if(network!=="ERC20"&&network!=="ETHEREUM")return [];
  const base="https://eth.blockscout.com/api/v2";
  const latest=await getEthLatestBlock();
  try{
    const out:Candidate[]=[];
    if(asset==="ETH"){
      const data=await getJson(`${base}/addresses/${encodeURIComponent(addr)}/transactions?filter=to`) as {
        items?:Array<{hash?:string;from?:{hash?:string}|string;to?:{hash?:string}|string;value?:string;
          block_number?:number;timestamp?:string;result?:string;status?:string;confirmations?:number}>;
      };
      for(const tx of data.items||[]){
        const to=typeof tx.to==="string"?tx.to:tx.to?.hash;
        if(String(to||"").toLowerCase()!==addr.toLowerCase())continue;
        const status=String(tx.result||tx.status||"").toLowerCase();
        if(status.includes("fail")||status.includes("error")||status.includes("revert"))continue;
        const amount=Number(BigInt(tx.value||"0"))/1e18;
        if(!Number.isFinite(amount)||amount<=0)continue;
        const block=Number(tx.block_number||0),from=typeof tx.from==="string"?tx.from:tx.from?.hash;
        const ts=tx.timestamp?new Date(tx.timestamp).getTime():0;
        out.push({tx_hash:String(tx.hash||""),event_index:0,from_address:from||null,to_address:addr,amount,
          confirmations:block>0?Math.max(0,latest-block+1):Number(tx.confirmations||0),
          chain_timestamp:ts>0?new Date(ts).toISOString():null,raw:tx});
      }
      return out;
    }
    if(asset==="USDT"){
      const contract=USDT_CONTRACTS.ERC20;
      const data=await getJson(`${base}/addresses/${encodeURIComponent(addr)}/token-transfers?type=ERC-20&filter=to&token=${contract}`) as {
        items?:Array<{transaction_hash?:string;log_index?:number;block_number?:number;timestamp?:string;
          from?:{hash?:string}|string;to?:{hash?:string}|string;token?:{address_hash?:string;decimals?:string|number};
          total?:{value?:string;decimals?:string|number}}>;
      };
      for(const t of data.items||[]){
        const contractAddress=String(t.token?.address_hash||"").toLowerCase(),to=typeof t.to==="string"?t.to:t.to?.hash;
        if(contractAddress!==contract.toLowerCase()||String(to||"").toLowerCase()!==addr.toLowerCase())continue;
        const decimals=Number(t.total?.decimals??t.token?.decimals??6);
        if(!Number.isInteger(decimals)||decimals<0||decimals>18)continue;
        const amount=Number(BigInt(t.total?.value||"0"))/10**decimals;
        if(!Number.isFinite(amount)||amount<=0)continue;
        const block=Number(t.block_number||0),from=typeof t.from==="string"?t.from:t.from?.hash;
        const ts=t.timestamp?new Date(t.timestamp).getTime():0;
        out.push({tx_hash:String(t.transaction_hash||""),event_index:Number(t.log_index??0),from_address:from||null,
          to_address:addr,amount,confirmations:block>0?Math.max(0,latest-block+1):0,
          chain_timestamp:ts>0?new Date(ts).toISOString():null,raw:t});
      }
      return out;
    }
    return [];
  }catch(error){
    console.warn("Ethereum Blockscout unavailable; using Routescan no-key fallback",String((error as Error)?.message||error));
    if(asset==="ETH"||asset==="USDT")return await scanRoutescanEthereum(addr,asset,latest);
    throw error;
  }
}

// ---------- EVM (public RPC getLogs for BEP20 USDT) ----------
async function scanEvmLogs(rpcUrls:string[],usdtContract:string,addr:string):Promise<Candidate[]> {
  const head=await rpcJsonWithFallback(rpcUrls,"eth_blockNumber",[]);
  const latest=Number(hexToBigInt(String(head.result||"0x0")));
  if(!latest)return [];
  const fromBlock=Math.max(0,latest-4800);
  const data=await rpcJsonWithFallback(rpcUrls,"eth_getLogs",[{
    fromBlock:"0x"+fromBlock.toString(16),toBlock:"latest",address:usdtContract,
    topics:[TRANSFER_TOPIC,null,padAddressTopic(addr)],
  }]) as {result?:Array<{transactionHash:string;blockNumber:string;logIndex?:string;topics:string[];data:string}>};
  const out:Candidate[]=[];
  for(const log of data.result||[]){
    const valueHex=log.data?.replace(/^0x/,"").slice(0,64);
    if(!valueHex)continue;
    const amount=Number(BigInt("0x"+valueHex))/1e18;
    if(!Number.isFinite(amount)||amount<=0)continue;
    const block=Number(hexToBigInt(log.blockNumber));
    out.push({
      tx_hash:String(log.transactionHash||""),event_index:log.logIndex?Number(hexToBigInt(log.logIndex)):0,
      from_address:log.topics?.[1]?"0x"+log.topics[1].slice(-40):null,to_address:addr,
      amount,confirmations:Math.max(0,latest-block+1),chain_timestamp:null,raw:log,
    });
  }
  return out;
}

// ---------- Bitcoin// ---------- Bitcoin ----------
async function scanBitcoin(addr:string):Promise<Candidate[]> {
  const tipText=await getTextWithFallback(BITCOIN_API_BASES.map(base=>`${base}/blocks/tip/height`)).catch(error=>{
    console.warn("Bitcoin tip unavailable; confirmations will wait for a successful tip check",error);
    return "0";
  });
  const tip=Number(tipText);
  const txs=await getJsonWithFallback(BITCOIN_API_BASES.map(base=>`${base}/address/${encodeURIComponent(addr)}/txs`)) as Array<{
    txid?:string;vout?:Array<{scriptpubkey_address?:string;value?:number}>;
    vin?:Array<{prevout?:{scriptpubkey_address?:string;value?:number}}>;
    status?:{confirmed?:boolean;block_height?:number};blocktime?:number;
  }>;
  const out:Candidate[]=[];
  for(const tx of txs.slice(0,25)){
    for(let i=0;i<(tx.vout||[]).length;i++){
      const v=tx.vout![i];if(v.scriptpubkey_address!==addr)continue;
      const amount=Number(v.value||0)/1e8;if(!Number.isFinite(amount)||amount<=0)continue;
      const spent=(tx.vin||[]).some(vi=>vi.prevout?.scriptpubkey_address===addr);
      const conf=tx.status?.confirmed&&tx.status.block_height&&tip>0
        ?Math.max(0,tip-tx.status.block_height+1):(tx.status?.confirmed?1:0);
      out.push({tx_hash:String(tx.txid||""),event_index:i,from_address:spent?addr:null,to_address:addr,
        amount,confirmations:conf,chain_timestamp:tx.blocktime?new Date(tx.blocktime*1000).toISOString():null,raw:{txid:tx.txid,vout:v}});
    }
  }
  return out;
}

// ---------- Dogecoin// ---------- Dogecoin (Trezor blockbook) ----------
type FreedomDogeAddressTx = { hash?: string; amount?: number | string; block?: string; seen?: number };
type FreedomDogeBlock = { height?: number | string; mined?: number };
type FreedomDogeTx = {
  block?: string;
  mined?: number;
  seen?: number;
  from?: Array<{ address?: string }>;
  to?: Array<{ index?: number; address?: string; amount?: number | string }>;
};

async function scanDogecoin(addr:string):Promise<Candidate[]> {
  const base="https://api.freedom.st";
  const addressRaw=await getJson(`${base}/doge/address/${encodeURIComponent(addr)}`) as {
    data?:{transactions?:FreedomDogeAddressTx[]};
    transactions?:FreedomDogeAddressTx[];
  };
  const addressData=(addressRaw.data&&typeof addressRaw.data==="object"?addressRaw.data:addressRaw) as {
    transactions?:FreedomDogeAddressTx[];
  };
  if(!Array.isArray(addressData.transactions)) {
    throw new Error("Freedom Street returned an unexpected Dogecoin address response");
  }

  // Only positive address-level movements are deposits. Query our own ledger
  // first so already-credited history does not cause repeated TX/block lookups.
  const incoming=addressData.transactions
    .filter(tx=>Boolean(tx.hash)&&Number.isFinite(Number(tx.amount))&&Number(tx.amount)>0)
    .slice(0,100);
  if(!incoming.length)return [];

  let latestHeight=0;
  try{
    const infoRaw=await getJson(`${base}/doge/info`) as {
      data?:{blockchain?:{blocks?:number|string};doge?:{blockchain?:{blocks?:number|string}}};
      doge?:{blockchain?:{blocks?:number|string}};
      blockchain?:{blocks?:number|string};
    };
    const info=(infoRaw.data&&typeof infoRaw.data==="object"?infoRaw.data:infoRaw) as {
      doge?:{blockchain?:{blocks?:number|string}};
      blockchain?:{blocks?:number|string};
    };
    latestHeight=Number(info.doge?.blockchain?.blocks??info.blockchain?.blocks??0);
  }catch(error){
    console.warn("Freedom Street Dogecoin tip unavailable; confirmations will be rechecked",String((error as Error)?.message||error));
  }

  const hashes=[...new Set(incoming.map(tx=>String(tx.hash)))];
  const inFilter=encodeURIComponent(`(${hashes.join(",")})`);
  const knownRes=await rest(
    `blockchain_deposits?network_code=eq.DOGECOIN&tx_hash=in.${inFilter}&select=tx_hash,event_index,deposit_status,amount,from_address,to_address,chain_timestamp,raw_event`,
    {method:"GET"},
  );
  type KnownDogeRow={
    tx_hash:string;event_index:number;deposit_status:string;amount:number|string;
    from_address:string|null;to_address:string;chain_timestamp:string|null;raw_event?:unknown;
  };
  const knownRows=knownRes.ok?await knownRes.json() as KnownDogeRow[]:[];
  if(!knownRes.ok)console.warn("Could not read existing Dogecoin scan records; the unique deposit constraint still protects against duplicate credits");

  const knownByTx=new Map<string,KnownDogeRow[]>();
  for(const row of knownRows){
    const list=knownByTx.get(row.tx_hash)||[];
    list.push(row);
    knownByTx.set(row.tx_hash,list);
  }

  const blockCache=new Map<string,Promise<FreedomDogeBlock>>();
  const getBlock=(hash:string)=>{
    const cached=blockCache.get(hash);
    if(cached)return cached;
    const request=(async()=>{
      const raw=await getJson(`${base}/doge/block/${encodeURIComponent(hash)}`) as {
        data?:FreedomDogeBlock;height?:number|string;mined?:number;
      };
      return (raw.data&&typeof raw.data==="object"?raw.data:raw) as FreedomDogeBlock;
    })();
    blockCache.set(hash,request);
    return request;
  };

  const out:Candidate[]=[];
  for(const ref of incoming){
    const txHash=String(ref.hash);
    const existing=knownByTx.get(txHash)||[];
    if(existing.length&&existing.every(row=>["confirmed","credited"].includes(String(row.deposit_status).toLowerCase()))) {
      continue;
    }

    // A confirming deposit already has its output index and block height stored.
    // Recalculate confirmations from the fresh chain tip without another TX lookup.
    const savedRows=existing.filter(row=>String(row.deposit_status).toLowerCase()==="confirming");
    const savedWithHeight=savedRows.filter(row=>{
      const raw=row.raw_event&&typeof row.raw_event==="object"?row.raw_event as Record<string,unknown>:{};
      return Number(raw.block_height||0)>0;
    });
    if(savedWithHeight.length&&latestHeight>0){
      for(const row of savedWithHeight){
        const raw=row.raw_event&&typeof row.raw_event==="object"?row.raw_event as Record<string,unknown>:{};
        const blockHeight=Number(raw.block_height||0);
        out.push({
          tx_hash:row.tx_hash,event_index:Number(row.event_index||0),
          from_address:row.from_address,to_address:row.to_address||addr,
          amount:Number(row.amount),
          confirmations:Math.max(0,latestHeight-blockHeight+1),
          chain_timestamp:row.chain_timestamp,
          raw:{...raw,provider:"Freedom Street"},
        });
      }
      continue;
    }

    try{
      const txRaw=await getJson(`${base}/doge/tx/${encodeURIComponent(txHash)}`) as {
        data?:FreedomDogeTx;block?:string;mined?:number;seen?:number;from?:FreedomDogeTx["from"];to?:FreedomDogeTx["to"];
      };
      const tx=(txRaw.data&&typeof txRaw.data==="object"?txRaw.data:txRaw) as FreedomDogeTx;
      const outputs=Array.isArray(tx.to)?tx.to:[];
      const blockHash=String(tx.block||ref.block||"");
      if(!outputs.length)continue;

      let blockHeight=0,blockMined=0;
      if(blockHash){
        try{
          const block=await getBlock(blockHash);
          blockHeight=Number(block.height||0);
          blockMined=Number(block.mined||0);
        }catch(error){
          console.warn("Freedom Street Dogecoin block lookup failed; transaction will be rechecked",txHash,String((error as Error)?.message||error));
        }
      }
      const confirmations=latestHeight>0&&blockHeight>0?Math.max(0,latestHeight-blockHeight+1):0;
      const timestamp=Number(tx.mined||blockMined||tx.seen||ref.seen||0);
      const fromAddress=String(tx.from?.[0]?.address||"")||null;
      for(const output of outputs){
        if(String(output.address||"")!==addr)continue;
        const amount=Number(output.amount||0);
        if(!Number.isFinite(amount)||amount<=0)continue;
        out.push({
          tx_hash:txHash,
          event_index:Number(output.index||0),
          from_address:fromAddress,
          to_address:addr,
          amount,
          confirmations,
          chain_timestamp:timestamp>0?new Date(timestamp*1000).toISOString():null,
          raw:{provider:"Freedom Street",block_hash:blockHash||null,block_height:blockHeight||null,output_index:Number(output.index||0)},
        });
      }
    }catch(error){
      console.warn("Freedom Street Dogecoin transaction lookup failed; it will be checked again",txHash,String((error as Error)?.message||error));
    }
  }
  return out;
}

// ---------- Solana// ---------- Solana ----------
async function scanSolana(addr:string,asset:string):Promise<Candidate[]> {
  const call=(method:string,params:unknown[])=>
    rpcJsonWithFallback(SOLANA_RPC_URLS,method,params) as Promise<{result?:unknown;error?:unknown}>;
  const sigs=await call("getSignaturesForAddress",[addr,{limit:20,commitment:"finalized"}]) as {
    result?:Array<{signature:string;confirmationStatus?:string;blockTime?:number}>;
  };
  const out:Candidate[]=[];
  for(const sig of (sigs.result||[]).slice(0,12)){
    if(!sig.signature)continue;
    if(sig.confirmationStatus&&sig.confirmationStatus!=="finalized")continue;
    try{
      const tx=await call("getTransaction",[sig.signature,{encoding:"json",commitment:"finalized",maxSupportedTransactionVersion:0}]) as {
        result?:{meta?:{preBalances?:number[];postBalances?:number[];
          preTokenBalances?:Array<{owner?:string;mint?:string;uiTokenAmount?:{uiAmount?:number}}>|null;
          postTokenBalances?:Array<{owner?:string;mint?:string;uiTokenAmount?:{uiAmount?:number}}>|null;status?:{Err?:unknown}};
          transaction?:{message?:{accountKeys?:string[]}}};
      };
      const meta=tx.result?.meta,keys=tx.result?.transaction?.message?.accountKeys||[];
      if(!meta||meta.status?.Err)continue;
      if(asset==="SOL"){
        const idx=keys.indexOf(addr);
        if(idx>=0){
          const amount=((meta.postBalances?.[idx]||0)-(meta.preBalances?.[idx]||0))/1e9;
          if(amount>0)out.push({tx_hash:sig.signature,event_index:0,from_address:null,to_address:addr,amount,
            confirmations:32,chain_timestamp:sig.blockTime?new Date(sig.blockTime*1000).toISOString():null,raw:{signature:sig.signature,delta:amount}});
        }
      }
      if(asset==="USDT"){
        const pre=meta.preTokenBalances||[],post=meta.postTokenBalances||[];
        const pick=(items:typeof post)=>items.filter(item=>item.owner===addr&&item.mint===SOL_USDT_MINT)
          .reduce((sum,item)=>sum+Number(item.uiTokenAmount?.uiAmount||0),0);
        const amount=pick(post)-pick(pre);
        if(amount>0)out.push({tx_hash:sig.signature,event_index:1,from_address:null,to_address:addr,amount,
          confirmations:32,chain_timestamp:sig.blockTime?new Date(sig.blockTime*1000).toISOString():null,raw:{signature:sig.signature,delta:amount}});
      }
    }catch(error){console.warn("Solana transaction lookup failed on public RPCs",sig.signature,String((error as Error)?.message||error));}
  }
  return out;
}

async function scanAddress(row: AddressRow): Promise<Candidate[]> {
  const asset=String(row.asset_code||"").toUpperCase(),network=String(row.network_code||"").toUpperCase(),addr=row.address;
  try{
    if(network==="TRC20"&&asset==="USDT")return await scanTronToken(addr);
    if(network==="TRON"&&asset==="TRX")return await scanTronNative(addr);
    if(network==="ERC20"||network==="ETHEREUM")return await scanBlockscout(network,addr,asset);
    if(network==="BEP20"&&asset==="USDT")return await scanEvmLogs(BSC_RPC_URLS,USDT_CONTRACTS.BEP20,addr);
    if(network==="BITCOIN"&&asset==="BTC")return await scanBitcoin(addr);
    if(network==="DOGECOIN"&&asset==="DOGE")return await scanDogecoin(addr);
    if(network==="SOLANA")return await scanSolana(addr,asset);
    return [];
  }catch(error){
    console.warn(`scan failed for ${network} ${addr}; it will be checked again next cycle`,error);
    return [];
  }
}

type AddressRow = { id: string; user_id: string; asset_network_id: string; asset_code: string; network_code: string; address: string };

async function rest(path: string, init: RequestInit): Promise<Response> {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...init, headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json", ...(init.headers || {}) } });
}

async function fallbackUsdPrice(asset:string):Promise<number|null>{
  const krakenPair:Record<string,string>={BTC:"XBTUSD",ETH:"ETHUSD",SOL:"SOLUSD",TRX:"TRXUSD",DOGE:"XDGUSD"};
  try{
    const data=await getJson(`https://api.coinbase.com/v2/exchange-rates?currency=${asset}`) as {data?:{rates?:{USD?:string|number}}};
    const value=Number(data.data?.rates?.USD);
    if(Number.isFinite(value)&&value>0)return value;
  }catch(error){console.warn("Coinbase USD price backup unavailable",asset,String((error as Error)?.message||error));}
  try{
    const data=await getJson(`https://api.kraken.com/0/public/Ticker?pair=${krakenPair[asset]}`) as {
      error?:string[];result?:Record<string,{c?:string[]}>;
    };
    const value=Number(Object.values(data.result||{})[0]?.c?.[0]);
    if(!data.error?.length&&Number.isFinite(value)&&value>0)return value;
  }catch(error){console.warn("Kraken USD price backup unavailable",asset,String((error as Error)?.message||error));}
  return null;
}
async function loadPrices():Promise<Record<string,number>>{
  const prices:Record<string,number>={USDT:1};
  try{
    const ids=Object.values(COINGECKO_IDS).join(",");
    const data=await getJson(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`) as Record<string,{usd?:number}>;
    for(const[asset,id]of Object.entries(COINGECKO_IDS)){
      const value=Number(data[id]?.usd);
      if(Number.isFinite(value)&&value>0)prices[asset]=value;
    }
  }catch(error){console.warn("CoinGecko price feed unavailable; using backup price sources",error);}
  for(const asset of ["BTC","ETH","SOL","TRX","DOGE"]){
    if(prices[asset])continue;
    const value=await fallbackUsdPrice(asset);
    if(value&&Number.isFinite(value)&&value>0)prices[asset]=value;
  }
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
      // Check every active address each 30-second cycle (the DB RPC caps this
      // at 50), avoiding a multi-cycle wait after simultaneous deposit bursts.
      method: "POST", body: JSON.stringify({ p_limit: 50 }),
    });
    if (!addrRes.ok) throw new Error("Could not load the next deposit-monitor batch");
    const addresses = await addrRes.json() as AddressRow[];

    // Native TRX uses one shared solidified-block scan for every active TRX
    // deposit address, rather than waiting for the rotating six-address batch.
    let scanAddresses = addresses;
    const trxAddressRes = await rest(
      "user_deposit_addresses?asset_network_id=eq.trx-tron&address_status=eq.active&select=id,user_id,asset_network_id,asset_code,network_code,address&order=created_at.asc&limit=1000",
      { method: "GET" },
    );
    if (trxAddressRes.ok) {
      const trxRows = await trxAddressRes.json() as AddressRow[];
      scanAddresses = [
        ...addresses.filter(row => !(String(row.network_code).toUpperCase() === "TRON" && String(row.asset_code).toUpperCase() === "TRX")),
        ...trxRows,
      ];
    } else {
      console.warn("Could not load all active native TRX addresses; using the current rotating batch");
    }

    const prices = await loadPrices();
    const minimumRes = await rest("site_settings?setting_key=eq.minimum_deposit_usd&select=numeric_value&limit=1", { method: "GET" });
    const minimumRows = minimumRes.ok ? await minimumRes.json() as Array<{ numeric_value?: number | string }> : [];
    const minimumUsd = Number(minimumRows[0]?.numeric_value ?? 10);
    const requiredFor = (network: string) => REQUIRED_CONFIRMATIONS[String(network || "").toUpperCase()] ?? 12;

    // 1. Record newly detected transfers.
    const pendingRows: Array<Record<string, unknown>> = [];
    const concurrency = 3;
    for (let i = 0; i < scanAddresses.length; i += concurrency) {
      const batch = scanAddresses.slice(i, i + concurrency);
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
    return response({ ok: true, scanned: scanAddresses.length, credited: mine, creditedTotal: credited.length, minimum_usd: minimumUsd });
  } catch (e) {
    console.error("deposit monitor failed", e);
    return response({ error: "Deposit monitoring failed. Please try again later." }, 500);
  }
});

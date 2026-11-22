import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { ethers } from "npm:ethers@6.13.5";

const TRON_USDT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const ETH_USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const BSC_USDT = "0x55d398326f99094fF71046d3C4e1Fb9e2b2e5c7";
const RPC: Record<string, string> = { ERC20: "https://ethereum-rpc.publicnode.com", ETHEREUM: "https://ethereum-rpc.publicnode.com", BEP20: "https://bsc-rpc.publicnode.com" };
const USDT_ADDR: Record<string, string> = { ERC20: ETH_USDT, ETHEREUM: ETH_USDT, BEP20: BSC_USDT };
const CG_ID: Record<string, string> = { ETH: "ethereum", BNB: "binancecoin", TRX: "tron", BTC: "bitcoin", DOGE: "dogecoin", SOL: "solana" };

function response(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info", "Access-Control-Allow-Methods": "POST, OPTIONS", "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

async function usdPrice(id: string): Promise<number> {
  try { const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=" + id + "&vs_currencies=usd"); const d = await r.json(); return Number(d?.[id]?.usd ?? 0); } catch { return 0; }
}

async function tronRecipientHasUsdt(to: string): Promise<boolean | null> {
  try {
    const param = "000000000000000000000000" + to.slice(1).padStart(64, "0");
    const r = await fetch("https://api.trongrid.io/wallet/triggerconstantcontract", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ owner_address: to, contract_address: TRON_USDT, function_selector: "balanceOf(address)", parameter: param, visible: true })
    });
    const d = await r.json();
    const hex = String(d?.constant_result?.[0] ?? "0");
    return BigInt("0x" + (hex || "0")) > 0n;
  } catch { return null; }
}

async function tronFee(from: string, to: string): Promise<{ native: number; detail: string; balance: string | null; trx: number | null }> {
  const hasRecipientUsdt = await tronRecipientHasUsdt(to);
  const energy = hasRecipientUsdt === false ? 130000 : 65000;
  const params = await fetch("https://api.trongrid.io/wallet/getchainparameters", { headers: { "Content-Type": "application/json" } });
  const plist = ((await params.json())?.chainParameter) ?? [];
  const energyFee = Number((plist.find((x: any) => x.key === "getEnergyFee")?.value ?? 420));
  const txFeeSun = Number((plist.find((x: any) => x.key === "getTransactionFee")?.value ?? 1000));
  let balance: string | null = null, trx: number | null = null;
  if (from) {
    try {
      const acc = await fetch("https://api.trongrid.io/wallet/getaccount", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: from, visible: true }) });
      const ad = await acc.json();
      const usdtHex = (ad?.assetV2 ?? []).find((x: any) => x.key === "1002000")?.value ?? "0";
      balance = (parseInt(usdtHex || "0", 16) / 1e6).toFixed(2);
      trx = Number(ad?.balance ?? 0) / 1e6;
    } catch { /* ignore */ }
  }
  const bytes = 345;
  const bandwidthSun = bytes * txFeeSun;
  const totalSun = energy * energyFee + bandwidthSun;
  return { native: Math.round(totalSun) / 1e6, detail: "energy " + energy + " x " + energyFee + " sun + bandwidth " + bandwidthSun + " sun" + (hasRecipientUsdt === false ? " (recipient is new to USDT)" : ""), balance, trx };
}

async function evmFee(network: string, from: string, to: string, amount6: string): Promise<{ native: number; detail: string; balance: string | null; token_balance: string | null }> {
  const provider = new ethers.JsonRpcProvider(RPC[network]);
  const usdt = new ethers.Contract(USDT_ADDR[network], ["function transfer(address to, uint256 amount) returns (bool)", "function balanceOf(address a) view returns (uint256)"], provider);
  let gasUnits = 65000n, detail = "standard USDT transfer";
  let token_balance: string | null = null;
  if (from) {
    try { token_balance = ethers.formatUnits(await usdt.balanceOf(from), 6); } catch { /* ignore */ }
  }
  try {
    gasUnits = await usdt.transfer.estimateGas(to, BigInt(amount6));
    detail = "estimated " + gasUnits.toString() + " gas x live gas price";
  } catch (e) {
    detail = "live estimate failed (wallet may lack funds/allowance); using standard 65,000 gas";
  }
  const fd = await provider.getFeeData();
  const gasPrice = Number(fd.gasPrice ?? 0n);
  const native = Number(gasUnits) * gasPrice / 1e18;
  let balance: string | null = null;
  if (from) { try { balance = ethers.formatEther(await provider.getBalance(from)); } catch { /* ignore */ } }
  return { native: Math.round(native * 1e9) / 1e9, detail, balance, token_balance };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return response({ ok: true });
  if (req.method !== "POST") return response({ error: "Method not allowed" }, 405);
  try {
    const b = await req.json().catch(() => ({}));
    const network = String(b?.network ?? "").toUpperCase();
    const from = String(b?.from_address ?? "");
    const to = String(b?.to_address ?? "").trim();
    const amountCoin = String(b?.amount_coin ?? "0").replace(/,/g, "");
    let native = 0, unit = "", detail = "", asset = "USDT";
    let balance: string | null = null, token_balance: string | null = null;
    if (network === "TRC20" || network === "TRON") {
      const f = await tronFee(from, to);
      native = f.native; detail = f.detail; unit = "TRX"; balance = f.balance; token_balance = f.trx === null ? null : null;
      return response({ asset, network, native, native_unit: unit, usd: Math.round(native * (await usdPrice("tron")) * 100) / 100, detail, real: true, wallet_usdt_balance: balance, wallet_trx: f.trx });
    } else if (network === "ERC20" || network === "ETHEREUM" || network === "BEP20") {
      const amount6 = BigInt(Math.max(0, Math.round(Number(amountCoin) * 1e6))).toString();
      const f = await evmFee(network, from, to, amount6);
      native = f.native; detail = f.detail; unit = network === "BEP20" ? "BNB" : "ETH"; balance = f.balance; token_balance = f.token_balance;
      const price = await usdPrice(CG_ID[unit] ?? "tether");
      return response({ asset, network, native, native_unit: unit, usd: Math.round(native * price * 100) / 100, detail, real: true, wallet_usdt_balance: token_balance, wallet_native: balance });
    } else if (network === "BITCOIN") {
      const r = await fetch("https://mempool.space/api/v1/fees/recommended");
      const d = await r.json();
      native = Number(d?.fastestFee ?? 12) * 141 / 1e8; detail = "fastestFee x 141 vB"; unit = "BTC";
    } else if (network === "SOLANA") {
      native = 0.000005; detail = "fixed network fee"; unit = "SOL";
    } else if (network === "DOGECOIN") {
      native = 1; detail = "typical DOGE fee"; unit = "DOGE";
    } else {
      return response({ error: "Unsupported network" }, 400);
    }
    const price = await usdPrice(CG_ID[unit] ?? "tether");
    return response({ asset, network, native: Math.round(native * 1e9) / 1e9, native_unit: unit, usd: Math.round(native * price * 100) / 100, detail, real: true });
  } catch (e) {
    console.error("chain-fee-estimate error", e);
    return response({ error: "Fee estimation failed on the live network. " + String(e?.message ?? "") }, 500);
  }
});

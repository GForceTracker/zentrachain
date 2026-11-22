import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const CG = "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,binancecoin,tether,tron,dogecoin,solana&vs_currencies=usd";
const FALLBACK: Record<string, number> = { ethereum: 3200, binancecoin: 610, tron: 0.26, bitcoin: 67000, dogecoin: 0.16, solana: 150, tether: 1 };

function j(x: unknown, status = 200) {
  return new Response(JSON.stringify(x), { status, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info", "Access-Control-Allow-Methods": "POST, OPTIONS", "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

async function ethGas(rpc: string): Promise<number | null> {
  try {
    const r = await fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_gasPrice", params: [] }) });
    const d = await r.json();
    const wei = BigInt(d?.result ?? "0");
    if (wei <= 0n) return null;
    return Number(wei) / 1e18;
  } catch { return null; }
}

async function btcFees(): Promise<number | null> {
  try {
    const r = await fetch("https://mempool.space/api/v1/fees/recommended");
    const d = await r.json();
    const v = Number(d?.fastestFee ?? 0);
    return v > 0 ? v : null;
  } catch { return null; }
}

async function tronEstimate(): Promise<number | null> {
  try {
    const r = await fetch("https://api.trongrid.io/wallet/triggerconstantcontract", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        owner_address: "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb",
        contract_address: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
        function_selector: "transfer(address,uint256)",
        parameter: "0000000000000000000000004158cb84ad1e2c8b4a1c9c8d0e5f6a7b8c9d0e1f2000000000000000000000000000000000000000000000000000000000000030d40",
        visible: true
      })
    });
    const d = await r.json();
    const energy = Number(d?.energy_used ?? 0);
    if (energy > 0) return energy * 420 / 1e6 + 0.35;
    return null;
  } catch { return null; }
}

async function usdPrices(): Promise<Record<string, number>> {
  try {
    const r = await fetch(CG);
    const d = await r.json();
    const out: Record<string, number> = {};
    for (const k of Object.keys(d || {})) out[k] = Number(d[k]?.usd ?? 0) || FALLBACK[k] || 0;
    for (const k of Object.keys(FALLBACK)) if (!out[k]) out[k] = FALLBACK[k];
    return out;
  } catch { return { ...FALLBACK }; }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return j({ ok: true });
  if (req.method !== "POST") return j({ error: "Method not allowed" }, 405);
  try {
    const body = await req.json();
    const network = String(body?.network ?? "").toUpperCase();
    const prices = await usdPrices();
    let asset = "USDT", unit = "", native = 0;
    if (network === "ERC20" || network === "ETHEREUM") {
      const g = await ethGas("https://ethereum-rpc.publicnode.com");
      native = (g ?? 30e-9) * 84000; unit = "ETH";
    } else if (network === "BEP20") {
      const g = await ethGas("https://bsc-rpc.publicnode.com");
      native = (g ?? 3e-9) * 100000; unit = "BNB";
    } else if (network === "TRC20" || network === "TRON") {
      native = await tronEstimate() ?? 30; unit = "TRX";
    } else if (network === "BITCOIN") {
      const f = await btcFees();
      native = (f ?? 12) * 141 / 1e8; unit = "BTC";
    } else if (network === "DOGECOIN") {
      native = 1; unit = "DOGE";
    } else if (network === "SOLANA") {
      native = 0.00201; unit = "SOL";
    } else {
      return j({ error: "Unsupported network" }, 400);
    }
    const id = ({ ETH: "ethereum", BNB: "binancecoin", TRX: "tron", BTC: "bitcoin", DOGE: "dogecoin", SOL: "solana" } as Record<string, string>)[unit] ?? "tether";
    const price = prices[id] ?? 0;
    const usd = native * price;
    return j({ asset: "USDT", network, native: Math.round(native * 1e6) / 1e6, native_unit: unit, price, usd: Math.round(usd * 100) / 100 });
  } catch (e) {
    return j({ error: "Gas estimation unavailable" }, 500);
  }
});

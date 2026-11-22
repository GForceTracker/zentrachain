import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { ethers } from "npm:ethers@6.13.5";
import { mnemonicToSeedSync, validateMnemonic } from "npm:@scure/bip39@1.5.4";
import { wordlist } from "npm:@scure/bip39@1.5.4/wordlists/english";
import { HDKey } from "npm:@scure/bip32@1.4.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MNEMONIC = (Deno.env.get("WALLET_MNEMONIC") ?? "").trim().split(/\s+/).filter(Boolean).join(" ");
const TRON_USDT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const USDT_ADDR: Record<string, string> = { ERC20: "0xdAC17F958D2ee523a2206206994597C13D831ec7", ETHEREUM: "0xdAC17F958D2ee523a2206206994597C13D831ec7", BEP20: "0x55d398326f99094fF71046d3C4e1Fb9e2b2e5c7" };
const RPC: Record<string, string> = { ERC20: "https://ethereum-rpc.publicnode.com", ETHEREUM: "https://ethereum-rpc.publicnode.com", BEP20: "https://bsc-rpc.publicnode.com" };

function response(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info", "Access-Control-Allow-Methods": "POST, OPTIONS", "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

function evmKind(network: string) { const n = network.toUpperCase(); return (n === "ERC20" || n === "ETHEREUM") ? "evm-eth" : (n === "BEP20") ? "evm-bnb" : null; }

async function usdPrice(id: string): Promise<number> {
  try { const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=" + id + "&vs_currencies=usd"); const d = await r.json(); return Number(d?.[id]?.usd ?? 0); } catch { return 0; }
}

async function tronAccountState(address: string): Promise<{ usdt: number; trx: number; freeNet: number; freeUsed: number; energyFee: number; txFeeSun: number }> {
  const acc = await fetch("https://api.trongrid.io/wallet/getaccount", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address, visible: true }) });
  const ad = await acc.json().catch(() => ({}));
  const usdtHex = (ad?.assetV2 ?? []).find((x: any) => x.key === "1002000")?.value ?? "0";
  const res = await fetch("https://api.trongrid.io/wallet/getaccountresource", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address, visible: true }) });
  const rd = await res.json().catch(() => ({}));
  const params = await fetch("https://api.trongrid.io/wallet/getchainparameters", { headers: { "Content-Type": "application/json" } });
  const plist = ((await params.json())?.chainParameter) ?? [];
  return {
    usdt: parseInt(usdtHex || "0", 16) / 1e6,
    trx: Number(ad?.balance ?? 0) / 1e6,
    freeNet: Number(rd?.freeNetLimit ?? 600),
    freeUsed: Number(rd?.freeNetUsed ?? 0),
    energyFee: Number((plist.find((x: any) => x.key === "getEnergyFee")?.value ?? 420)),
    txFeeSun: Number((plist.find((x: any) => x.key === "getTransactionFee")?.value ?? 1000))
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return response({ ok: true });
  if (req.method !== "POST") return response({ error: "Method not allowed" }, 405);
  try {
    if (!SUPABASE_URL || !SERVICE_KEY) return response({ error: "Service is not configured" }, 503);
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader.startsWith("Bearer ")) return response({ error: "Authentication required" }, 401);
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SERVICE_KEY, Authorization: authHeader } });
    if (!userRes.ok) return response({ error: "Invalid session" }, 401);
    const user = await userRes.json();
    if (!user?.id) return response({ error: "Invalid session" }, 401);
    const profRes = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${user.id}&select=role&limit=1`, { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } });
    const profRows = profRes.ok ? await profRes.json() : [];
    if (!profRows.length || profRows[0].role !== "admin") return response({ error: "Administrator access required" }, 403);

    const b = await req.json().catch(() => ({}));
    const depositId = String(b?.deposit_address_id ?? "");
    const userId = String(b?.user_id ?? "");
    const asset = String(b?.asset ?? "USDT").toUpperCase();
    const network = String(b?.network ?? "").toUpperCase();
    const to = String(b?.to_address ?? "").trim();
    const amountCoin = Number(b?.amount_coin ?? 0);
    const note = String(b?.note ?? "").trim();
    if (!depositId || !userId || !to || !(amountCoin > 0)) return response({ error: "Missing withdrawal details" }, 400);

    const rowRes = await fetch(`${SUPABASE_URL}/rest/v1/user_deposit_addresses?id=eq.${depositId}&select=id,user_id,address,asset_code,network_code,derivation_path&limit=1`, { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } });
    const rows = rowRes.ok ? await rowRes.json() : [];
    const row = rows[0];
    if (!row) return response({ error: "Deposit wallet not found" }, 404);
    const path = String(row.derivation_path ?? "");
    if (!path.startsWith("m/")) return response({ error: "This deposit wallet has no derivation path recorded" }, 400);
    if (!MNEMONIC) return response({ error: "WALLET_MNEMONIC secret is missing" }, 503);
    if (!validateMnemonic(MNEMONIC, wordlist)) return response({ error: "WALLET_MNEMONIC is invalid" }, 503);

    const kind = evmKind(network);
    const isTron = network === "TRC20" || network === "TRON";
    if (!kind && !isTron) {
      return response({ error: "On-chain broadcast for this network is not supported yet. Use the private key to send manually.", unsupported: true }, 400);
    }

    let txid = "";
    let feeNative = 0, feeUnit = "TRX", txUrl = "";

    if (kind === "evm-eth" || kind === "evm-bnb") {
      if (!/^0x[a-fA-F0-9]{40}$/.test(to)) return response({ error: "The destination address is not a valid " + network + " address." }, 400);
      const provider = new ethers.JsonRpcProvider(RPC[network]);
      const w = HDNodeWallet.fromPhrase(MNEMONIC, undefined, path);
      if (w.address.toLowerCase() !== String(row.address).toLowerCase()) return response({ error: "Derived address mismatch - verify before sending." }, 400);
      const signer = new ethers.Wallet(w.privateKey, provider);
      const usdt = new ethers.Contract(USDT_ADDR[network], ["function transfer(address to, uint256 amount) returns (bool)", "function balanceOf(address a) view returns (uint256)"], signer);
      const tokenBal = ethers.formatUnits(await usdt.balanceOf(row.address), 6);
      if (Number(tokenBal) < amountCoin) return response({ error: "Wallet has " + tokenBal + " USDT - not enough for " + amountCoin + "." }, 400);
      const gasUnits = await usdt.transfer.estimateGas(to, BigInt(Math.round(amountCoin * 1e6)));
      const fd = await provider.getFeeData();
      const gasNative = Number(gasUnits) * Number(fd.gasPrice ?? 0n) / 1e18;
      const nativeBal = ethers.formatEther(await provider.getBalance(row.address));
      if (Number(nativeBal) < gasNative) return response({ error: "Wallet needs ~" + gasNative.toFixed(6) + " " + (kind === "evm-eth" ? "ETH" : "BNB") + " for gas but has " + Number(nativeBal).toFixed(6) + ". Send gas to the wallet first." }, 400);
      const tx = await usdt.transfer(to, BigInt(Math.round(amountCoin * 1e6)));
      txid = tx.hash;
      feeNative = gasNative; feeUnit = kind === "evm-eth" ? "ETH" : "BNB";
      txUrl = network === "BEP20" ? "https://bscscan.com/tx/" + txid : "https://etherscan.io/tx/" + txid;
    } else {
      if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(to)) return response({ error: "The destination address is not a valid TRON address." }, 400);
      const seed = mnemonicToSeedSync(MNEMONIC);
      const root = HDKey.fromMasterSeed(seed);
      const node = root.derive(path);
      if (!node.privateKey) throw new Error("Could not derive private key");
      const pkHex = Array.from(new Uint8Array(node.privateKey), x => x.toString(16).padStart(2, "0")).join("");
      const state = await tronAccountState(row.address);
      if (state.usdt < amountCoin) return response({ error: "Wallet has " + state.usdt + " USDT - not enough for " + amountCoin + "." }, 400);
      const param = "000000000000000000000000" + row.address.slice(1).padStart(64, "0") + BigInt(Math.round(amountCoin * 1e6)).toString(16).padStart(64, "0");
      const build = await fetch("https://api.trongrid.io/wallet/triggersmartcontract", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner_address: row.address, contract_address: TRON_USDT, function_selector: "transfer(address,uint256)", parameter: param, fee_limit: 400000000, visible: true })
      });
      const bd = await build.json();
      if (bd?.result?.result !== true) return response({ error: "TRON rejected the transaction build: " + (bd?.result?.message ?? "unknown") }, 400);
      const energy = Number(bd?.energy_used ?? 0);
      const bytes = Math.ceil(String(bd?.transaction?.raw_data_hex ?? "").length / 2) + 67;
      const bandwidthSun = bytes > Math.max(0, state.freeNet - state.freeUsed) ? (bytes - Math.max(0, state.freeNet - state.freeUsed)) * state.txFeeSun : 0;
      const feeTrx = Math.round(energy * state.energyFee + bandwidthSun) / 1e6;
      if (state.trx < feeTrx) return response({ error: "Wallet needs ~" + feeTrx + " TRX for gas but has " + state.trx + " TRX. Send TRX to the wallet first." }, 400);
      const rawDataHex = String(bd?.transaction?.raw_data_hex ?? "");
      const digestBytes = ethers.sha256(ethers.getBytes("0x" + rawDataHex));
      const signingKey = new ethers.SigningKey("0x" + pkHex);
      const sigObj = signingKey.sign(digestBytes);
      const vHex = sigObj.yParity === 0 ? "00" : "01";
      const sigHex = sigObj.r.slice(2).padStart(64, "0") + sigObj.s.slice(2).padStart(64, "0") + vHex;
      const bc = await fetch("https://api.trongrid.io/wallet/broadcasttransaction", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...bd.transaction, signature: [sigHex], visible: true })
      });
      const bcd = await bc.json().catch(() => ({}));
      if (bcd?.result !== true) return response({ error: "TRON broadcast failed: " + (bcd?.message ?? "unknown") }, 400);
      txid = String(bd.transaction.txID ?? "");
      feeNative = feeTrx; feeUnit = "TRX";
      txUrl = "https://tronscan.org/#/transaction/" + txid;
    }

    let usdValue = amountCoin;
    if (asset !== "USDT") usdValue = amountCoin * (await usdPrice(asset === "TRX" ? "tron" : asset.toLowerCase()));
    const feeUsd = feeNative * (await usdPrice(feeUnit === "TRX" ? "tron" : feeUnit === "ETH" ? "ethereum" : "binancecoin"));

    const tr = await fetch(SUPABASE_URL + "/rest/v1/treasury_withdrawals", {
      method: "POST",
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json", Prefer: "return=representation" },
      body: JSON.stringify({ asset_code: asset, network_code: network, amount: round2(usdValue), gas_fee: round2(feeUsd), destination_address: to, tx_hash: txid, note: note || "On-chain broadcast", user_id: userId, created_by: user.id, status: "sent" })
    });
    const trRows = tr.ok ? await tr.json() : [];
    const treId = trRows[0]?.id;
    await fetch(SUPABASE_URL + "/rest/v1/rpc/admin_treasury_withdraw_from_user", {
      method: "POST",
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ p_user_id: userId, p_asset: asset, p_network: network, p_amount: round2(usdValue), p_gas_fee: round2(feeUsd), p_destination: to, p_note: (note ? note + " " : "") + "tx " + txid })
    });
    await fetch(SUPABASE_URL + "/rest/v1/audit_logs", {
      method: "POST",
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ actor_id: user.id, action: "onchain_broadcast", entity_type: "treasury_withdrawal", entity_id: String(treId ?? ""), details: { txid, fee_native: feeNative, asset, network, to, amount_coin: amountCoin } })
    });

    return response({ ok: true, txid, tx_url: txUrl, fee_native: feeNative, fee_native_unit: feeUnit, fee_usd: round2(feeUsd), usd_value: round2(usdValue) });
  } catch (e) {
    console.error("chain-send error", e);
    return response({ error: "On-chain send failed: " + String(e?.message ?? e) }, 500);
  }
});

function round2(n: number) { return Math.round(n * 100) / 100; }

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { ethers } from "npm:ethers@6.13.5";
import { mnemonicToSeedSync, validateMnemonic } from "npm:@scure/bip39@1.5.4";
import { wordlist } from "npm:@scure/bip39@1.5.4/wordlists/english";
import { HDKey } from "npm:@scure/bip32@1.4.0";
import { derivePath as deriveEd25519Path } from "npm:ed25519-hd-key@1.3.0";
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
} from "npm:@solana/web3.js@1.95.3";
import * as bitcoin from "npm:bitcoinjs-lib@6.1.7";
import * as ecc from "npm:tiny-secp256k1@2.2.3";
import { ECPairFactory } from "npm:ecpair@2.1.0";
import { Buffer } from "node:buffer";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MNEMONIC = (Deno.env.get("WALLET_MNEMONIC") ?? "").trim().split(/\s+/).filter(Boolean).join(" ");
const ECPair = ECPairFactory(ecc);
bitcoin.initEccLib(ecc);

const TRON_USDT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const USDT_ADDR: Record<string, string> = {
  ERC20: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
  BEP20: "0x55d398326f99059fF775485246999027B3197955",
};
const EVM_RPC: Record<string, string> = {
  ERC20: "https://ethereum-rpc.publicnode.com",
  ETHEREUM: "https://ethereum-rpc.publicnode.com",
  BEP20: "https://bsc-rpc.publicnode.com",
};
const SOLANA_RPC = "https://solana-rpc.publicnode.com";
const DOGE_BLOCKBOOK = "https://blockbook.doge.zelcore.io";
const DOGECHAIN_API = "https://dogechain.com/api/v3";
const BTC_API = "https://mempool.space/api";

const COINGECKO_IDS: Record<string, string> = {
  BTC: "bitcoin", ETH: "ethereum", SOL: "solana", TRX: "tron", DOGE: "dogecoin",
};
const KRAKEN_PAIRS: Record<string, string> = {
  BTC: "XBTUSD", ETH: "ETHUSD", SOL: "SOLUSD", TRX: "TRXUSD", DOGE: "XDGUSD",
};
const DOGE_NETWORK = {
  messagePrefix: "\x19Dogecoin Signed Message:\n",
  bech32: "doge",
  bip32: { public: 0x02facafd, private: 0x02fac398 },
  pubKeyHash: 0x1e,
  scriptHash: 0x16,
  wif: 0x9e,
};
const BTC_NETWORK = bitcoin.networks.bitcoin;

function response(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}
function round2(n: number) { return Math.round(n * 100) / 100; }
function round6(n: number) { return Math.round(n * 1e6) / 1e6; }
function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, x => x.toString(16).padStart(2, "0")).join("");
}
function base58Decode(value: string): Uint8Array {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = 0n;
  for (const ch of value) {
    const digit = alphabet.indexOf(ch);
    if (digit < 0) throw new Error("Invalid base58 address");
    n = n * 58n + BigInt(digit);
  }
  let body: number[] = [];
  while (n > 0n) { body.unshift(Number(n & 255n)); n >>= 8n; }
  let zeros = 0;
  while (zeros < value.length && value[zeros] === "1") zeros++;
  body = [...new Array(zeros).fill(0), ...body];
  return new Uint8Array(body);
}
function tronAddressHex(address: string): string {
  const decoded = base58Decode(address);
  if (decoded.length !== 25) throw new Error("Invalid TRON address length");
  const payload = decoded.slice(0, 21);
  const first = ethers.getBytes(ethers.sha256(payload));
  const checksum = ethers.getBytes(ethers.sha256(first)).slice(0, 4);
  for (let i = 0; i < 4; i++) if (decoded[21 + i] !== checksum[i]) throw new Error("Invalid TRON address checksum");
  if (payload[0] !== 0x41) throw new Error("Invalid TRON address prefix");
  return bytesToHex(payload.slice(1));
}
async function fetchJson(url: string, init?: RequestInit): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const r = await fetch(url, { ...init, signal: controller.signal });
    const raw = await r.text();
    let data: any = {};
    try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw }; }
    if (!r.ok) throw new Error(String(data?.error?.message || data?.error || data?.message || raw || ("HTTP " + r.status)));
    return data;
  } finally { clearTimeout(timer); }
}
async function fetchText(url: string, init?: RequestInit): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const r = await fetch(url, { ...init, signal: controller.signal });
    const raw = await r.text();
    if (!r.ok) throw new Error(raw || ("HTTP " + r.status));
    return raw.trim();
  } finally { clearTimeout(timer); }
}
async function usdPrice(asset: string): Promise<number> {
  const a = asset.toUpperCase();
  if (a === "USDT") return 1;
  const id = COINGECKO_IDS[a];
  if (!id) throw new Error("No USD price source is configured for " + a);
  try {
    const data = await fetchJson("https://api.coingecko.com/api/v3/simple/price?ids=" + encodeURIComponent(id) + "&vs_currencies=usd");
    const price = Number(data?.[id]?.usd ?? 0);
    if (Number.isFinite(price) && price > 0) return price;
  } catch { /* try independent public price sources */ }
  try {
    const data = await fetchJson("https://api.coinbase.com/v2/exchange-rates?currency=" + encodeURIComponent(a));
    const price = Number(data?.data?.rates?.USD ?? 0);
    if (Number.isFinite(price) && price > 0) return price;
  } catch { /* continue to Kraken */ }
  try {
    const pair = KRAKEN_PAIRS[a];
    const data = await fetchJson("https://api.kraken.com/0/public/Ticker?pair=" + encodeURIComponent(pair));
    const price = Number(Object.values(data?.result || {})[0]?.c?.[0] ?? 0);
    if (!data?.error?.length && Number.isFinite(price) && price > 0) return price;
  } catch { /* report below */ }
  throw new Error("A reliable live USD price for " + a + " is unavailable. No transfer was sent.");
}
function unitsFromUsd(amountUsd: number, price: number, decimals: number): bigint {
  const coin = amountUsd / price;
  if (!Number.isFinite(coin) || coin <= 0) throw new Error("Could not calculate the coin amount");
  const fixed = coin.toFixed(decimals);
  const units = ethers.parseUnits(fixed, decimals);
  if (units <= 0n) throw new Error("The USD amount is too small to send on this network");
  return units;
}
function deriveSecpWallet(path: string) {
  return ethers.HDNodeWallet.fromPhrase(MNEMONIC, undefined, path);
}
function deriveBip32Node(path: string) {
  const seed = mnemonicToSeedSync(MNEMONIC);
  const root = HDKey.fromMasterSeed(seed);
  const node = root.derive(path);
  if (!node.privateKey) throw new Error("Could not derive the deposit wallet private key");
  return node;
}
function deriveSolanaWallet(path: string) {
  const seed = mnemonicToSeedSync(MNEMONIC);
  const derived = deriveEd25519Path(path, bytesToHex(seed));
  return Keypair.fromSeed(new Uint8Array(derived.key));
}

type TronState = { trx: number; freeNet: number; freeUsed: number; energyFee: number; txFeeSun: number };
async function tronState(address: string): Promise<TronState> {
  const [acc, res, params] = await Promise.all([
    fetchJson("https://api.trongrid.io/wallet/getaccount", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address, visible: true }),
    }),
    fetchJson("https://api.trongrid.io/wallet/getaccountresource", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address, visible: true }),
    }),
    fetchJson("https://api.trongrid.io/wallet/getchainparameters"),
  ]);
  const list = params?.chainParameter ?? [];
  return {
    trx: Number(acc?.balance ?? 0) / 1e6,
    freeNet: Number(res?.freeNetLimit ?? 600),
    freeUsed: Number(res?.freeNetUsed ?? 0),
    energyFee: Number(list.find((x: any) => x.key === "getEnergyFee")?.value ?? 420),
    txFeeSun: Number(list.find((x: any) => x.key === "getTransactionFee")?.value ?? 1000),
  };
}
async function tronUsdtBalance(address: string): Promise<bigint> {
  const parameter = tronAddressHex(address).padStart(64, "0");
  const d = await fetchJson("https://api.trongrid.io/wallet/triggerconstantcontract", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      owner_address: address, contract_address: TRON_USDT,
      function_selector: "balanceOf(address)", parameter, visible: true,
    }),
  });
  const hex = String(d?.constant_result?.[0] ?? "0");
  return BigInt("0x" + (hex || "0"));
}
function signTronRawTransaction(rawDataHex: string, privateKey: string): string {
  const digest = ethers.sha256(ethers.getBytes("0x" + rawDataHex));
  const key = new ethers.SigningKey("0x" + privateKey.replace(/^0x/, ""));
  const sig = key.sign(digest);
  const v = sig.yParity === 0 ? "00" : "01";
  return sig.r.slice(2).padStart(64, "0") + sig.s.slice(2).padStart(64, "0") + v;
}
async function tronBroadcast(transaction: any, privateKey: string, beforeBroadcast: BeforeBroadcast, feeNative: number): Promise<string> {
  const raw = String(transaction?.raw_data_hex ?? "");
  if (!raw) throw new Error("TRON did not return a transaction to sign");
  const txid = String(transaction?.txID ?? "");
  if (!/^[0-9a-fA-F]{64}$/.test(txid)) throw new Error("TRON transaction ID is invalid before broadcast");
  const sigHex = signTronRawTransaction(raw, privateKey);
  await beforeBroadcast(feeNative, "TRX");
  const d = await fetchJson("https://api.trongrid.io/wallet/broadcasttransaction", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...transaction, signature: [sigHex], visible: true }),
  });
  if (d?.result !== true) throw new Error("TRON rejected the signed transaction: " + String(d?.message ?? "unknown error"));
  return txid;
}
function tronFeeFromState(state: TronState, rawDataHex: string, energy: number): number {
  const bytes = Math.ceil(rawDataHex.length / 2) + 67;
  const freeBandwidth = Math.max(0, state.freeNet - state.freeUsed);
  const paidBandwidth = Math.max(0, bytes - freeBandwidth);
  const feeSun = energy * state.energyFee + paidBandwidth * state.txFeeSun;
  return Math.round(feeSun) / 1e6;
}

type BroadcastResult = {
  txid: string; txUrl: string; feeNative: number; feeUnit: string; cryptoAmount: string; feeNote: string;
};
type BeforeBroadcast = (feeNative: number, feeUnit: string, amountUsdSent?: number) => Promise<void>;
type FeeOptions = { feeMode: "native" | "coin"; amountUsd: number; assetPrice: number; feeAssetPrice: number };
async function sendEvm(
  row: any, asset: string, network: string, to: string, amountUnits: bigint, decimals: number,
  beforeBroadcast: BeforeBroadcast, feeOptions: FeeOptions,
): Promise<BroadcastResult> {
  const provider = new ethers.JsonRpcProvider(EVM_RPC[network]);
  const chain = await provider.getNetwork();
  const expectedChainId = network === "BEP20" ? 56n : 1n;
  if (chain.chainId !== expectedChainId) throw new Error("The RPC endpoint is connected to the wrong blockchain network. Transfer blocked for safety.");
  const wallet = deriveSecpWallet(row.derivation_path);
  if (wallet.address.toLowerCase() !== String(row.address).toLowerCase()) throw new Error("Derived EVM address does not match the saved deposit address. Transfer blocked for safety.");
  if (!/^0x[a-fA-F0-9]{40}$/.test(to)) throw new Error("The destination address is not a valid EVM address");
  const fd = await provider.getFeeData();
  const gasPrice = [fd.gasPrice, fd.maxFeePerGas].find(x => x != null && x > 0n);
  if (!gasPrice) throw new Error("The network did not return a usable gas price");
  const feeFields: Record<string, bigint> = fd.maxFeePerGas && fd.maxPriorityFeePerGas && fd.maxFeePerGas > 0n
    ? { maxFeePerGas: fd.maxFeePerGas, maxPriorityFeePerGas: fd.maxPriorityFeePerGas }
    : { gasPrice: fd.gasPrice ?? gasPrice };
  const signer = new ethers.Wallet(wallet.privateKey, provider);
  const isNative = asset === "ETH" && network === "ETHEREUM";
  let tx: any;
  let gasUnits: bigint;
  let feeNative = 0;
  let amountUnitsToSend = amountUnits;
  let amountUsdToSend = round6(feeOptions.amountUsd);
  if (isNative) {
    const estimate = await provider.estimateGas({ from: row.address, to, value: amountUnits });
    gasUnits = (estimate * 115n + 99n) / 100n;
    const balance = await provider.getBalance(row.address);
    const needed = amountUnits + gasUnits * gasPrice;
    if (balance < needed) throw new Error("The Ethereum deposit wallet needs " + ethers.formatEther(needed) + " ETH (transfer plus estimated gas), but has " + ethers.formatEther(balance) + " ETH.");
    feeNative = Number(gasUnits * gasPrice) / 1e18;
    await beforeBroadcast(feeNative, "ETH", amountUsdToSend);
    tx = await signer.sendTransaction({ to, value: amountUnits, gasLimit: gasUnits, ...feeFields });
  } else {
    const tokenAddress = USDT_ADDR[network];
    if (asset !== "USDT" || !tokenAddress) throw new Error("Unsupported EVM asset and network combination");
    const tokenDecimals = network === "BEP20" ? 18 : 6;
    if (decimals !== tokenDecimals) throw new Error("Token decimal configuration mismatch");
    const contract = new ethers.Contract(tokenAddress, [
      "function transfer(address to, uint256 amount) returns (bool)",
      "function balanceOf(address a) view returns (uint256)"
    ], signer);
    const tokenBalance: bigint = await contract.balanceOf(row.address);
    if (feeOptions.feeMode === "coin" && tokenBalance > 0n && tokenBalance < amountUnits) amountUnitsToSend = tokenBalance;

    let settled = feeOptions.feeMode !== "coin";
    for (let pass = 0; feeOptions.feeMode === "coin" && pass < 6; pass++) {
      const estimate = await contract.transfer.estimateGas(to, amountUnitsToSend);
      gasUnits = (estimate * 115n + 99n) / 100n;
      feeNative = Number(gasUnits * gasPrice) / 1e18;
      const feeUsd = round6(feeNative * feeOptions.feeAssetPrice);
      if (!Number.isFinite(feeUsd) || feeUsd <= 0 || feeUsd >= feeOptions.amountUsd) throw new Error("The live EVM network fee is not valid for deduction from the USDT transfer. No transfer was sent.");
      const nextUsd = round6(feeOptions.amountUsd - feeUsd);
      const nextUnits = unitsFromUsd(nextUsd, feeOptions.assetPrice, tokenDecimals);
      amountUsdToSend = nextUsd;
      if (nextUnits === amountUnitsToSend) { settled = true; break; }
      amountUnitsToSend = nextUnits;
    }
    if (!settled) throw new Error("The live EVM fee calculation did not stabilise. No transfer was sent.");
    const finalEstimate = await contract.transfer.estimateGas(to, amountUnitsToSend);
    gasUnits = (finalEstimate * 115n + 99n) / 100n;
    feeNative = Number(gasUnits * gasPrice) / 1e18;
    if (feeOptions.feeMode === "coin") {
      const finalFeeUsd = round6(feeNative * feeOptions.feeAssetPrice);
      const settledUsd = round6(feeOptions.amountUsd - finalFeeUsd);
      if (unitsFromUsd(settledUsd, feeOptions.assetPrice, tokenDecimals) !== amountUnitsToSend) throw new Error("The live EVM network fee changed during the final estimate. Refresh the quote and retry.");
      amountUsdToSend = settledUsd;
    }
    if (tokenBalance < amountUnitsToSend) throw new Error("The source wallet does not hold enough USDT for the final transfer amount.");
    const nativeBalance = await provider.getBalance(row.address);
    const neededGas = gasUnits * gasPrice;
    if (nativeBalance < neededGas) throw new Error("The sending wallet needs approximately " + ethers.formatEther(neededGas) + (network === "BEP20" ? " BNB" : " ETH") + " for gas, but its native gas balance is " + ethers.formatEther(nativeBalance) + ". Fund the wallet's gas balance first.");
    await beforeBroadcast(feeNative, network === "BEP20" ? "BNB" : "ETH", amountUsdToSend);
    tx = await contract.transfer(to, amountUnitsToSend, { gasLimit: gasUnits, ...feeFields });
  }
  const feeUnit = network === "BEP20" ? "BNB" : "ETH";
  const txid = String(tx.hash ?? "");
  if (!/^0x[0-9a-fA-F]{64}$/.test(txid)) throw new Error("EVM node did not return a valid transaction hash");
  return {
    txid, txUrl: (network === "BEP20" ? "https://bscscan.com/tx/" : "https://etherscan.io/tx/") + txid,
    feeNative, feeUnit, cryptoAmount: ethers.formatUnits(amountUnitsToSend, decimals),
    feeNote: feeOptions.feeMode === "coin" ? "USDT transfer reduced by live fee equivalent; native gas is still paid on-chain" : "live EVM gas; actual fee may be lower",
  };
}

async function sendTron(
  row: any, asset: string, to: string, amountUnits: bigint, decimals: number,
  beforeBroadcast: BeforeBroadcast, feeOptions: FeeOptions,
): Promise<BroadcastResult> {
  const wallet = deriveSecpWallet(row.derivation_path);
  const privateKey = wallet.privateKey.slice(2);
  const publicKey = wallet.signingKey.publicKey.slice(2);
  const digest = ethers.keccak256("0x" + publicKey);
  const tronPayload = "41" + digest.slice(-40);
  const expected = (() => {
    const payload = ethers.getBytes("0x" + tronPayload);
    const first = ethers.getBytes(ethers.sha256(payload));
    const sum = ethers.getBytes(ethers.sha256(first)).slice(0, 4);
    const combined = new Uint8Array(payload.length + 4);
    combined.set(payload); combined.set(sum, payload.length);
    const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let n = BigInt("0x" + bytesToHex(combined)), out = "";
    while (n > 0n) { const rem = Number(n % 58n); out = alphabet[rem] + out; n /= 58n; }
    for (const x of combined) { if (x === 0) out = "1" + out; else break; }
    return out;
  })();
  if (expected !== String(row.address)) throw new Error("Derived TRON address does not match the saved deposit address. Transfer blocked for safety.");
  tronAddressHex(to);
  const state = await tronState(row.address);
  let transaction: any, energy = 0, feeNative = 0;
  let amountUnitsToSend = amountUnits, amountUsdToSend = round6(feeOptions.amountUsd);
  if (asset === "TRX") {
    if (decimals !== 6) throw new Error("TRX decimal configuration mismatch");
    const amountSun = Number(amountUnits);
    if (!Number.isSafeInteger(amountSun)) throw new Error("TRX amount is outside the safe transfer range");
    const d = await fetchJson("https://api.trongrid.io/wallet/createtransaction", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ owner_address: row.address, to_address: to, amount: amountSun, visible: true }),
    });
    if (!d?.raw_data_hex || !d?.txID) throw new Error("TRON could not build the native TRX transfer");
    transaction = d;
  } else if (asset === "USDT") {
    if (decimals !== 6 || to.length !== 34) throw new Error("TRC20 token configuration or destination is invalid");
    const tokenBalance = await tronUsdtBalance(row.address);
    const build = async (units: bigint) => {
      const parameter = tronAddressHex(to).padStart(64, "0") + units.toString(16).padStart(64, "0");
      const d = await fetchJson("https://api.trongrid.io/wallet/triggersmartcontract", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner_address: row.address, contract_address: TRON_USDT, function_selector: "transfer(address,uint256)", parameter, fee_limit: 400000000, visible: true }),
      });
      if (d?.result?.result !== true || !d?.transaction?.raw_data_hex) throw new Error("TRON rejected the USDT transfer build: " + String(d?.result?.message ?? "unknown error"));
      return { transaction: d.transaction, energy: Number(d?.energy_used ?? 0) };
    };
    if (feeOptions.feeMode === "coin" && tokenBalance > 0n && tokenBalance < amountUnitsToSend) amountUnitsToSend = tokenBalance;
    let built = await build(amountUnitsToSend);
    transaction = built.transaction; energy = built.energy;
    let settled = feeOptions.feeMode !== "coin";
    for (let pass = 0; feeOptions.feeMode === "coin" && pass < 6; pass++) {
      feeNative = tronFeeFromState(state, String(transaction.raw_data_hex), energy);
      const feeUsd = round6(feeNative * feeOptions.feeAssetPrice);
      if (!Number.isFinite(feeUsd) || feeUsd <= 0 || feeUsd >= feeOptions.amountUsd) throw new Error("The live TRON network fee is not valid for deduction from the USDT transfer. No transfer was sent.");
      const nextUsd = round6(feeOptions.amountUsd - feeUsd);
      const nextUnits = unitsFromUsd(nextUsd, feeOptions.assetPrice, decimals);
      amountUsdToSend = nextUsd;
      if (nextUnits === amountUnitsToSend) { settled = true; break; }
      amountUnitsToSend = nextUnits;
      built = await build(amountUnitsToSend);
      transaction = built.transaction; energy = built.energy;
    }
    if (!settled) throw new Error("The live TRON fee calculation did not stabilise. No transfer was sent.");
    feeNative = tronFeeFromState(state, String(transaction.raw_data_hex), energy);
    if (feeOptions.feeMode === "coin") {
      const finalFeeUsd = round6(feeNative * feeOptions.feeAssetPrice);
      const settledUsd = round6(feeOptions.amountUsd - finalFeeUsd);
      if (unitsFromUsd(settledUsd, feeOptions.assetPrice, decimals) !== amountUnitsToSend) throw new Error("The live TRON network fee changed during the final estimate. Refresh the quote and retry.");
      amountUsdToSend = settledUsd;
    }
    if (tokenBalance < amountUnitsToSend) throw new Error("The source TRON wallet does not have enough USDT for the final transfer amount.");
  } else {
    throw new Error("Unsupported TRON asset and network combination");
  }
  feeNative = tronFeeFromState(state, String(transaction.raw_data_hex), energy);
  const nativeRequired = (asset === "TRX" ? Number(amountUnits) / 1e6 : 0) + feeNative;
  if (state.trx + 0.0000001 < nativeRequired) throw new Error("The sending wallet needs approximately " + nativeRequired.toFixed(6) + " TRX for the transfer and network fee, but has " + state.trx.toFixed(6) + " TRX.");
  const txid = await tronBroadcast(transaction, privateKey, async (fee, unit) => beforeBroadcast(fee, unit, amountUsdToSend), feeNative);
  return {
    txid, txUrl: "https://tronscan.org/#/transaction/" + txid, feeNative, feeUnit: "TRX",
    cryptoAmount: ethers.formatUnits(amountUnitsToSend, decimals),
    feeNote: feeOptions.feeMode === "coin" ? "USDT transfer reduced by live fee equivalent; TRX gas is still paid on-chain" : "live TRON energy and bandwidth fee",
  };
}

async function sendSolana(row: any, to: string, amountUnits: bigint, beforeBroadcast: BeforeBroadcast): Promise<BroadcastResult> {
  const keypair = deriveSolanaWallet(row.derivation_path);
  const from = keypair.publicKey;
  if (from.toBase58() !== String(row.address)) {
    throw new Error("Derived Solana address does not match the saved deposit address. Transfer blocked for safety.");
  }
  let destination: PublicKey;
  try { destination = new PublicKey(to); } catch { throw new Error("The destination is not a valid Solana address"); }
  if (!PublicKey.isOnCurve(destination.toBytes())) {
    throw new Error("The destination must be a normal on-curve Solana wallet address for a native SOL transfer");
  }
  const connection = new Connection(SOLANA_RPC, "confirmed");
  const destinationInfo = await connection.getAccountInfo(destination, "confirmed");
  if (destinationInfo && !destinationInfo.owner.equals(SystemProgram.programId)) {
    throw new Error("This Solana address is owned by a program account and cannot receive this native SOL transfer");
  }
  const lamports = Number(amountUnits);
  if (!Number.isSafeInteger(lamports) || lamports <= 0) throw new Error("SOL amount is outside the safe transfer range");
  const latest = await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction({
    feePayer: from,
    recentBlockhash: latest.blockhash,
  }).add(SystemProgram.transfer({ fromPubkey: from, toPubkey: destination, lamports }));
  const estimatedFee = await connection.getFeeForMessage(tx.compileMessage(), "confirmed");
  if (estimatedFee === null || !Number.isSafeInteger(estimatedFee)) throw new Error("Solana did not return a reliable transaction fee");
  const balance = await connection.getBalance(from, "confirmed");
  if (balance < lamports + estimatedFee) {
    throw new Error("The Solana deposit wallet needs " + ((lamports + estimatedFee) / 1e9).toFixed(9) +
      " SOL (transfer plus fee), but has " + (balance / 1e9).toFixed(9) + " SOL.");
  }
  tx.sign(keypair);
  await beforeBroadcast(estimatedFee / 1e9, "SOL");
  const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
  return {
    txid: signature,
    txUrl: "https://solscan.io/tx/" + signature,
    feeNative: estimatedFee / 1e9,
    feeUnit: "SOL",
    cryptoAmount: ethers.formatUnits(amountUnits, 9),
    feeNote: "Solana transaction fee",
  };
}

type UtxoRow = { txid: string; vout: number; value: number; height?: number; status?: { confirmed?: boolean } };
async function sendUtxo(row: any, asset: "BTC" | "DOGE", to: string, amountUnits: bigint, beforeBroadcast: BeforeBroadcast): Promise<BroadcastResult> {
  const doge = asset === "DOGE";
  const network = doge ? DOGE_NETWORK : BTC_NETWORK;
  const keyNode = deriveBip32Node(row.derivation_path);
  const keypair = ECPair.fromPrivateKey(Buffer.from(bytesToHex(keyNode.privateKey!), "hex"), { network });
  const payment = doge
    ? bitcoin.payments.p2pkh({ pubkey: keypair.publicKey, network })
    : bitcoin.payments.p2wpkh({ pubkey: keypair.publicKey, network });
  if (!payment.address || payment.address.toLowerCase() !== String(row.address).toLowerCase()) {
    throw new Error("Derived " + asset + " address does not match the saved deposit address. Transfer blocked for safety.");
  }
  try { bitcoin.address.toOutputScript(to, network); }
  catch { throw new Error("The destination is not a valid " + asset + " mainnet address"); }

  let utxos: UtxoRow[] = [];
  let feeRate: number;
  if (!doge) {
    const [rawUtxos, fees] = await Promise.all([
      fetchJson(BTC_API + "/address/" + encodeURIComponent(row.address) + "/utxo"),
      fetchJson(BTC_API + "/v1/fees/recommended"),
    ]);
    utxos = (Array.isArray(rawUtxos) ? rawUtxos : [])
      .filter((u: any) => u?.status?.confirmed === true)
      .map((u: any) => ({ txid: String(u.txid), vout: Number(u.vout), value: Number(u.value) }))
      .filter(u => /^[0-9a-fA-F]{64}$/.test(u.txid) && Number.isSafeInteger(u.vout) && Number.isSafeInteger(u.value) && u.value > 0);
    feeRate = Number(fees?.halfHourFee ?? fees?.fastestFee ?? 0);
  } else {
    const [rawUtxos, fees] = await Promise.all([
      fetchJson(DOGE_BLOCKBOOK + "/api/v2/utxo/" + encodeURIComponent(row.address)),
      fetchJson(DOGECHAIN_API + "/fees"),
    ]);
    const rows = Array.isArray(rawUtxos) ? rawUtxos : (rawUtxos?.utxos || rawUtxos?.data || []);
    utxos = rows
      .filter((u: any) => Number(u?.height ?? u?.confirmations ?? 0) > 0)
      .map((u: any) => ({ txid: String(u.txid), vout: Number(u.vout), value: Number(u.value), height: Number(u.height ?? 0) }))
      .filter(u => /^[0-9a-fA-F]{64}$/.test(u.txid) && Number.isSafeInteger(u.vout) && Number.isSafeInteger(u.value) && u.value > 0);
    feeRate = Number(fees?.data?.fee_rate_koinu_per_byte?.median ?? fees?.data?.fee_rate_koinu_per_byte?.min ?? 0);
  }
  if (!Number.isFinite(feeRate) || feeRate <= 0) throw new Error("The " + asset + " network fee service did not return a usable rate");
  if (!utxos.length) throw new Error("The sending " + asset + " wallet has no confirmed spendable outputs");

  // Keep input count small, but only use confirmed UTXOs from this exact deposit wallet.
  utxos.sort((a, b) => b.value - a.value);
  const amount = Number(amountUnits);
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error("The " + asset + " amount is outside the safe transfer range");
  const inputVbytes = doge ? 148 : 68;
  const outputVbytes = doge ? 34 : 31;
  const dust = doge ? 100000000 : 330; // 1 DOGE P2PKH / 330 sat P2WPKH
  const selected: UtxoRow[] = [];
  let total = 0;
  let fee = 0;
  let change = 0;
  let found = false;
  for (const utxo of utxos) {
    selected.push(utxo);
    total += utxo.value;
    const vbytesWithChange = 10 + inputVbytes * selected.length + outputVbytes * 2;
    fee = Math.ceil(vbytesWithChange * feeRate);
    if (total >= amount + fee) {
      change = total - amount - fee;
      if (change === 0 || change >= dust) { found = true; break; }
    }
  }
  if (!found) {
    const noChangeFee = total - amount;
    if (total < amount + fee) {
      throw new Error("The " + asset + " wallet does not have enough confirmed funds for the withdrawal and network fee");
    }
    throw new Error("The remaining " + asset + " change would be below the network dust limit. Adjust the withdrawal amount slightly and retry.");
  }

  const psbt = new bitcoin.Psbt({ network });
  const inputScript = payment.output!;
  if (doge) {
    const previousTransactions = await Promise.all(selected.map(async u => {
      const detail = await fetchJson(DOGE_BLOCKBOOK + "/api/v2/tx/" + u.txid);
      let hex = String(detail?.hex ?? "");
      if (!hex) {
        const rawText = await fetchText(DOGE_BLOCKBOOK + "/api/rawtx/" + u.txid);
        try { const parsed = JSON.parse(rawText); hex = String(parsed?.hex ?? parsed?.rawtx ?? ""); }
        catch { hex = rawText; }
      }
      if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length < 20) throw new Error("Could not safely retrieve a Dogecoin previous transaction");
      return Buffer.from(hex, "hex");
    }));
    selected.forEach((u, i) => psbt.addInput({
      hash: u.txid, index: u.vout, nonWitnessUtxo: previousTransactions[i],
    }));
  } else {
    selected.forEach(u => psbt.addInput({
      hash: u.txid, index: u.vout, witnessUtxo: { script: inputScript, value: u.value },
    }));
  }
  psbt.addOutput({ address: to, value: amount });
  if (change > 0) psbt.addOutput({ address: row.address, value: change });
  for (let i = 0; i < selected.length; i++) psbt.signInput(i, keypair);
  psbt.finalizeAllInputs();
  const tx = psbt.extractTransaction();
  const rawHex = tx.toHex();
  const txid = tx.getId();
  let broadcastId = "";
  const estimatedFeeNative = fee / 1e8;
  await beforeBroadcast(estimatedFeeNative, asset);
  if (!doge) {
    broadcastId = await fetchText(BTC_API + "/tx", {
      method: "POST", headers: { "Content-Type": "text/plain" }, body: rawHex,
    });
  } else {
    const d = await fetchJson(DOGE_BLOCKBOOK + "/api/v2/sendtx/", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hex: rawHex }),
    });
    broadcastId = String(d?.result ?? d?.txid ?? "");
  }
  if (!/^[0-9a-fA-F]{64}$/.test(broadcastId) || broadcastId.toLowerCase() !== txid.toLowerCase()) {
    throw new Error("The " + asset + " broadcast endpoint did not confirm the expected transaction ID. Check the wallet before retrying. Expected " + txid + "; response " + broadcastId);
  }
  const actualFee = total - amount - change;
  return {
    txid,
    txUrl: doge ? "https://dogechain.com/tx/" + txid : "https://mempool.space/tx/" + txid,
    feeNative: actualFee / 1e8,
    feeUnit: asset,
    cryptoAmount: ethers.formatUnits(amountUnits, 8),
    feeNote: doge ? "Dogecoin fee from selected UTXOs and live Dogechain fee rate" : "Bitcoin fee from selected UTXOs and live mempool fee rate",
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return response({ ok: true });
  if (req.method !== "POST") return response({ error: "Method not allowed" }, 405);
  let reservationId = "";
  let broadcastAttempted = false;
  let broadcastTxid = "";
  try {
    if (!SUPABASE_URL || !SERVICE_KEY) return response({ error: "Service is not configured" }, 503);
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader.startsWith("Bearer ")) return response({ error: "Authentication required" }, 401);
    const userRes = await fetch(SUPABASE_URL + "/auth/v1/user", {
      headers: { apikey: SERVICE_KEY, Authorization: authHeader },
    });
    if (!userRes.ok) return response({ error: "Invalid session" }, 401);
    const user = await userRes.json();
    if (!user?.id) return response({ error: "Invalid session" }, 401);
    const profRes = await fetch(
      SUPABASE_URL + "/rest/v1/profiles?id=eq." + encodeURIComponent(user.id) + "&select=role&limit=1",
      { headers: { apikey: SERVICE_KEY, Authorization: "Bearer " + SERVICE_KEY } },
    );
    const profRows = profRes.ok ? await profRes.json() : [];
    if (!profRows.length || profRows[0].role !== "admin") return response({ error: "Administrator access required" }, 403);

    const b = await req.json().catch(() => ({}));
    const depositId = String(b?.deposit_address_id ?? "");
    const userId = String(b?.user_id ?? "");
    const asset = String(b?.asset ?? "").toUpperCase();
    const network = String(b?.network ?? "").toUpperCase();
    const to = String(b?.to_address ?? "").normalize("NFKC").replace(/[\u200B-\u200D\uFEFF]/g, "").trim().replace(/^0X/i, "0x");
    const amountUsd = Number(b?.amount_usd ?? b?.amount_coin ?? 0);
    const requestedFeeMode = String(b?.fee_mode ?? "native").toLowerCase();
    const isDualFee = asset === "USDT" && ["TRC20","ERC20","BEP20"].includes(network);
    if (requestedFeeMode === "coin" && !isDualFee) return response({ error: "USDT fee deduction is only available for USDT TRC20, ERC20 and BEP20 withdrawals." }, 400);
    const feeMode: "native" | "coin" = isDualFee && requestedFeeMode === "coin" ? "coin" : "native";
    const note = String(b?.note ?? "").trim();
    if (!depositId || !userId || !to || !Number.isFinite(amountUsd) || amountUsd <= 0) {
      return response({ error: "Missing or invalid withdrawal details" }, 400);
    }
    if (!MNEMONIC || !validateMnemonic(MNEMONIC, wordlist)) {
      return response({ error: "The treasury wallet master seed is missing or invalid. No transfer was sent." }, 503);
    }

    const rowRes = await fetch(
      SUPABASE_URL + "/rest/v1/user_deposit_addresses?id=eq." + encodeURIComponent(depositId) +
        "&select=id,user_id,address,asset_network_id,asset_code,network_code,derivation_path&limit=1",
      { headers: { apikey: SERVICE_KEY, Authorization: "Bearer " + SERVICE_KEY } },
    );
    const rows = rowRes.ok ? await rowRes.json() : [];
    const row = rows[0];
    if (!row) return response({ error: "Deposit wallet not found" }, 404);
    if (String(row.user_id) !== userId) return response({ error: "The selected deposit wallet does not belong to this member." }, 403);
    if (String(row.asset_code).toUpperCase() !== asset || String(row.network_code).toUpperCase() !== network) {
      return response({ error: "The selected deposit wallet does not match the chosen asset and network." }, 400);
    }
    if (!String(row.derivation_path ?? "").startsWith("m/")) return response({ error: "This deposit wallet has no valid derivation path recorded." }, 400);
    const configRes = await fetch(
      SUPABASE_URL + "/rest/v1/crypto_asset_networks?id=eq." + encodeURIComponent(String(row.asset_network_id)) +
        "&select=asset_code,network_code,is_enabled,decimals&limit=1",
      { headers: { apikey: SERVICE_KEY, Authorization: "Bearer " + SERVICE_KEY } },
    );
    const configs = configRes.ok ? await configRes.json() : [];
    const config = configs[0];
    if (!config || config.is_enabled !== true ||
      String(config.asset_code).toUpperCase() !== asset ||
      String(config.network_code).toUpperCase() !== network) {
      return response({ error: "This asset and network are not currently enabled for deposits and treasury transfers." }, 400);
    }

    const decimals = Number(config.decimals);
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) return response({ error: "Invalid asset decimal configuration" }, 500);
    const price = await usdPrice(asset);
    const amountUnits = unitsFromUsd(amountUsd, price, decimals);
    const amountCoin = Number(ethers.formatUnits(amountUnits, decimals));
    if (!Number.isFinite(amountCoin) || amountCoin <= 0) return response({ error: "The calculated coin amount is invalid" }, 400);

    // Resolve the fee asset price before broadcasting. Never let a post-broadcast
    // price API failure make a successful on-chain send look like an unsent request.
    const feeAsset = network === "BEP20" ? "BNB"
      : (network === "TRC20" || network === "TRON") ? "TRX"
      : (network === "ERC20" || network === "ETHEREUM") ? "ETH"
      : asset;
    const feeAssetPrice = feeAsset === asset ? price : await usdPrice(feeAsset);

    let sent: BroadcastResult;
    let actualAmountUsd = round6(amountUsd);
    // Reserve only the actual amount sent, plus network gas when it is paid
    // in the same asset as the withdrawn coin.
    const markBroadcastAttempt = async (feeNative: number, feeUnit: string, amountUsdSent = amountUsd) => {
      if (!Number.isFinite(feeNative) || feeNative < 0 || feeUnit.toUpperCase() !== feeAsset ||
          !Number.isFinite(amountUsdSent) || amountUsdSent <= 0 || amountUsdSent > amountUsd + 0.000001) {
        throw new Error("The live fee or actual transfer amount is invalid. No transfer was sent.");
      }
      const sameAssetFeeUsd = feeAsset === asset ? round6(feeNative * feeAssetPrice) : 0;
      actualAmountUsd = round6(amountUsdSent);
      const claimResponse = await fetch(SUPABASE_URL + "/rest/v1/rpc/admin_treasury_claim_onchain_withdrawal", {
        method: "POST",
        headers: { apikey: SERVICE_KEY, Authorization: authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({
          p_user_id: userId,
          p_asset: asset,
          p_network: network,
          p_amount: round6(actualAmountUsd + sameAssetFeeUsd),
          p_deposit_address_id: depositId,
        }),
      });
      const claimBody = await claimResponse.text();
      let claimValue: any = null;
      try { claimValue = claimBody ? JSON.parse(claimBody) : null; } catch { claimValue = null; }
      if (!claimResponse.ok || typeof claimValue !== "string") {
        throw new Error(String(claimValue?.message || claimValue?.hint || claimBody || "Could not reserve the member's verified on-chain balance including network fees"));
      }
      reservationId = claimValue;
      if (!/^[0-9a-fA-F-]{36}$/.test(reservationId)) {
        reservationId = "";
        throw new Error("The treasury could not create a valid withdrawal reservation. No transfer was sent.");
      }

      const markResponse = await fetch(SUPABASE_URL + "/rest/v1/rpc/admin_treasury_mark_onchain_broadcast_attempt", {
        method: "POST",
        headers: { apikey: SERVICE_KEY, Authorization: authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({ p_reservation_id: reservationId }),
      });
      if (!markResponse.ok) {
        const detail = await markResponse.text().catch(() => "");
        throw new Error("Could not safely lock the treasury reservation before broadcasting. No transfer was sent. " + detail);
      }
      broadcastAttempted = true;
    };
    if (network === "TRC20" && asset === "USDT") {
      sent = await sendTron(row, asset, to, amountUnits, decimals, markBroadcastAttempt, { feeMode, amountUsd, assetPrice: price, feeAssetPrice });
    } else if (network === "TRON" && asset === "TRX") {
      sent = await sendTron(row, asset, to, amountUnits, decimals, markBroadcastAttempt, { feeMode, amountUsd, assetPrice: price, feeAssetPrice });
    } else if (network === "ERC20" && asset === "USDT") {
      sent = await sendEvm(row, asset, network, to, amountUnits, decimals, markBroadcastAttempt, { feeMode, amountUsd, assetPrice: price, feeAssetPrice });
    } else if (network === "BEP20" && asset === "USDT") {
      sent = await sendEvm(row, asset, network, to, amountUnits, decimals, markBroadcastAttempt, { feeMode, amountUsd, assetPrice: price, feeAssetPrice });
    } else if (network === "ETHEREUM" && asset === "ETH") {
      sent = await sendEvm(row, asset, network, to, amountUnits, decimals, markBroadcastAttempt, { feeMode, amountUsd, assetPrice: price, feeAssetPrice });
    } else if (network === "BITCOIN" && asset === "BTC") {
      sent = await sendUtxo(row, asset, to, amountUnits, markBroadcastAttempt);
    } else if (network === "DOGECOIN" && asset === "DOGE") {
      sent = await sendUtxo(row, asset, to, amountUnits, markBroadcastAttempt);
    } else if (network === "SOLANA" && asset === "SOL") {
      sent = await sendSolana(row, to, amountUnits, markBroadcastAttempt);
    } else {
      throw new Error("This asset and network combination does not have an automatic broadcast implementation.");
    }
    broadcastTxid = sent.txid;

    const feeUsd = sent.feeNative * feeAssetPrice;
    const recordNote = [
      note,
      "requested USD " + round6(amountUsd) + "; fee mode " + feeMode,
      "on-chain broadcast",
      sent.feeNote,
    ].filter(Boolean).join(" · ");
    const recordResponse = await fetch(SUPABASE_URL + "/rest/v1/rpc/admin_treasury_record_onchain_withdrawal", {
      method: "POST",
      headers: {
        apikey: SERVICE_KEY, Authorization: authHeader, "Content-Type": "application/json",
      },
      body: JSON.stringify({
        p_user_id: userId,
        p_asset: asset,
        p_network: network,
        p_amount: round6(actualAmountUsd),
        p_crypto_amount: sent.cryptoAmount,
        p_gas_fee: feeAsset === asset ? round6(feeUsd) : 0,
        p_network_fee_native: sent.feeNative,
        p_network_fee_asset: sent.feeUnit,
        p_destination: to,
        p_note: recordNote,
        p_tx_hash: sent.txid,
        p_reservation_id: reservationId,
        p_requested_amount_usd: round6(amountUsd),
        p_fee_mode: feeMode,
      }),
    });
    const recordedId = recordResponse.ok ? await recordResponse.json().catch(() => null) : null;
    if (!recordResponse.ok) {
      const detail = await recordResponse.text().catch(() => "");
      console.error("Treasury accounting failed after on-chain broadcast", {
        txid: sent.txid, network, asset, status: recordResponse.status, detail,
      });
      return response({
        error: "The blockchain transaction was broadcast, but the treasury record could not be saved. Do not retry the transfer. Transaction: " + sent.txid,
        broadcast: true, txid: sent.txid, tx_url: sent.txUrl, accounting_pending: true, reservation_id: reservationId,
      }, 502);
    }
    return response({
      ok: true,
      txid: sent.txid,
      tx_url: sent.txUrl,
      treasury_withdrawal_id: recordedId,
      asset, network,
      amount_usd: round6(actualAmountUsd),
      crypto_amount: sent.cryptoAmount,
      fee_native: sent.feeNative,
      fee_native_unit: sent.feeUnit,
      fee_usd: round6(feeUsd),
      amount_usd_sent: actualAmountUsd,
      requested_amount_usd: round6(amountUsd),
      fee_mode: feeMode,
    });
  } catch (e) {
    const errorMessage = String((e as any)?.message ?? e);
    if (reservationId && !broadcastAttempted) {
      try {
        await fetch(SUPABASE_URL + "/rest/v1/rpc/admin_treasury_release_onchain_withdrawal", {
          method: "POST",
          headers: { apikey: SERVICE_KEY, Authorization: req.headers.get("Authorization") ?? "", "Content-Type": "application/json" },
          body: JSON.stringify({ p_reservation_id: reservationId }),
        });
      } catch (releaseError) {
        console.error("Could not release unused treasury reservation", reservationId, releaseError);
      }
    }
    console.error("chain-send error", e);
    if (broadcastAttempted && !broadcastTxid) {
      return response({
        error: "A broadcast was attempted but no final transaction ID was returned. Do not retry yet; check the wallet and chain explorer first. " + errorMessage,
        broadcast_status_uncertain: true,
        reservation_id: reservationId || null,
      }, 502);
    }
    return response({ error: "On-chain send failed: " + errorMessage, reservation_id: reservationId || null }, 500);
  }
});

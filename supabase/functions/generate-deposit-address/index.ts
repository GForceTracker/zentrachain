import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { HDNodeWallet, keccak256 } from "npm:ethers@6.13.5";
import { mnemonicToSeedSync, validateMnemonic } from "npm:@scure/bip39@1.5.4";
import { wordlist } from "npm:@scure/bip39@1.5.4/wordlists/english";
import { HDKey } from "npm:@scure/bip32@1.4.0";
import { derivePath as deriveEd25519Path } from "npm:ed25519-hd-key@1.3.0";
import { Keypair } from "npm:@solana/web3.js@1.95.3";
import { sha256 } from "npm:@noble/hashes@1.5.0/sha256";
import { ripemd160 } from "npm:@noble/hashes@1.5.0/ripemd160";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MNEMONIC = (Deno.env.get("WALLET_MNEMONIC") ?? "").trim().split(/\s+/).filter(Boolean).join(" ");

const ASSETS: Record<string, { asset: string; network: string; path: (i: number) => string; kind: string }> = {
  "usdt-trc20": { asset: "USDT", network: "TRC20", path: i => `m/44'/195'/0'/0/${i}`, kind: "tron" },
  "usdt-erc20": { asset: "USDT", network: "ERC20", path: i => `m/44'/60'/0'/0/${i}`, kind: "evm" },
  "usdt-bep20": { asset: "USDT", network: "BEP20", path: i => `m/44'/60'/0'/0/${i}`, kind: "evm" },
  "btc-bitcoin": { asset: "BTC", network: "BITCOIN", path: i => `m/84'/0'/0'/0/${i}`, kind: "btc" },
  "trx-tron": { asset: "TRX", network: "TRON", path: i => `m/44'/195'/0'/0/${i}`, kind: "tron" },
  "doge-dogecoin": { asset: "DOGE", network: "DOGECOIN", path: i => `m/44'/3'/0'/0/${i}`, kind: "doge" },
  "sol-solana": { asset: "SOL", network: "SOLANA", path: i => `m/44'/501'/${i}'/0'`, kind: "sol" },
  "eth-ethereum": { asset: "ETH", network: "ETHEREUM", path: i => `m/44'/60'/0'/0/${i}`, kind: "evm" }
};

function bytesToHex(bytes: Uint8Array) { return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join(""); }
function concat(...parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((n,p)=>n+p.length,0)); let off=0;
  for (const p of parts) { out.set(p,off); off += p.length; } return out;
}
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(bytes: Uint8Array) {
  let n = BigInt("0x" + bytesToHex(bytes)); let out = "";
  while (n > 0n) { const r = Number(n % 58n); out = ALPHABET[r] + out; n /= 58n; }
  for (const b of bytes) { if (b === 0) out = "1" + out; else break; }
  return out;
}
function base58Check(payload: Uint8Array) {
  const first = sha256(payload); const checksum = sha256(first).slice(0,4);
  return base58(concat(payload,checksum));
}
const BECH32 = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
function polymod(values: number[]) {
  const gen = [0x3b6a57b2,0x26508e6d,0x1ea119fa,0x3d4233dd,0x2a1462b3]; let chk=1;
  for (const v of values) { const top=chk>>>25; chk=((chk&0x1ffffff)<<5)^v; for(let i=0;i<5;i++) if((top>>>i)&1) chk^=gen[i]; }
  return chk >>> 0;
}
function hrpExpand(hrp: string) {
  return [...Array.from(hrp,c=>c.charCodeAt(0)>>>5),0,...Array.from(hrp,c=>c.charCodeAt(0)&31)];
}
function convertBits(data: number[], from: number, to: number, pad: boolean) {
  let acc=0,bits=0; const ret:number[]=[]; const maxv=(1<<to)-1;
  for(const value of data) { if(value<0 || (value>>>from)!==0) throw new Error("Invalid bit group"); acc=(acc<<from)|value; bits+=from; while(bits>=to){bits-=to;ret.push((acc>>>bits)&maxv);} }
  if(pad) { if(bits) ret.push((acc<<(to-bits))&maxv); }
  else if(bits>=from || ((acc<<(to-bits))&maxv)!==0) throw new Error("Invalid padding");
  return ret;
}
function segwitAddress(program: Uint8Array) {
  const hrp="bc"; const data=[0,...convertBits(Array.from(program),8,5,true)];
  const values=[...hrpExpand(hrp),...data,0,0,0,0,0,0];
  const mod=polymod(values)^1; const sum=Array.from({length:6},(_,i)=>(mod>>>(5*(5-i)))&31);
  return hrp+"1"+[...data,...sum].map(v=>BECH32[v]).join("");
}
function deriveAddress(mnemonic: string, path: string, kind: string) {
  if (kind === "evm" || kind === "tron") {
    const w = HDNodeWallet.fromPhrase(mnemonic, undefined, path);
    if (kind === "evm") return w.address;
    const pub = w.signingKey.publicKey.slice(2);
    const digest = keccak256("0x" + pub);
    const payload = concat(new Uint8Array([0x41]), new Uint8Array(digest.slice(-40).match(/../g)!.map(x=>parseInt(x,16))));
    return base58Check(payload);
  }
  const seed = mnemonicToSeedSync(mnemonic);
  if (kind === "sol") {
    const derived = deriveEd25519Path(path, bytesToHex(seed));
    return Keypair.fromSeed(new Uint8Array(derived.key)).publicKey.toBase58();
  }
  const root = HDKey.fromMasterSeed(seed);
  const node = root.derive(path);
  if (!node.publicKey) throw new Error("Could not derive public key");
  const h160 = ripemd160(sha256(node.publicKey));
  if (kind === "btc") return segwitAddress(h160);
  return base58Check(concat(new Uint8Array([0x1e]),h160));
}
function response(data: unknown, status=200) {
  return new Response(JSON.stringify(data),{status,headers:{"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, apikey, content-type, x-client-info","Access-Control-Allow-Methods":"POST, OPTIONS","Content-Type":"application/json","Cache-Control":"no-store"}});
}
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok",{headers:{"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, apikey, content-type, x-client-info, x-supabase-api-version","Access-Control-Allow-Methods":"POST, OPTIONS","Access-Control-Max-Age":"86400","Vary":"Origin"}});
  if (req.method !== "POST") return response({error:"Method not allowed"},405);
  try {
    if (!SUPABASE_URL || !SERVICE_KEY) return response({error:"Wallet service is not configured"},503);
    const authHeader=req.headers.get("Authorization") ?? "";
    if (!authHeader.startsWith("Bearer ")) return response({error:"Authentication required"},401);
    const userRes=await fetch(`${SUPABASE_URL}/auth/v1/user`,{headers:{apikey:SERVICE_KEY,Authorization:authHeader}});
    if (!userRes.ok) return response({error:"Invalid session"},401);
    const user=await userRes.json();
    if (!user?.id) return response({error:"Invalid session"},401);
    const body=await req.json();
    const amountUsd=Number(body.amount_usd);
    if (!Number.isFinite(amountUsd) || amountUsd <= 0) return response({error:"Enter a valid USD deposit amount"},400);
    const settingRes=await fetch(`${SUPABASE_URL}/rest/v1/site_settings?setting_key=eq.minimum_deposit_usd&select=numeric_value&limit=1`,{headers:{apikey:SERVICE_KEY,Authorization:`Bearer ${SERVICE_KEY}`}});
    if (!settingRes.ok) return response({error:"Minimum deposit setting is unavailable. Please try again later."},503);
    const settingRows=await settingRes.json();
    const minimumUsd=Number(settingRows?.[0]?.numeric_value ?? 10);
    if (!Number.isFinite(minimumUsd) || amountUsd < minimumUsd) return response({error:`Minimum deposit is ${minimumUsd.toFixed(2)} USD`},400);
    const assetNetworkId=String(body.asset_network_id ?? "");
    const config=ASSETS[assetNetworkId];
    if (!config) return response({error:"Unsupported asset/network"},400);
    const enabledRes=await fetch(`${SUPABASE_URL}/rest/v1/crypto_asset_networks?id=eq.${assetNetworkId}&select=is_enabled&limit=1`,{headers:{apikey:SERVICE_KEY,Authorization:`Bearer ${SERVICE_KEY}`}});
    const enabledRows=enabledRes.ok?await enabledRes.json():[];
    if (!enabledRows.length || enabledRows[0].is_enabled !== true) return response({error:"This deposit network is not enabled yet"},403);
    if (!MNEMONIC) return response({error:"Wallet master seed is missing. Add the WALLET_MNEMONIC secret in Supabase Edge Function secrets."},503);
    if (!validateMnemonic(MNEMONIC,wordlist)) return response({error:"WALLET_MNEMONIC is present but is not a valid English BIP-39 recovery phrase. Check the word spelling and word order in Supabase secrets."},503);

    const headers={apikey:SERVICE_KEY,Authorization:`Bearer ${SERVICE_KEY}`,"Content-Type":"application/json"};
    const existingRes=await fetch(`${SUPABASE_URL}/rest/v1/user_deposit_addresses?user_id=eq.${user.id}&asset_network_id=eq.${assetNetworkId}&select=id,address,derivation_path,asset_code,network_code&limit=1`,{headers});
    if (!existingRes.ok) throw new Error("Could not check existing wallet address");
    const existing=await existingRes.json();
    if (existing.length) return response({address:existing[0].address,asset:existing[0].asset_code,network:existing[0].network_code,created:false});

    const reserveRes=await fetch(`${SUPABASE_URL}/rest/v1/rpc/reserve_wallet_derivation_index`,{
      method:"POST",headers,body:JSON.stringify({p_asset_network_id:assetNetworkId})
    });
    if (!reserveRes.ok) throw new Error("Could not reserve wallet derivation index");
    const index=Number(await reserveRes.json());
    if (!Number.isSafeInteger(index) || index<0) throw new Error("Invalid derivation index");
    const path=config.path(index);
    const address=deriveAddress(MNEMONIC,path,config.kind);

    const insertRes=await fetch(`${SUPABASE_URL}/rest/v1/user_deposit_addresses`,{
      method:"POST",headers:{...headers,Prefer:"return=representation"},
      body:JSON.stringify({user_id:user.id,asset_network_id:assetNetworkId,asset_code:config.asset,network_code:config.network,address,derivation_index:index,derivation_path:path})
    });
    if (!insertRes.ok) {
      const check=await fetch(`${SUPABASE_URL}/rest/v1/user_deposit_addresses?user_id=eq.${user.id}&asset_network_id=eq.${assetNetworkId}&select=address,asset_code,network_code&limit=1`,{headers});
      const rows=check.ok?await check.json():[];
      if(rows.length) return response({address:rows[0].address,asset:rows[0].asset_code,network:rows[0].network_code,created:false});
      throw new Error("Address could not be saved");
    }
    return response({address,asset:config.asset,network:config.network,created:true});
  } catch (e) {
    console.error("wallet address request failed",e);
    return response({error:"Unable to create a deposit address. Please try again later."},500);
  }
});
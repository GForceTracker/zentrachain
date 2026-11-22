import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { HDNodeWallet } from "npm:ethers@6.13.5";
import { mnemonicToSeedSync, validateMnemonic } from "npm:@scure/bip39@1.5.4";
import { wordlist } from "npm:@scure/bip39@1.5.4/wordlists/english";
import { HDKey } from "npm:@scure/bip32@1.4.0";
import { derivePath as deriveEd25519Path } from "npm:ed25519-hd-key@1.3.0";
import { Keypair } from "npm:@solana/web3.js@1.95.3";
import { sha256 } from "npm:@noble/hashes@1.5.0/sha256";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MNEMONIC = (Deno.env.get("WALLET_MNEMONIC") ?? "").trim().split(/\s+/).filter(Boolean).join(" ");

function bytesToHex(bytes: Uint8Array) { return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join(""); }
function concat(...parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; } return out;
}
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(bytes: Uint8Array) {
  let n = BigInt("0x" + bytesToHex(bytes)); let out = "";
  while (n > 0n) { const r = Number(n % 58n); out = ALPHABET[r] + out; n /= 58n; }
  for (const b of bytes) { if (b === 0) out = "1" + out; else break; }
  return out;
}
function wifEncode(priv: Uint8Array, compressed: boolean): string {
  const body = compressed ? concat(new Uint8Array([0x80]), priv, new Uint8Array([0x01])) : concat(new Uint8Array([0x80]), priv);
  const h1 = sha256(body); const h2 = sha256(h1);
  return base58(concat(body, h2.slice(0, 4)));
}
function kindOf(asset: string, network: string): string {
  const n = String(network || "").toUpperCase();
  if (n === "BITCOIN") return "btc";
  if (n === "DOGECOIN") return "doge";
  if (n === "SOLANA") return "sol";
  if (n === "TRC20" || n === "TRON") return "tron";
  return "evm";
}

function response(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info", "Access-Control-Allow-Methods": "POST, OPTIONS", "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Max-Age": "86400", "Vary": "Origin" } });
  if (req.method !== "POST") return response({ error: "Method not allowed" }, 405);
  try {
    if (!SUPABASE_URL || !SERVICE_KEY) return response({ error: "Key service is not configured" }, 503);
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader.startsWith("Bearer ")) return response({ error: "Authentication required" }, 401);
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SERVICE_KEY, Authorization: authHeader } });
    if (!userRes.ok) return response({ error: "Invalid session" }, 401);
    const user = await userRes.json();
    if (!user?.id) return response({ error: "Invalid session" }, 401);
    const profRes = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${user.id}&select=role&limit=1`, { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } });
    const profRows = profRes.ok ? await profRes.json() : [];
    if (!profRows.length || profRows[0].role !== "admin") return response({ error: "Administrator access required" }, 403);
    if (!MNEMONIC) return response({ error: "WALLET_MNEMONIC secret is missing on this project" }, 503);
    if (!validateMnemonic(MNEMONIC, wordlist)) return response({ error: "WALLET_MNEMONIC is not a valid BIP-39 phrase" }, 503);
    const body = await req.json();
    const depositId = String(body.deposit_address_id ?? "");
    if (!/^[0-9a-f-]{36}$/i.test(depositId)) return response({ error: "Invalid deposit address id" }, 400);
    const rowRes = await fetch(`${SUPABASE_URL}/rest/v1/user_deposit_addresses?id=eq.${depositId}&select=id,user_id,address,asset_code,network_code,derivation_path&limit=1`, { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } });
    const rows = rowRes.ok ? await rowRes.json() : [];
    if (!rows.length) return response({ error: "Deposit address not found" }, 404);
    const row = rows[0];
    const path = String(row.derivation_path ?? "");
    if (!path.startsWith("m/")) return response({ error: "This deposit wallet has no derivation path recorded" }, 400);
    const kind = kindOf(row.asset_code, row.network_code);
    const out: Record<string, unknown> = { address: row.address, asset_code: row.asset_code, network_code: row.network_code, derivation_path: path, kind };
    if (kind === "evm" || kind === "tron") {
      const w = HDNodeWallet.fromPhrase(MNEMONIC, undefined, path);
      out.private_key = w.signingKey.privateKey.slice(2);
      if (kind === "evm" && w.address.toLowerCase() !== String(row.address).toLowerCase()) {
        out.warning = "Derived address does not match the stored address. Verify before use.";
      }
    } else if (kind === "sol") {
      const seed = mnemonicToSeedSync(MNEMONIC);
      const derived = deriveEd25519Path(path, bytesToHex(seed));
      const key32 = new Uint8Array(derived.key);
      const pub = Keypair.fromSeed(key32).publicKey.toBytes();
      out.solana = base58(concat(key32, pub));
      out.private_key = bytesToHex(key32);
    } else {
      const seed = mnemonicToSeedSync(MNEMONIC);
      const root = HDKey.fromMasterSeed(seed);
      const node = root.derive(path);
      if (!node.privateKey) throw new Error("Could not derive private key");
      const priv = new Uint8Array(node.privateKey);
      out.private_key = bytesToHex(priv);
      out.wif = wifEncode(priv, true);
    }
    await fetch(`${SUPABASE_URL}/rest/v1/audit_logs`, {
      method: "POST",
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ actor_id: user.id, action: "deposit_key_revealed", entity_type: "user_deposit_addresses", entity_id: depositId, details: { address: row.address, asset: row.asset_code, network: row.network_code } })
    });
    return response(out);
  } catch (e) {
    console.error("key reveal failed", e);
    return response({ error: "Could not derive the key. Please try again." }, 500);
  }
});

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function response(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info", "Access-Control-Allow-Methods": "POST, OPTIONS", "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d), b => b.toString(16).padStart(2, "0")).join("");
}

const hits = new Map<string, { count: number; reset: number }>();
function ipLimited(ip: string): boolean {
  const now = Date.now();
  const rec = hits.get(ip) ?? { count: 0, reset: now + 60000 };
  if (now > rec.reset) { hits.set(ip, { count: 1, reset: now + 60000 }); return false; }
  rec.count++;
  hits.set(ip, rec);
  return rec.count > 6;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return response({ ok: true });
  if (req.method !== "POST") return response({ error: "Method not allowed" }, 405);
  try {
    const ip = req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for") ?? "local";
    if (ipLimited(ip)) return response({ error: "Too many attempts. Try again shortly." }, 429);
    const body = await req.json().catch(() => ({}));
    const email = String(body?.email ?? "").trim().toLowerCase();
    const password = String(body?.password ?? "");
    const fullName = String(body?.full_name ?? "").trim().slice(0, 80);
    const challengeId = String(body?.challenge_id ?? "");
    const nonce = String(body?.nonce ?? "");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return response({ error: "Enter a valid email address." }, 400);
    if (password.length < 6) return response({ error: "Password must be at least 6 characters." }, 400);

    // fetch + validate the challenge (single use, 10 minute expiry)
    const chRes = await fetch(SUPABASE_URL + "/rest/v1/captcha_challenges?id=eq." + challengeId + "&select=id,salt,difficulty,used,created_at", { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } });
    const chRows = chRes.ok ? await chRes.json() : [];
    const ch = chRows[0];
    if (!ch) return response({ error: "Captcha expired - tick the box again." }, 400);
    if (ch.used) return response({ error: "Captcha already used - tick the box again." }, 400);
    if (Date.now() - new Date(ch.created_at).getTime() > 600000) return response({ error: "Captcha expired - tick the box again." }, 400);
    const hex = await sha256Hex(ch.salt + nonce);
    if (!hex.startsWith("0".repeat(Number(ch.difficulty)))) return response({ error: "Captcha verification failed - tick the box again." }, 400);
    // consume the challenge (single use)
    await fetch(SUPABASE_URL + "/rest/v1/captcha_challenges?id=eq." + challengeId, { method: "DELETE", headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, Prefer: "return=minimal" } });

    // create the account (auto-confirmed)
    const create = await fetch(SUPABASE_URL + "/auth/v1/admin/users", {
      method: "POST",
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { full_name: fullName } })
    });
    const created = await create.json().catch(() => ({}));
    if (!create.ok) {
      const msg = created?.msg ?? created?.message ?? "Signup failed.";
      const friendly = /already/i.test(msg) ? "An account with this email already exists. Log in instead." : msg;
      return response({ error: friendly }, 400);
    }
    return response({ ok: true });
  } catch (e) {
    console.error("member-signup error", e);
    return response({ error: "Signup failed. Please try again." }, 500);
  }
});

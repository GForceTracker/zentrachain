import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function response(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info", "Access-Control-Allow-Methods": "POST, OPTIONS", "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

const hits = new Map<string, { count: number; reset: number }>();
function ipLimited(ip: string): boolean {
  const now = Date.now();
  const rec = hits.get(ip) ?? { count: 0, reset: now + 60000 };
  if (now > rec.reset) { hits.set(ip, { count: 1, reset: now + 60000 }); return false; }
  rec.count++;
  hits.set(ip, rec);
  if (hits.size > 5000) for (const [k, v] of hits) if (now > v.reset) hits.delete(k);
  return rec.count > 12;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return response({ ok: true });
  if (req.method !== "POST") return response({ error: "Method not allowed" }, 405);
  try {
    const ip = req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for") ?? "local";
    if (ipLimited(ip)) return response({ error: "Too many attempts. Try again shortly." }, 429);
    await fetch(SUPABASE_URL + "/rest/v1/captcha_challenges?created_at=lt." + new Date(Date.now() - 600000).toISOString(), {
      method: "DELETE",
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, Prefer: "return=minimal" }
    });
    const salt = crypto.getRandomValues(new Uint8Array(8)).reduce((s, b) => s + b.toString(16).padStart(2, "0"), "");
    const difficulty = 3;
    const ins = await fetch(SUPABASE_URL + "/rest/v1/captcha_challenges", {
      method: "POST",
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json", Prefer: "return=representation" },
      body: JSON.stringify({ salt, difficulty })
    });
    const rows = ins.ok ? await ins.json() : [];
    if (!rows.length) throw new Error("Challenge could not be created");
    return response({ id: rows[0].id, salt, difficulty });
  } catch (e) {
    console.error("captcha-challenge error", e);
    return response({ error: "Challenge failed. Try again." }, 500);
  }
});

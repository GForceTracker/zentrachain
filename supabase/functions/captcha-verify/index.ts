import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function response(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info", "Access-Control-Allow-Methods": "POST, OPTIONS", "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return response({ ok: true });
  if (req.method !== "POST") return response({ error: "Method not allowed" }, 405);
  try {
    const body = await req.json().catch(() => ({}));
    const id = String(body?.id ?? "");
    const answer = String(body?.answer ?? "").trim().toUpperCase();
    if (!id || !answer) return response({ error: "Type the code first." }, 400);
    const chRes = await fetch(SUPABASE_URL + "/rest/v1/captcha_challenges?id=eq." + id + "&select=id,code,verified,created_at", { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } });
    const rows = chRes.ok ? await chRes.json() : [];
    const ch = rows[0];
    if (!ch) return response({ error: "Captcha expired - get a new code." }, 400);
    if (Date.now() - new Date(ch.created_at).getTime() > 600000) return response({ error: "Captcha expired - get a new code." }, 400);
    if (ch.code.toUpperCase() !== answer) {
      await fetch(SUPABASE_URL + "/rest/v1/captcha_challenges?id=eq." + id, { method: "DELETE", headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, Prefer: "return=minimal" } });
      return response({ error: "Wrong code - tick the box for a new one." }, 400);
    }
    const upd = await fetch(SUPABASE_URL + "/rest/v1/captcha_challenges?id=eq." + id, {
      method: "PATCH",
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ verified: true })
    });
    if (!upd.ok) return response({ error: "Verification failed - try again." }, 500);
    return response({ ok: true });
  } catch (e) {
    console.error("captcha-verify error", e);
    return response({ error: "Verification failed. Try again." }, 500);
  }
});

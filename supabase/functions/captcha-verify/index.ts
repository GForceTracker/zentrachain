import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function response(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    }
  });
}
const hits = new Map<string, { count: number; reset: number }>();
function ipLimited(ip: string): boolean {
  const now = Date.now();
  const rec = hits.get(ip) ?? { count: 0, reset: now + 60000 };
  if (now > rec.reset) { hits.set(ip, { count: 1, reset: now + 60000 }); return false; }
  rec.count++;
  hits.set(ip, rec);
  return rec.count > 18;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return response({ ok: true });
  if (req.method !== "POST") return response({ error: "Method not allowed" }, 405);
  try {
    const ip = (req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for") ?? "local").split(",")[0].trim();
    if (ipLimited(ip)) return response({ error: "Too many verification attempts. Try again shortly." }, 429);

    const body = await req.json().catch(() => ({}));
    const id = String(body?.id ?? "");
    const answer = String(body?.answer ?? "").trim().toUpperCase();
    if (!/^[0-9a-f-]{36}$/i.test(id)) return response({ error: "Please load a new challenge." }, 400);
    if (!/^[A-HJ-NP-Z2-9]{6}$/.test(answer)) return response({ error: "Enter all six characters shown in the image." }, 400);

    const query = new URL(SUPABASE_URL + "/rest/v1/captcha_challenges");
    query.searchParams.set("id", "eq." + id);
    query.searchParams.set("select", "id,code,verified,used,created_at");
    const check = await fetch(query.toString(), {
      headers: { apikey: SERVICE_KEY, Authorization: "Bearer " + SERVICE_KEY }
    });
    const rows = check.ok ? await check.json() : [];
    const challenge = rows[0];
    if (!challenge || challenge.used || challenge.verified) return response({ error: "This challenge has expired. Load a new one." }, 400);
    if (Date.now() - new Date(challenge.created_at).getTime() > 600000) {
      await fetch(query.toString().replace(/\?.*$/, "?id=eq." + id), {
        method: "DELETE",
        headers: { apikey: SERVICE_KEY, Authorization: "Bearer " + SERVICE_KEY, Prefer: "return=minimal" }
      });
      return response({ error: "This challenge has expired. Load a new one." }, 400);
    }
    if (String(challenge.code ?? "").toUpperCase() !== answer) {
      const remove = new URL(SUPABASE_URL + "/rest/v1/captcha_challenges");
      remove.searchParams.set("id", "eq." + id);
      await fetch(remove.toString(), {
        method: "DELETE",
        headers: { apikey: SERVICE_KEY, Authorization: "Bearer " + SERVICE_KEY, Prefer: "return=minimal" }
      });
      return response({ error: "That code did not match. A new challenge is ready." }, 400);
    }

    const update = new URL(SUPABASE_URL + "/rest/v1/captcha_challenges");
    update.searchParams.set("id", "eq." + id);
    update.searchParams.set("used", "eq.false");
    update.searchParams.set("verified", "eq.false");
    const result = await fetch(update.toString(), {
      method: "PATCH",
      headers: {
        apikey: SERVICE_KEY,
        Authorization: "Bearer " + SERVICE_KEY,
        "Content-Type": "application/json",
        Prefer: "return=representation"
      },
      body: JSON.stringify({ verified: true })
    });
    const updated = result.ok ? await result.json() : [];
    if (!updated.length) return response({ error: "The challenge is no longer valid. Load a new one." }, 409);
    return response({ ok: true });
  } catch (error) {
    console.error("captcha-verify error", error);
    return response({ error: "Verification failed. Please try again." }, 500);
  }
});

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

function makeSvg(code: string): string {
  const chars = code.split("");
  let glyphs = "";
  let x = 14;
  for (const c of chars) {
    const rot = (Math.random() * 44 - 22).toFixed(1);
    const dy = (Math.random() * 14 - 7).toFixed(1);
    const size = (26 + Math.random() * 8).toFixed(0);
    const fill = ["#0a8a4d", "#1b6e5a", "#20575e", "#7a4a12"][Math.floor(Math.random() * 4)];
    glyphs += '<text x="' + x + '" y="' + (30 + Number(dy)) + '" font-family="Georgia,serif" font-size="' + size + '" font-weight="700" fill="' + fill + '" transform="rotate(' + rot + ' ' + x + ' ' + (30 + Number(dy)) + ')">' + c + '</text>';
    x += 30;
  }
  let noise = "";
  for (let i = 0; i < 3; i++) {
    const y1 = (Math.random() * 40 + 4).toFixed(0), y2 = (Math.random() * 40 + 4).toFixed(0);
    noise += '<line x1="0" y1="' + y1 + '" x2="150" y2="' + y2 + '" stroke="#94a89f" stroke-width="1"/>';
  }
  for (let i = 0; i < 8; i++) {
    noise += '<circle cx="' + (Math.random() * 150).toFixed(0) + '" cy="' + (Math.random() * 46 + 2).toFixed(0) + '" r="1.4" fill="#94a89f"/>';
  }
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 150 48" width="150" height="48" style="background:#ffffff;border-radius:8px">' + noise + glyphs + '</svg>';
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
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code = "";
    for (let i = 0; i < 4; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
    const ins = await fetch(SUPABASE_URL + "/rest/v1/captcha_challenges", {
      method: "POST",
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json", Prefer: "return=representation" },
      body: JSON.stringify({ code })
    });
    const rows = ins.ok ? await ins.json() : [];
    if (!rows.length) throw new Error("Challenge could not be created");
    return response({ id: rows[0].id, svg: makeSvg(code) });
  } catch (e) {
    console.error("captcha-challenge error", e);
    return response({ error: "Challenge failed. Try again." }, 500);
  }
});

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
const corsFor = (origin: string | null) => {
  const ok = origin === "https://g-force-auto-trading-bot.vercel.app" ||
    (!!origin && /^https:\/\/g-force-auto-trading-[a-z0-9-]+\.vercel\.app$/.test(origin));
  return { "Access-Control-Allow-Origin": ok && origin ? origin : "https://g-force-auto-trading-bot.vercel.app",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Vary": "Origin" };
};
const reply = (body: unknown, status = 200, origin: string | null = null) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsFor(origin), "Content-Type": "application/json" } });
const countryName = (raw: string | null) => {
  const code = (raw || "").trim().toUpperCase().slice(0, 2);
  if (!/^[A-Z]{2}$/.test(code) || code === "XX" || code === "T1") return "Unknown";
  try { return new Intl.DisplayNames(["en"], { type: "region" }).of(code) || "Unknown"; } catch { return "Unknown"; }
};
const clean = (s: string | null, max: number) => (s || "").replace(/[<>]/g, "").trim().slice(0, max);
Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsFor(origin) });
  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  if (req.method === "POST") {
    try {
      const body = await req.json();
      if (!["page_view", "telegram_click"].includes(body.event_type)) return reply({ error: "Invalid event" }, 400, origin);
      const ua = (req.headers.get("user-agent") || "").toLowerCase();
      const device = /ipad|tablet/.test(ua) ? "tablet" : /iphone|ipod|android/.test(ua) ? (/android/.test(ua) ? "android" : "iphone") : "desktop";
      const country = countryName(req.headers.get("x-visitor-country") || req.headers.get("cf-ipcountry") || req.headers.get("x-vercel-ip-country"));
      const city = clean(req.headers.get("x-visitor-city"), 100) || null;
      const region = clean(req.headers.get("x-visitor-region"), 100) || null;
      const referrer = typeof body.referrer === "string" ? body.referrer.slice(0, 300) : "";
      const source = typeof body.source === "string" ? body.source.slice(0, 80) : "direct";
      const resp = await fetch(url + "/rest/v1/site_events", { method: "POST",
        headers: { apikey: serviceKey, Authorization: "Bearer " + serviceKey, "Content-Type": "application/json", Prefer: "return=minimal" },
        body: JSON.stringify({ event_type: body.event_type, country, city, region, device, referrer, source }) });
      if (!resp.ok) return reply({ error: "Could not record event" }, 500, origin);
      return reply({ ok: true }, 200, origin);
    } catch { return reply({ error: "Invalid request" }, 400, origin); }
  }
  if (req.method === "GET") {
    const authHeader = req.headers.get("authorization") || "";
    const token = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : "";
    if (!token) return reply({ error: "Unauthorized" }, 401, origin);
    const auth = await fetch(url + "/auth/v1/user", { headers: { apikey: serviceKey, Authorization: "Bearer " + token } });
    if (!auth.ok) return reply({ error: "Unauthorized" }, 401, origin);
    const user = await auth.json();
    if ((user.email || "").toLowerCase() !== "inemesitobot428@gmail.com") return reply({ error: "Forbidden" }, 403, origin);
    const range = new URL(req.url).searchParams.get("range") || "7d";
    const days = range === "30d" ? 30 : range === "today" ? 1 : 7;
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const query = new URLSearchParams({ select: "event_type,country,city,region,device,source,created_at", created_at: "gte." + since, order: "created_at.desc", limit: "10000" });
    const result = await fetch(url + "/rest/v1/site_events?" + query, { headers: { apikey: serviceKey, Authorization: "Bearer " + serviceKey } });
    if (!result.ok) return reply({ error: "Analytics query failed" }, 500, origin);
    const rows = await result.json();
    const views = rows.filter((x: any) => x.event_type === "page_view").length;
    const clicks = rows.filter((x: any) => x.event_type === "telegram_click").length;
    const count = (key: string) => Object.entries(rows.reduce((a: any, x: any) => { const k = x[key] || "Unknown"; a[k] = (a[k] || 0) + 1; return a; }, {}))
      .map(([name, value]) => ({ name, value })).sort((a: any,b: any) => b.value-a.value);
    const locationCounts = Object.entries(rows.reduce((a: any, x: any) => {
      const place = [x.city, x.region, x.country].filter(Boolean).join(", ") || "Unknown location";
      a[place] = (a[place] || 0) + 1; return a;
    }, {})).map(([name, value]) => ({ name, value })).sort((a: any,b: any) => b.value-a.value);
    const countries = count("country");
    const daily = Object.entries(rows.reduce((a: any, x: any) => { const d = x.created_at.slice(0,10); a[d] ||= { date:d, views:0, clicks:0 }; a[d][x.event_type === "page_view" ? "views" : "clicks"]++; return a; }, {}))
      .map(([,v])=>v).sort((a:any,b:any)=>a.date.localeCompare(b.date));
    return reply({ views, clicks, ctr: views ? +(clicks / views * 100).toFixed(1) : 0, countries, locations: locationCounts, devices: count("device"), sources: count("source"), daily, range }, 200, origin);
  }
  return reply({ error: "Method not allowed" }, 405, origin);
});
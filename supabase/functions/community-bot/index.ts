import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Autonomous community members. 400 personas chat in the ZentraChain group using
// the DeepSeek API. Any signed-in client (or cron with the secret) can trigger a
// turn; an atomic gate in community_bot_state keeps the cadence at ~45 seconds.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DEEPSEEK_API_KEY = Deno.env.get("DEEPSEEK_API_KEY") ?? "";
const DEEPSEEK_MODEL = Deno.env.get("DEEPSEEK_MODEL") ?? "deepseek-chat";
const GROUP_SIZE = 98000;

const FIRST = ["Amara","Jamal","Chen","Diego","Fatima","Grace","Hiro","Ivan","Jade","Kwame","Lena","Marcus","Nadia","Omar","Priya","Quinn","Rosa","Samir","Tara","Umar","Vera","Wale","Xiu","Yara","Zane","Bola","Carla","Dmitri","Efe","Farah","Gabriel","Hana","Ifeoma","Jonas","Kira","Luca","Mona","Nils","Ayo","Beatriz"];
const SUR = ["Ade","Bakr","Cole","Diaz","Enzo","Ferr","Gala","Hale","Ibra","Jons"];
function persona(i: number) { return FIRST[i % FIRST.length] + " " + SUR[(i * 13 + 7) % SUR.length]; }
const PERSONAS = Array.from({ length: 400 }, (_, i) => persona(i));

const FALLBACK = [
  "GM family, markets never sleep",
  "Just moved some profits to my plan, the wallet flow is smooth",
  "Who else is stacking USDT this week?",
  "The deposit credited in minutes, this monitor thing is real",
  "Watching ETH closely today",
  "Patience pays. Lock it and let it run",
  "Withdrawal hit my wallet, fees were fair",
  "This community keeps me focused",
  "TRC20 fees are so cheap right now",
  "New here but already loving the vibe",
];

function response(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info, x-zc-cron-secret", "Access-Control-Allow-Methods": "POST, OPTIONS", "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

async function rest(path: string, init: RequestInit): Promise<Response> {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...init, headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json", ...(init.headers || {}) } });
}

async function deepseekMessage(persona: string, transcript: string, replying: boolean): Promise<string | null> {
  if (!DEEPSEEK_API_KEY) return null;
  const sys = `You are ${persona}, a casual member of the ZentraChain investor group chat (98,000 members, crypto deposits, investment plans, USDT, withdrawals). Write ONE short chat message (max 160 characters) as ${persona} would send next. Stay friendly and human. Never mention being an AI. No quotes around the message. No signature.`;
  const user = `Recent chat:\n${transcript}\n${replying ? "Reply naturally to the newest message." : "Continue the conversation naturally."}`;
  try {
    const r = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${DEEPSEEK_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: DEEPSEEK_MODEL, messages: [{ role: "system", content: sys }, { role: "user", content: user }], temperature: 0.95, max_tokens: 90, stream: false })
    });
    if (!r.ok) { console.warn("deepseek http", r.status, await r.text()); return null; }
    const d = await r.json();
    const text = String(d?.choices?.[0]?.message?.content ?? "").trim().replace(/^["']|["']$/g, "");
    return text ? text.slice(0, 300) : null;
  } catch (e) { console.warn("deepseek call failed", e); return null; }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info, x-zc-cron-secret", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Max-Age": "86400" } });
  if (req.method !== "POST") return response({ error: "Method not allowed" }, 405);
  try {
    if (!SUPABASE_URL || !SERVICE_KEY) return response({ error: "Community bot is not configured" }, 503);
    // Auth: any signed-in member may trigger a turn, or the cron secret.
    const cronSecret = Deno.env.get("ZC_CRON_SECRET") ?? "";
    const provided = req.headers.get("x-zc-cron-secret") ?? "";
    const authHeader = req.headers.get("Authorization") ?? "";
    let authorized = false;
    if (cronSecret && provided && provided === cronSecret) authorized = true;
    else if (authHeader.startsWith("Bearer ")) {
      const u = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SERVICE_KEY, Authorization: authHeader } });
      authorized = u.ok;
    }
    if (!authorized) return response({ error: "Authentication required" }, 401);

    // Atomic cadence gate: only one turn per ~45 seconds.
    const gateRes = await fetch(`${SUPABASE_URL}/rest/v1/community_bot_state?id=eq.true&last_run=lt.${new Date(Date.now() - 45000).toISOString()}&select=id`, {
      method: "PATCH",
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json", Prefer: "return=representation" },
      body: JSON.stringify({ last_run: new Date().toISOString() })
    });
    const gated = gateRes.ok ? await gateRes.json() : [];
    if (!gateRes.ok || !gated.length) return response({ ok: true, skipped: true, reason: "cooldown" });

    // Recent transcript.
    const msgRes = await rest("community_messages?select=id,sender_id,author_name,body,deleted_at,created_at&order=created_at.desc&limit=14", { method: "GET" });
    const recent = msgRes.ok ? await msgRes.json() as Array<{ id: string; sender_id: string | null; author_name: string; body: string | null; deleted_at: string | null; created_at: string | null }> : [];
    const visible = recent.filter(m => !m.deleted_at && m.body).reverse();
    const transcript = visible.map(m => (m.sender_id === null ? "[bot] " : "") + m.author_name + ": " + String(m.body).slice(0, 140)).join("\n") || "(quiet room)";

    // Newest human message becomes the reply target when fresh.
    const newestHuman = [...recent].reverse().find(m => m.sender_id !== null && !m.deleted_at && m.body);
    const freshHuman = newestHuman && (Date.now() - Date.parse(newestHuman.created_at ?? "") < 180000);

    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
    const posted: Array<{ author: string; body: string; reply: boolean; ai: boolean }> = [];
    const turnCount = 4 + Math.floor(Math.random() * 5); // 4-8 personas per turn
    const used = new Set<number>();
    let lastMessageId: string | null = null;
    let lastAuthor: string | null = null;
    for (let i = 0; i < turnCount; i++) {
      let idx = Math.floor(Math.random() * PERSONAS.length);
      while (used.has(idx)) idx = (idx + 1) % PERSONAS.length;
      used.add(idx);
      const who = PERSONAS[idx];
      // Show the typing indicator, wait a natural moment, then post.
      await rest("community_typing", {
        method: "POST", headers: { Prefer: "resolution=merge-duplicates" },
        body: JSON.stringify({ name: who, until: new Date(Date.now() + 9000).toISOString() })
      });
      await sleep(900 + Math.floor(Math.random() * 1200));
      const transcribed = transcript + (posted.length ? "\n" + posted.map(p => "[bot] " + p.author + ": " + p.body.slice(0, 140)).join("\n") : "");
      const replyToPeer = i > 0 && lastMessageId && Math.random() < 0.45; // personas reply to each other
      const replying = (i === 0 && !!freshHuman && !!newestHuman) || replyToPeer;
      let text = await deepseekMessage(who, transcribed, replying);
      let ai = true;
      if (!text) { text = FALLBACK[Math.floor(Math.random() * FALLBACK.length)]; ai = false; }
      const replyTo = i === 0 && freshHuman && newestHuman ? newestHuman.id : (replyToPeer && lastMessageId ? lastMessageId : null);
      const ins = await rest("community_messages", {
        method: "POST", headers: { Prefer: "return=representation" },
        body: JSON.stringify({ sender_id: null, author_name: who, body: text, reply_to: replyTo })
      });
      await rest(`community_typing?name=eq.${encodeURIComponent(who)}`, { method: "DELETE" });
      if (ins.ok) {
        const rows = await ins.json() as Array<{ id: string }>;
        lastMessageId = rows[0]?.id ?? null;
        lastAuthor = who;
        posted.push({ author: who, body: text, reply: !!replyTo, ai });
      }
      await sleep(400 + Math.floor(Math.random() * 500));
    }
    return response({ ok: true, posted, group_size: GROUP_SIZE, deepseek_configured: !!DEEPSEEK_API_KEY });
  } catch (e) {
    console.error("community-bot failed", e);
    return response({ error: "Community bot failed" }, 500);
  }
});

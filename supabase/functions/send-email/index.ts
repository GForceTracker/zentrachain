import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const FROM = (Deno.env.get("EMAIL_FROM") ?? "ZentraChain <zentrachain@hotmail.com>").trim();
const MJ_KEY = (Deno.env.get("MAILJET_API_KEY") ?? "").trim();
const MJ_SECRET = (Deno.env.get("MAILJET_SECRET_KEY") ?? "").trim();
const RESEND_KEY = (Deno.env.get("RESEND_API_KEY") ?? "").trim();

function response(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info", "Access-Control-Allow-Methods": "POST, OPTIONS", "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

async function sendViaMailjet(to: string, subject: string, html: string): Promise<{ ok: boolean; error?: string }> {
  if (!MJ_KEY || !MJ_SECRET) return { ok: false, error: "MAILJET credentials not configured" };
  const m = FROM.match(/^(.*)<(.+)>$/) ?? [null, "ZentraChain", FROM.trim()];
  const name = (m[1] ?? "ZentraChain").replace(/"/g, "").trim() || "ZentraChain";
  const fromEmail = (m[2] ?? FROM.trim()).trim();
  try {
    const r = await fetch("https://api.mailjet.com/v3.1/send", {
      method: "POST",
      headers: { Authorization: "Basic " + btoa(MJ_KEY + ":" + MJ_SECRET), "Content-Type": "application/json" },
      body: JSON.stringify({ Messages: [{ From: { Email: fromEmail, Name: name }, To: [{ Email: to, Name: to }], Subject: subject, HTMLPart: html }] })
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, error: d?.ErrorMessage ?? (d?.Messages?.[0]?.Errors?.[0]?.ErrorMessage ?? ("HTTP " + r.status)) };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

async function sendViaResend(to: string, subject: string, html: string): Promise<{ ok: boolean; error?: string }> {
  if (!RESEND_KEY) return { ok: false, error: "RESEND_API_KEY not configured" };
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: FROM, to: [to], subject, html })
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, error: d?.message ?? ("HTTP " + r.status) };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return response({ ok: true });
  if (req.method !== "POST") return response({ error: "Method not allowed" }, 405);
  try {
    if (!SUPABASE_URL || !SERVICE_KEY) return response({ error: "Email service is not configured" }, 503);
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader.startsWith("Bearer ")) return response({ error: "Authentication required" }, 401);
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SERVICE_KEY, Authorization: authHeader } });
    if (!userRes.ok) return response({ error: "Invalid session" }, 401);
    const user = await userRes.json();
    if (!user?.id) return response({ error: "Invalid session" }, 401);
    const profRes = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${user.id}&select=role&limit=1`, { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } });
    const profRows = profRes.ok ? await profRes.json() : [];
    if (!profRows.length || profRows[0].role !== "admin") return response({ error: "Administrator access required" }, 403);

    if (!MJ_KEY && !RESEND_KEY) {
      return response({ queued: true, sent: 0, failed: 0, note: "No email provider credentials configured (MAILJET_API_KEY + MAILJET_SECRET_KEY). Emails stay queued." });
    }

    const body = await req.json().catch(() => ({}));
    const only = String(body?.id ?? "");
    const select = only
      ? `${SUPABASE_URL}/rest/v1/email_outbox?id=eq.${only}&select=*`
      : `${SUPABASE_URL}/rest/v1/email_outbox?status=eq.pending&select=*&order=created_at.asc&limit=50`;
    const rowsRes = await fetch(select, { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } });
    const rows = rowsRes.ok ? await rowsRes.json() : [];
    if (!rows.length) return response({ sent: 0, failed: 0, note: "Nothing pending in the outbox." });

    let sent = 0, failed = 0;
    for (const row of rows) {
      let res = await sendViaMailjet(row.to_email, row.subject, row.html);
      if (!res.ok && MJ_KEY && RESEND_KEY) res = await sendViaResend(row.to_email, row.subject, row.html);
      const upd = await fetch(`${SUPABASE_URL}/rest/v1/email_outbox?id=eq.${row.id}`, {
        method: "PATCH",
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
        body: JSON.stringify(res.ok ? { status: "sent", sent_at: new Date().toISOString(), error: null } : { status: "failed", error: res.error ?? "unknown" })
      });
      if (res.ok) sent++; else failed++;
    }
    await fetch(`${SUPABASE_URL}/rest/v1/audit_logs`, {
      method: "POST",
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ actor_id: user.id, action: "emails_processed", entity_type: "email_outbox", entity_id: only || "batch", details: { sent, failed } })
    });
    return response({ sent, failed });
  } catch (e) {
    console.error("send-email failed", e);
    return response({ error: "Could not process emails. Please retry." }, 500);
  }
});

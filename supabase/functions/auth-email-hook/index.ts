import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const HOOK_SECRET = (Deno.env.get("AUTH_EMAIL_HOOK_SECRET") ?? "").trim();
const MJ_KEY = (Deno.env.get("MAILJET_API_KEY") ?? "").trim();
const MJ_SECRET = (Deno.env.get("MAILJET_SECRET_KEY") ?? "").trim();

function shell(title: string, bodyHtml: string, cta: string) {
  return '<div style="font-family:Arial,Helvetica,sans-serif;background:#f4f6f5;padding:32px 12px"><div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e3e8e6"><div style="background:#06180f;padding:22px 26px;color:#9be8c5;font-weight:800;letter-spacing:2px">ZENTRACHAIN</div><div style="padding:28px 26px;color:#17322a">' + title + '<div style="border:1px solid #e3e8e6;border-radius:12px;padding:16px;margin:16px 0">' + bodyHtml + '</div>' + (cta || '') + '<p style="margin:18px 0 0;color:#7c938a;font-size:12px">Never share this link or your password.</p></div></div></div>';
}

function response(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info", "Access-Control-Allow-Methods": "POST, OPTIONS", "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

async function verifyStandardWebhook(sigHeader: string, webhookId: string, timestamp: string, rawBody: string): Promise<boolean> {
  try {
    if (!sigHeader || !webhookId || !timestamp) return false;
    const secretB64 = HOOK_SECRET.split("whsec_")[1] ?? "";
    const keyBytes = Uint8Array.from(atob(secretB64), c => c.charCodeAt(0));
    const signed = webhookId + "." + timestamp + "." + rawBody;
    const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signed)));
    let expected = ""; for (const b of mac) expected += String.fromCharCode(b);
    const expectedB64 = btoa(expected);
    for (const part of sigHeader.split(" ")) {
      const sig = part.startsWith("v1,") ? part.slice(3) : part;
      if (sig === expectedB64) return true;
    }
    return false;
  } catch (e) {
    console.error("webhook verify error", e);
    return false;
  }
}

async function sendViaMailjet(to: string, subject: string, html: string): Promise<{ ok: boolean; error?: string }> {
  if (!MJ_KEY || !MJ_SECRET) return { ok: false, error: "Mailjet credentials missing" };
  try {
    const r = await fetch("https://api.mailjet.com/v3.1/send", {
      method: "POST",
      headers: { Authorization: "Basic " + btoa(MJ_KEY + ":" + MJ_SECRET), "Content-Type": "application/json" },
      body: JSON.stringify({ Messages: [{ From: { Email: "zentrachain@hotmail.com", Name: "ZentraChain" }, To: [{ Email: to, Name: to }], Subject: subject, HTMLPart: html }] })
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, error: d?.ErrorMessage ?? (d?.Messages?.[0]?.Errors?.[0]?.ErrorMessage ?? ("HTTP " + r.status)) };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return response({ ok: true });
  if (req.method !== "POST") return response({ error: "Method not allowed" }, 405);
  try {
    const rawBody = await req.text();
    const sigHeader = req.headers.get("webhook-signature") ?? "";
    const webhookId = req.headers.get("webhook-id") ?? "";
    const timestamp = req.headers.get("webhook-timestamp") ?? "";
    const okSig = await verifyStandardWebhook(sigHeader, webhookId, timestamp, rawBody);
    if (!okSig) {
      try {
        await fetch(SUPABASE_URL + "/rest/v1/email_outbox", {
          method: "POST",
          headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
          body: JSON.stringify({ to_email: "debug", subject: "hook signature failed", html: JSON.stringify({ hasSig: !!sigHeader, id: webhookId, ts: timestamp }), kind: "hook-debug" })
        });
      } catch (e) { console.error("debug write failed", e); }
      return response({ error: "Invalid hook signature" }, 401);
    }
    const payload = JSON.parse(rawBody || "{}");
    const user = payload?.user ?? {};
    const ed = payload?.email_data ?? {};
    const to = String(user?.email ?? ed?.email ?? "");
    const action = String(ed?.email_action_type ?? "signup");
    const site = String(ed?.site_url ?? SUPABASE_URL ?? "");
    const redirectTo = String(ed?.redirect_to ?? "");
    if (!to) return response({ error: "No recipient in hook payload" }, 400);

    let link = "";
    let title = "";
    let subject = "";
    let btn = "Verify email and log in";
    if (action === "recovery") {
      link = site + "/auth/v1/verify?token=" + encodeURIComponent(String(ed?.token_hash ?? ed?.token ?? "")) + "&type=recovery" + (redirectTo ? "&redirect_to=" + encodeURIComponent(redirectTo) : "");
      title = "Password reset requested";
      subject = "Reset your ZentraChain password";
      btn = "Reset my password";
    } else if (action === "magiclink") {
      link = site + "/auth/v1/verify?token=" + encodeURIComponent(String(ed?.token ?? ed?.token_hash ?? "")) + "&type=magiclink" + (redirectTo ? "&redirect_to=" + encodeURIComponent(redirectTo) : "");
      title = "Your sign-in link";
      subject = "Your ZentraChain login link";
      btn = "Log in now";
    } else if (action === "invite") {
      link = site + "/auth/v1/verify?token=" + encodeURIComponent(String(ed?.token_hash ?? ed?.token ?? "")) + "&type=invite" + (redirectTo ? "&redirect_to=" + encodeURIComponent(redirectTo) : "");
      title = "You have been invited";
      subject = "You are invited to ZentraChain";
    } else if (action === "email_change") {
      link = site + "/auth/v1/verify?token=" + encodeURIComponent(String(ed?.token_hash ?? ed?.token ?? "")) + "&type=email_change" + (redirectTo ? "&redirect_to=" + encodeURIComponent(redirectTo) : "");
      title = "Confirm your new email address";
      subject = "Confirm your new email address";
    } else {
      link = site + "/auth/v1/verify?token=" + encodeURIComponent(String(ed?.token_hash ?? ed?.token ?? "")) + "&type=" + encodeURIComponent(action) + (redirectTo ? "&redirect_to=" + encodeURIComponent(redirectTo) : "");
      title = "Confirm your email address";
      subject = "Confirm your email address";
    }
    const name = String(user?.user_metadata?.full_name ?? "").trim().replace(/[<>&]/g, "");
    const html = shell('<h2 style="margin:0 0 6px">' + title + '</h2><p style="margin:0;color:#5f7a6f">Hi ' + (name || "there") + ', tap the button below to continue. The link opens your account automatically - on any device.</p>', '<div style="color:#5f7a6f;font-size:13px">Account</div><div style="font-weight:700">' + to.replace(/[<>&]/g, "") + '</div>', link ? '<a href="' + link + '" style="display:inline-block;background:#20c783;color:#06180f;font-weight:800;padding:14px 26px;border-radius:10px;text-decoration:none">' + btn + '</a>' : '');

    const res = await sendViaMailjet(to, subject, html);
    if (!res.ok) {
      console.error("auth-email-hook send failed:", res.error);
      try {
        await fetch(SUPABASE_URL + "/rest/v1/email_outbox", {
          method: "POST",
          headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
          body: JSON.stringify({ to_email: to, subject: subject, html: html, kind: "auth_" + action, error: res.error ?? null, status: "pending" })
        });
      } catch (e) { console.error("outbox queue failed", e); }
      return response({ handled: true, sent: false, queued: true });
    }
    return response({ handled: true, sent: true });
  } catch (e) {
    console.error("auth-email-hook error", e);
    return response({ handled: false, error: "Hook failure" }, 200);
  }
});

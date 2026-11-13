import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  let diff = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i++) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const setupSecret = Deno.env.get("ADMIN_SETUP_SECRET");

  if (!supabaseUrl || !serviceKey || !setupSecret || setupSecret.length < 32) {
    return json({ error: "Administrator setup is not configured. Contact the platform operator." }, 503);
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return json({ error: "Please log in first." }, 401);
  const accessToken = authHeader.slice(7);

  try {
    const userResponse = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { apikey: serviceKey, Authorization: `Bearer ${accessToken}` },
    });
    if (!userResponse.ok) return json({ error: "Your login session is invalid or expired. Please log in again." }, 401);
    const user = await userResponse.json();
    if (!user?.id || !user?.email) return json({ error: "Could not verify your account." }, 401);

    let body: { setup_secret?: unknown };
    try {
      body = await req.json();
    } catch {
      return json({ error: "Invalid request." }, 400);
    }
    const submittedSecret = typeof body.setup_secret === "string" ? body.setup_secret : "";
    if (!constantTimeEqual(submittedSecret, setupSecret)) {
      return json({ error: "The administrator setup secret is incorrect." }, 403);
    }

    const rpcResponse = await fetch(`${supabaseUrl}/rest/v1/rpc/bootstrap_first_admin`, {
      method: "POST",
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ p_user_id: user.id }),
    });

    if (!rpcResponse.ok) {
      const details = await rpcResponse.text();
      if (details.includes("already been configured")) {
        return json({ error: "An administrator has already been configured. Setup is locked." }, 409);
      }
      console.error("Admin bootstrap database operation failed:", rpcResponse.status);
      return json({ error: "Could not complete administrator setup. Please try again or contact support." }, 500);
    }

    return json({ success: true, message: "Administrator access has been activated for your account. Sign in again if the admin menu does not appear." });
  } catch (error) {
    console.error("Admin bootstrap request failed:", error instanceof Error ? error.message : "unknown error");
    return json({ error: "Administrator setup failed unexpectedly." }, 500);
  }
});
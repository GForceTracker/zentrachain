import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SYMBOLS = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const GLYPHS: Record<string, string[]> = {
  A:["01110","10001","10001","11111","10001","10001","10001"],
  B:["11110","10001","10001","11110","10001","10001","11110"],
  C:["01111","10000","10000","10000","10000","10000","01111"],
  D:["11110","10001","10001","10001","10001","10001","11110"],
  E:["11111","10000","10000","11110","10000","10000","11111"],
  F:["11111","10000","10000","11110","10000","10000","10000"],
  G:["01111","10000","10000","10111","10001","10001","01111"],
  H:["10001","10001","10001","11111","10001","10001","10001"],
  J:["00111","00010","00010","00010","10010","10010","01100"],
  K:["10001","10010","10100","11000","10100","10010","10001"],
  L:["10000","10000","10000","10000","10000","10000","11111"],
  M:["10001","11011","10101","10101","10001","10001","10001"],
  N:["10001","11001","10101","10011","10001","10001","10001"],
  P:["11110","10001","10001","11110","10000","10000","10000"],
  Q:["01110","10001","10001","10001","10101","10010","01101"],
  R:["11110","10001","10001","11110","10100","10010","10001"],
  S:["01111","10000","10000","01110","00001","00001","11110"],
  T:["11111","00100","00100","00100","00100","00100","00100"],
  U:["10001","10001","10001","10001","10001","10001","01110"],
  V:["10001","10001","10001","10001","10001","01010","00100"],
  W:["10001","10001","10001","10101","10101","11011","10001"],
  X:["10001","10001","01010","00100","01010","10001","10001"],
  Y:["10001","10001","01010","00100","00100","00100","00100"],
  Z:["11111","00001","00010","00100","01000","10000","11111"],
  "2":["01110","10001","00001","00010","00100","01000","11111"],
  "3":["11110","00001","00001","01110","00001","00001","11110"],
  "4":["00010","00110","01010","10010","11111","00010","00010"],
  "5":["11111","10000","10000","11110","00001","00001","11110"],
  "6":["01110","10000","10000","11110","10001","10001","01110"],
  "7":["11111","00001","00010","00100","01000","01000","01000"],
  "8":["01110","10001","10001","01110","10001","10001","01110"],
  "9":["01110","10001","10001","01111","00001","00001","01110"]
};

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
  if (hits.size > 5000) for (const [key, value] of hits) if (now > value.reset) hits.delete(key);
  return rec.count > 12;
}
function randomInt(max: number): number {
  const value = new Uint32Array(1);
  crypto.getRandomValues(value);
  return value[0] % max;
}
function makeCaptchaSvg(code: string): string {
  const parts: string[] = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="88" viewBox="0 0 256 88">',
    '<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#f4faf6"/><stop offset="1" stop-color="#dcece2"/></linearGradient></defs>',
    '<rect width="256" height="88" rx="11" fill="url(#bg)"/>'
  ];
  for (let i = 0; i < 9; i++) {
    const x1 = randomInt(256), y1 = randomInt(88), x2 = randomInt(256), y2 = randomInt(88);
    const bend = randomInt(40) - 20;
    parts.push('<path d="M' + x1 + ' ' + y1 + ' Q' + randomInt(256) + ' ' + Math.max(0, Math.min(88, y1 + bend)) + ' ' + x2 + ' ' + y2 + '" fill="none" stroke="#6e9d80" stroke-opacity=".25" stroke-width="1.5"/>');
  }
  for (let i = 0; i < 48; i++) {
    parts.push('<circle cx="' + randomInt(256) + '" cy="' + randomInt(88) + '" r="' + (randomInt(2) + 0.5) + '" fill="#71977e" opacity=".28"/>');
  }
  const colors = ["#153a29", "#14563a", "#263d34", "#0d6240"];
  for (let index = 0; index < code.length; index++) {
    const matrix = GLYPHS[code[index]];
    let path = "";
    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < 5; col++) {
        if (matrix[row][col] === "1") path += "M" + (col * 4.7) + " " + (row * 4.7) + "h4v4h-4z";
      }
    }
    const x = 17 + index * 39 + randomInt(5);
    const y = 17 + randomInt(8);
    const angle = randomInt(17) - 8;
    parts.push('<path d="' + path + '" transform="translate(' + x + ' ' + y + ') rotate(' + angle + ' 11 16)" fill="' + colors[randomInt(colors.length)] + '"/>');
  }
  parts.push("</svg>");
  return parts.join("");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return response({ ok: true });
  if (req.method !== "POST") return response({ error: "Method not allowed" }, 405);
  try {
    const ip = (req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for") ?? "local").split(",")[0].trim();
    if (ipLimited(ip)) return response({ error: "Too many attempts. Try again shortly." }, 429);

    const cutoff = new Date(Date.now() - 600000).toISOString();
    const cleanupUrl = new URL(SUPABASE_URL + "/rest/v1/captcha_challenges");
    cleanupUrl.searchParams.set("created_at", "lt." + cutoff);
    await fetch(cleanupUrl.toString(), {
      method: "DELETE",
      headers: { apikey: SERVICE_KEY, Authorization: "Bearer " + SERVICE_KEY, Prefer: "return=minimal" }
    });

    const code = Array.from({ length: 6 }, () => SYMBOLS[randomInt(SYMBOLS.length)]).join("");
    const insert = await fetch(SUPABASE_URL + "/rest/v1/captcha_challenges", {
      method: "POST",
      headers: {
        apikey: SERVICE_KEY,
        Authorization: "Bearer " + SERVICE_KEY,
        "Content-Type": "application/json",
        Prefer: "return=representation"
      },
      body: JSON.stringify({ code, verified: false, used: false })
    });
    const rows = insert.ok ? await insert.json() : [];
    if (!rows.length) throw new Error("Challenge could not be created");
    return response({ id: rows[0].id, svg: makeCaptchaSvg(code) });
  } catch (error) {
    console.error("captcha-challenge error", error);
    return response({ error: "Could not load the security challenge. Please try again." }, 500);
  }
});

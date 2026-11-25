import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Retired: the old public endpoint could provision or reset the administrator
// account whenever it was called. Use the one-time bootstrap-admin flow instead.
Deno.serve((_req: Request) => {
  return new Response(
    JSON.stringify({ error: "This administrator provisioning endpoint has been retired. Use the one-time bootstrap process." }),
    {
      status: 410,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    },
  );
});

// AskCostReports proxy Worker
// Deploy: wrangler deploy (from this folder, after wrangler login)
//
// Secret to set before deploying (never hardcode):
//   wrangler secret put ANTHROPIC_API_KEY
//
// Same hardening pattern as the Rose City proxy: model and token ceiling are
// pinned server-side, CORS is locked to known origins, and requests are
// rate-limited per IP. No password gate — this is a public product; the
// backstop is the workspace spend cap plus the rate limiter.

const ALLOWED_ORIGINS = new Set([
  "https://askcostreports.com",
  "https://www.askcostreports.com",
  "https://alexdoster.github.io",
]);
const MODEL = "claude-sonnet-5"; // pinned — client-supplied model is ignored
const MAX_TOKENS_CEILING = 1024;

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers: cors });
    }
    if (!ALLOWED_ORIGINS.has(origin)) {
      return json({ error: { message: "Origin not allowed" } }, 403, cors);
    }

    // Rate limit per client IP. Fails open if the binding isn't configured,
    // so a missing wrangler.toml setting doesn't brick the app.
    const clientIP = request.headers.get("CF-Connecting-IP") || "unknown";
    if (env.RATE_LIMITER) {
      const { success } = await env.RATE_LIMITER.limit({ key: clientIP });
      if (!success) {
        return json(
          { error: { message: "Rate limit exceeded. Please wait a moment." } },
          429,
          cors
        );
      }
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: { message: "Invalid JSON body" } }, 400, cors);
    }
    if (!body.system || !Array.isArray(body.messages) || body.messages.length === 0) {
      return json({ error: { message: "Malformed request" } }, 400, cors);
    }

    const upstreamBody = {
      model: MODEL,
      max_tokens: Math.min(Number(body.max_tokens) || 800, MAX_TOKENS_CEILING),
      system: String(body.system).slice(0, 20000),
      messages: body.messages,
    };

    const anthropicResp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(upstreamBody),
    });

    const data = await anthropicResp.json();

    // Translate upstream failures into honest, friendly states the app can
    // render. A blown monthly budget is a success signal, not a crash.
    if (!anthropicResp.ok) {
      const msg = (data && data.error && data.error.message) || "";
      if (/credit|billing|balance|spend/i.test(msg)) {
        return json({ error: { code: "budget", message: "monthly budget reached" } }, 503, cors);
      }
      if (anthropicResp.status === 429 || anthropicResp.status === 529) {
        return json({ error: { code: "busy", message: "high demand" } }, 503, cors);
      }
    }
    return json(data, anthropicResp.status, cors);
  },
};

function json(data, status, cors) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...cors },
  });
}

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.has(origin)
      ? origin
      : "https://askcostreports.com",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

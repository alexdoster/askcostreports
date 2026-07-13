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
// Roomy enough that Sonnet 5's adaptive thinking blocks can't truncate the answer
const MAX_TOKENS_CEILING = 2048;
const MAX_BODY_CHARS = 60000;
const MAX_MESSAGES = 24;
// Schema text arrives from the client (it runs DESCRIBE at load so the prompt
// never goes stale) but is validated hard: identifier/type charset only.
const SCHEMA_PATTERN = /^[A-Za-z0-9_(), ]+$/;
const MAX_SCHEMA_CHARS = 8000;

// System prompts live HERE, not in the client, so the Worker can't be used as
// a general-purpose proxy by spoofing Origin and supplying a custom prompt.
const DATA_RULES = `DATA RULES:
- Table: costreports. Grain: one row per hospital per report_year (provider_ccn + report_year).
- Hospital names are UPPERCASE with inconsistent punctuation and abbreviation (ST vs ST., MEDICAL CENTER vs MED CTR). Match each distinctive word with its own ILIKE, ANDed together: hospital_name ILIKE '%LEGACY%' AND hospital_name ILIKE '%SAMARITAN%'. NEVER put multiple words inside one ILIKE pattern — punctuation between words will break it. Drop generic words (HOSPITAL, MEDICAL, CENTER, ST) from matching.
- state_code is the 2-letter state abbreviation, also uppercase (e.g. 'OR').
- Dollar fields are whole dollars. Bed/day/discharge fields are counts.
- report_year is the cost reporting year (currently the latest available from CMS; cost reports trail real time by 1-2 years).
- Fiscal years vary by hospital (fiscal_year_begin_date / fiscal_year_end_date); group by report_year for trends.
- Small specialty facilities file alongside general acute-care hospitals; for peer comparisons consider filtering by number_of_beds or provider_type.
- Some fields are NULL for some hospitals; use COALESCE or filter NULLs when ranking.
- When a question doesn't specify a year, filter to the latest report_year (use a subquery: WHERE report_year = (SELECT MAX(report_year) FROM costreports)) — never sum or rank across all years unless the question asks for a trend or total over time.`;

function systemSQL(schema) {
  return `You are a SQL expert assistant for Medicare hospital cost report data (DuckDB dialect).
Given a natural language question, write a single DuckDB SQL query to answer it.

TABLE costreports has these columns:
${schema}

${DATA_RULES}

RULES:
- Return ONLY the SQL query, no explanation, no markdown fences, no semicolon at end
- Use DuckDB syntax (date_trunc, strftime, etc.)
- Limit result sets to 20 rows unless the question asks for more
- Always use ILIKE for any name or city matching
- Round large dollar figures sensibly; use ROUND(x/1e6, 1) AS x_millions style for readability when values are in the hundreds of millions
- Always include hospital_name (and report_year when relevant) in results about specific hospitals`;
}

const SYSTEM_ANSWER = `You are AskCostReports, an AI analyst for US hospital Medicare cost report data.
You have just executed a SQL query against CMS cost report filings and received the results below.
Answer the user's question using the query results. Be concise and executive-friendly.
Lead with the direct answer. Use $ for currency (say $12.4M rather than long digit strings), % for rates, commas for large numbers.
If results are empty, say so and suggest a likely reason (name spelling, year not filed, field null for that hospital).
Remember these are as-filed cost reports: figures can be restated and fiscal years vary by hospital. Mention caveats only when they materially affect the answer.
Format as plain conversational prose or simple bullet points. No markdown headers, horizontal rules, emojis, bold text, or markdown tables. Keep answers brief.`;

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

    // Browser-side crash reports: the app beacons here so client-only bugs
    // (like a response-parsing error) are visible in Workers Logs.
    if (new URL(request.url).pathname === "/client-error") {
      const payload = (await request.text()).slice(0, 1000);
      console.error("CLIENT_ERROR", payload);
      return new Response(null, { status: 204, headers: cors });
    }

    let rawBody;
    let body;
    try {
      rawBody = await request.text();
      if (rawBody.length > MAX_BODY_CHARS) {
        return json({ error: { message: "Request too large" } }, 413, cors);
      }
      body = JSON.parse(rawBody);
    } catch {
      return json({ error: { message: "Invalid JSON body" } }, 400, cors);
    }
    if (!Array.isArray(body.messages) || body.messages.length === 0 || body.messages.length > MAX_MESSAGES) {
      return json({ error: { message: "Malformed request" } }, 400, cors);
    }

    let system;
    if (body.mode === "sql") {
      const schema = String(body.schema || "");
      if (!schema || schema.length > MAX_SCHEMA_CHARS || !SCHEMA_PATTERN.test(schema)) {
        return json({ error: { message: "Malformed request" } }, 400, cors);
      }
      system = systemSQL(schema);
    } else if (body.mode === "answer") {
      system = SYSTEM_ANSWER;
    } else {
      return json({ error: { message: "Malformed request" } }, 400, cors);
    }

    const upstreamBody = {
      model: MODEL,
      max_tokens: Math.min(Number(body.max_tokens) || 800, MAX_TOKENS_CEILING),
      system,
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

    let data;
    try {
      data = await anthropicResp.json();
    } catch {
      // Upstream returned non-JSON (gateway error page etc.) — surface as busy
      console.error("UPSTREAM_NON_JSON", anthropicResp.status);
      return json({ error: { code: "busy", message: "high demand" } }, 503, cors);
    }

    // Translate upstream failures into honest, friendly states the app can
    // render. A blown monthly budget is a success signal, not a crash.
    if (!anthropicResp.ok) {
      const msg = (data && data.error && data.error.message) || "";
      console.error("UPSTREAM_ERROR", anthropicResp.status, msg.slice(0, 300));
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

# AskCostReports

Ask questions about any US hospital's Medicare cost report, in plain English,
in your browser. **askcostreports.com**

Every Medicare-certified hospital (~6,000) files an annual cost report with CMS —
the only public source of complete financials for every American hospital:
income statement, balance sheet, utilization, staffing, charity care.
AskCostReports puts an AI analyst on top of that data.

## How it works

Zero-backend architecture:

- **Data:** CMS's curated [Hospital Provider Cost Report](https://data.cms.gov/provider-compliance/cost-reports/hospital-provider-cost-report)
  dataset (2011-2023, 117 measures per hospital-year), refreshed automatically by a
  GitHub Actions workflow that publishes Parquet to this repo's `data` branch.
- **Query engine:** [DuckDB-WASM](https://duckdb.org/docs/api/wasm/overview) —
  the SQL runs entirely in your browser. Your questions never upload the data anywhere.
- **AI:** questions go to Claude (Anthropic API) through a hardened Cloudflare Worker
  proxy that pins the model, caps tokens, restricts origins, and rate-limits by IP.
  The AI sees the schema and query results, never the raw dataset.
- **Hosting:** GitHub Pages. There is no server.

## Repo layout

- `pipeline/build_data.py` — discovers available years from the CMS DCAT catalog,
  downloads, normalizes column names, writes ZSTD Parquet + `manifest.json`
- `.github/workflows/refresh-data.yml` — weekly automated refresh to the `data` branch
- `cloudflare-worker.js` + `wrangler.toml` — the API proxy
- `index.html` — the app

## Data notes

Source data is public domain (CMS). Column names are snake_cased from CMS's
originals; a `report_year` column is added from the filing year. Cost reports are
as-filed: figures can be restated, fiscal years vary by hospital, and small
specialty facilities file alongside general acute-care hospitals — compare peers
thoughtfully.

---

Built by [Alex Doster](https://alexdoster.github.io/Portfolio) · Portland, OR

#!/usr/bin/env python3
"""AskCostReports data pipeline.

Pulls the CMS "Hospital Provider Cost Report" dataset (curated HCRIS extract,
one row per hospital per fiscal year) and produces browser-ready Parquet.

Fully automated: discovers available years from the CMS DCAT catalog
(data.json), so new years appear without code changes. Run by GitHub Actions
on a schedule; results are committed to the repo's `data` branch.

Usage:
    python build_data.py                 # all available years
    python build_data.py --years 2021 2022 2023
    python build_data.py --out ./data_out
"""

import argparse
import io
import json
import re
import sys
import urllib.request
from pathlib import Path

import duckdb

CATALOG_URL = "https://data.cms.gov/data.json"
DATASET_TITLE = "Hospital Provider Cost Report"
UA = {"User-Agent": "askcostreports-pipeline/1.0 (public data build)"}


def fetch(url: str) -> bytes:
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=300) as resp:
        return resp.read()


def discover_year_csvs() -> dict[int, str]:
    """Map report year -> CSV download URL from the CMS catalog."""
    catalog = json.loads(fetch(CATALOG_URL))
    dataset = next(
        d for d in catalog["dataset"] if d.get("title") == DATASET_TITLE
    )
    years = {}
    for dist in dataset.get("distribution", []):
        url = dist.get("downloadURL", "")
        m = re.search(r"CostReport_?(\d{4})", url, re.IGNORECASE)
        if m and url.endswith(".csv"):
            years[int(m.group(1))] = url
    if not years:
        sys.exit("No CSV distributions found — catalog format may have changed.")
    return years


def snake(col: str) -> str:
    """'FTE - Employees on Payroll' -> 'fte_employees_on_payroll'"""
    s = re.sub(r"[^0-9a-zA-Z]+", "_", col).strip("_").lower()
    return re.sub(r"_+", "_", s)


def build_year(con, year: int, url: str, out_dir: Path) -> int:
    raw = fetch(url)
    tmp = out_dir / f"_raw_{year}.csv"
    tmp.write_bytes(raw)

    con.execute("DROP TABLE IF EXISTS yr")
    con.execute(
        f"CREATE TABLE yr AS SELECT * FROM read_csv_auto('{tmp}', header=true, "
        f"all_varchar=false, sample_size=-1)"
    )
    cols = [r[0] for r in con.execute("DESCRIBE yr").fetchall()]
    renames = ", ".join(f'"{c}" AS {snake(c)}' for c in cols)
    con.execute(
        f"CREATE OR REPLACE TABLE yr_clean AS "
        f"SELECT {year} AS report_year, {renames} FROM yr"
    )
    out = out_dir / f"costreport_{year}.parquet"
    con.execute(f"COPY yr_clean TO '{out}' (FORMAT PARQUET, COMPRESSION ZSTD)")
    n = con.execute("SELECT COUNT(*) FROM yr_clean").fetchone()[0]
    tmp.unlink()
    print(f"  {year}: {n:,} hospitals -> {out.name} ({out.stat().st_size/1e6:.1f} MB)")
    return n


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--years", nargs="*", type=int, default=None)
    ap.add_argument("--out", default="data_out")
    args = ap.parse_args()

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    year_urls = discover_year_csvs()
    targets = sorted(args.years or year_urls.keys())
    missing = [y for y in targets if y not in year_urls]
    if missing:
        sys.exit(f"Years not in CMS catalog: {missing}. Available: {sorted(year_urls)}")

    print(f"Building {len(targets)} year(s): {targets}")
    con = duckdb.connect()
    total = 0
    for y in targets:
        total += build_year(con, y, year_urls[y], out_dir)

    # Manifest tells the front end which years exist without hardcoding.
    manifest = {
        "dataset": DATASET_TITLE,
        "years": targets,
        "total_rows": total,
        "files": [f"costreport_{y}.parquet" for y in targets],
    }
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(f"Done: {total:,} hospital-year rows. Manifest written.")


if __name__ == "__main__":
    main()

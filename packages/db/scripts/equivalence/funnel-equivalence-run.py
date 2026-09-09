#!/usr/bin/env python3
"""
Funnel equivalence runner — the ClickHouse half of the harness.

Input: the JSON written by `funnel-equivalence.harness.test.ts` (one entry per
report, each carrying the SQL for BOTH the raw-events path and the MV path).
For every MV-eligible report it runs both variants against ClickHouse and
compares the outputs:

  funnel  — (level, breakdown…, count) rows must be IDENTICAL
  timing  — per-series medians within TDigest tolerance (2 % or 2 s)
  props   — property sums within 0.01, converted counts identical

Exit code 1 if any report diverges. Prints a table plus per-path timings so the
same run doubles as a before/after latency measurement.

Usage (on a host that can reach ClickHouse):
  CH_URL=http://host:8123 CH_USER=default CH_PASSWORD=… \
    python3 funnel-equivalence-run.py pairs.json [--only dashboardId,…] [--threads 4] [--out results.json]
"""
import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request


def ch(sql: str, tz: str, threads: int) -> list:
    params = {
        "database": os.environ.get("CH_DATABASE", "openpanel"),
        "session_timezone": tz,
        "max_threads": str(threads),
        "max_execution_time": "600",
    }
    url = os.environ["CH_URL"].rstrip("/") + "/?" + urllib.parse.urlencode(params)
    body = sql.rstrip().rstrip(";")
    # The app appends its own FORMAT; strip a trailing one so ours wins.
    for fmt in ("FORMAT JSON", "FORMAT JSONEachRow", "FORMAT JSONCompact"):
        if body.endswith(fmt):
            body = body[: -len(fmt)].rstrip()
    body += "\nFORMAT JSONCompact"
    req = urllib.request.Request(url, data=body.encode(), method="POST")
    req.add_header("X-ClickHouse-User", os.environ.get("CH_USER", "default"))
    req.add_header("X-ClickHouse-Key", os.environ.get("CH_PASSWORD", ""))
    try:
        with urllib.request.urlopen(req, timeout=650) as resp:
            payload = json.load(resp)
    except urllib.error.HTTPError as e:  # surface ClickHouse's message, not just the status
        raise RuntimeError(f"HTTP {e.code}: {e.read().decode('utf-8', 'replace')[:600]}") from None
    return payload["data"], [m["name"] for m in payload.get("meta", [])]


def norm(v):
    if v is None:
        return None
    if isinstance(v, str):
        try:
            f = float(v)
            return f
        except ValueError:
            return v
    return v


def rows_as_dicts(data, cols):
    return [dict(zip(cols, [norm(x) for x in row])) for row in data]


def compare_funnel(a, b):
    key = lambda r: tuple(str(r.get(c)) for c in sorted(r) if c != "count")
    da = {key(r): r.get("count") for r in a}
    db = {key(r): r.get("count") for r in b}
    diffs = []
    for k in sorted(set(da) | set(db)):
        if da.get(k) != db.get(k):
            diffs.append((k, da.get(k), db.get(k)))
    return diffs


def compare_numeric_rows(a, b, value_cols, tol_rel=0.02, tol_abs=2.0, exact_cols=()):
    def key(r):
        return tuple(str(r.get(c)) for c in sorted(r) if c not in value_cols and c not in exact_cols)

    da = {key(r): r for r in a}
    db = {key(r): r for r in b}
    diffs = []
    for k in sorted(set(da) | set(db)):
        ra, rb = da.get(k), db.get(k)
        if ra is None or rb is None:
            diffs.append((k, "missing", ra is None, rb is None))
            continue
        for c in exact_cols:
            if ra.get(c) != rb.get(c):
                diffs.append((k, c, ra.get(c), rb.get(c)))
        for c in value_cols:
            x, y = ra.get(c), rb.get(c)
            if x is None and y is None:
                continue
            if x is None or y is None or (isinstance(x, float) and x != x) or (isinstance(y, float) and y != y):
                # NaN and NULL are both "no data" for a median.
                if (x is None or x != x) and (y is None or y != y):
                    continue
                diffs.append((k, c, x, y))
                continue
            if abs(x - y) > max(tol_abs, tol_rel * max(abs(x), abs(y))):
                diffs.append((k, c, x, y))
    return diffs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pairs")
    ap.add_argument("--only", default="")
    ap.add_argument("--ids", default="", help="comma-separated report ids")
    ap.add_argument("--threads", type=int, default=4)
    ap.add_argument("--out", default="")
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args()

    pairs = json.load(open(args.pairs))
    only = {x for x in args.only.split(",") if x}
    ids = {x for x in args.ids.split(",") if x}
    results = []
    bad = 0
    ran = 0
    for p in pairs:
        if only and p.get("dashboardId") not in only:
            continue
        if ids and p["id"] not in ids:
            continue
        if not p.get("mvEligible"):
            continue
        if args.limit and ran >= args.limit:
            break
        ran += 1
        tz = p.get("timezone", "UTC")
        rec = {"id": p["id"], "name": p["name"], "chartType": p["chartType"], "dashboardId": p.get("dashboardId"), "ok": True, "checks": {}}
        for part, cmp in (("funnel", "funnel"), ("timing", "timing"), ("props", "props")):
            raw_sql = p["raw"].get(part)
            mv_sql = p["mv"].get(part)
            if not raw_sql or not mv_sql:
                continue
            try:
                t0 = time.time(); ra, ca = ch(raw_sql, tz, args.threads); t_raw = time.time() - t0
                t0 = time.time(); rb, cb = ch(mv_sql, tz, args.threads); t_mv = time.time() - t0
            except Exception as e:  # noqa: BLE001
                rec["ok"] = False
                rec["checks"][part] = {"error": str(e)[:300]}
                continue
            A, B = rows_as_dicts(ra, ca), rows_as_dicts(rb, cb)
            if part == "funnel":
                diffs = compare_funnel(A, B)
            elif part == "timing":
                vcols = [c for c in cb if c.endswith("_median")]
                diffs = compare_numeric_rows(A, B, vcols)
            else:
                diffs = compare_numeric_rows(A, B, ["total_sum", "property_average"], tol_rel=0.0001, tol_abs=0.01, exact_cols=("property_count",))
            rec["checks"][part] = {"raw_s": round(t_raw, 1), "mv_s": round(t_mv, 1), "rows": len(A), "diffs": diffs[:10]}
            if diffs:
                rec["ok"] = False
        results.append(rec)
        if not rec["ok"]:
            bad += 1
        status = "OK " if rec["ok"] else "DIFF"
        parts = "  ".join(
            f"{k}: raw {v.get('raw_s','?')}s → mv {v.get('mv_s','?')}s" + (f" ({len(v['diffs'])} diffs)" if v.get("diffs") else "") + (" ERR" if v.get("error") else "")
            for k, v in rec["checks"].items()
        )
        print(f"{status} [{rec['chartType']:13}] {rec['name'][:60]:60} {parts}", flush=True)
        for k, v in rec["checks"].items():
            for d in v.get("diffs", [])[:5]:
                print(f"       {k} diff: {d}")
            if v.get("error"):
                print(f"       {k} error: {v['error']}")
    print(f"\n{ran} reports compared, {bad} diverged")
    if args.out:
        json.dump(results, open(args.out, "w"), indent=1)
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()

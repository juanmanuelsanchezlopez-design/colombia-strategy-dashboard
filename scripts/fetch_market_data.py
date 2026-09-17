"""
fetch_market_data.py — downloads prices, price history, dividends and FX from
Yahoo Finance for the Colombia Strategy Dashboard and saves them for the website.

How to run (from the project folder; run\\1_refresh_prices.bat does --full)
    %USERPROFILE%\\.venvs\\colombia-strategy-dashboard\\Scripts\\python.exe scripts\\fetch_market_data.py --full

Where it runs
    On Juan's computer (run\\1_refresh_prices.bat, run\\3_open_dashboard.bat), and on GitHub for the
    published website (.github/workflows/update-prices.yml, from deploy/): every 10 minutes in market
    hours with --quotes-only, and once a day with --full (DECISIONS D21).

Modes (SPEC §7, §10)
    --full                 5 years of daily history, dividends, latest quotes and FX.
    --quotes-only          Latest quotes and FX only. Also updates the last few days of the
                           saved history. Downloads the full history instead when the saved
                           data can't be topped up (see needs_full).
    --seed-year-end 2025   Saves each line's last 2025 close and the FX on that date.
                           Rows already locked are kept unless --force is added.

Writes
    site/data/market_data.js                     window.MARKET_DATA = {...} (read by the website)
    audit/market_snapshots/YYYY-MM-DD_HHMM.json  the same data; the last 30 are kept
    audit/excluded_prices.csv                    every price removed as a known Yahoo error (--full)
    inputs/BTG_Colombia_Inputs.xlsx, YE_Prices   year-end prices (--seed-year-end); close Excel first

Rules this script follows
    - auto_adjust=False (SPEC §7.1): prices are split-adjusted but NOT dividend-adjusted,
      so total return can add dividends without counting them twice.
    - Days listed in market_config.EXCLUDED_PRICE_DAYS are removed from the price history.
      Dividends on those days are kept.
    - FX values outside the sanity ranges in market_config.FX are never used.
    - If Yahoo fails, the previously saved data is kept and the reason is recorded.
"""

import argparse
import csv
import io
import json
import logging
import math
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import pandas as pd
import yfinance as yf
from yfinance.exceptions import YFRateLimitError

import market_config as cfg

PROJECT = Path(__file__).resolve().parent.parent
MARKET_JS = PROJECT / "site" / "data" / "market_data.js"
SNAPSHOTS = PROJECT / "audit" / "market_snapshots"
EXCLUDED_LOG = PROJECT / "audit" / "excluded_prices.csv"

RETRIES = 3                      # SPEC §7.1: retry 3 times with backoff
JS_PREFIX = "window.MARKET_DATA = "
MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split()
YE_COLUMNS = ["line_id", "year", "close", "close_date", "usd_fx", "source", "locked"]


class MarketDataError(Exception):
    """A failure with a plain-language message for Juan, plus an optional technical detail."""

    def __init__(self, message, detail=None):
        super().__init__(message)
        self.detail = detail


# =============================================================================
# Small helpers
# =============================================================================

def now_bogota():
    return pd.Timestamp.now(tz=cfg.TIMEZONE)


def fmt_date(d):
    d = pd.Timestamp(d)
    return f"{d.day:02d} {MONTHS[d.month - 1]} {d.year}"


def fmt_stamp(ts):
    ts = pd.Timestamp(ts).tz_convert(cfg.TIMEZONE)
    return f"{fmt_date(ts)}, {ts:%H:%M} (Bogotá)"


def iso_utc(ts):
    return pd.Timestamp(ts).tz_convert("UTC").strftime("%Y-%m-%dT%H:%M:%SZ")


def business_days_between(earlier, later):
    """Weekdays from `earlier` up to (not including) `later`; 0 if same day or later is earlier."""
    a, b = np.datetime64(str(earlier)[:10]), np.datetime64(str(later)[:10])
    return int(np.busday_count(a, b)) if b > a else 0


def clean_num(x, digits=4):
    """A finite number, rounded, or None (Yahoo sometimes returns NaN or nothing)."""
    try:
        x = float(x)
    except (TypeError, ValueError):
        return None
    return round(x, digits) if math.isfinite(x) else None


def csv_text(comment_lines, columns, rows):
    """CSV with '#' comment lines on top. Values are quoted properly (reasons contain commas)."""
    buf = io.StringIO()
    for line in comment_lines:
        buf.write(line + "\n")
    writer = csv.DictWriter(buf, fieldnames=columns, lineterminator="\n", extrasaction="ignore")
    writer.writeheader()
    for r in rows:
        writer.writerow({c: ("" if r.get(c) is None else r.get(c)) for c in columns})
    return buf.getvalue()


def fx_in_range(pair, value):
    _, lo, hi = cfg.FX[pair]
    return value is not None and lo <= value <= hi


def with_retries(fn, what):
    """Run fn(); retry with backoff. Raises MarketDataError with a plain message."""
    last = None
    for attempt in range(1, RETRIES + 1):
        try:
            return fn()
        except YFRateLimitError:
            last = "rate"
            time.sleep(15 * attempt)
        except Exception as exc:
            last = exc
            time.sleep(2 ** attempt)
    if last == "rate":
        raise MarketDataError(f"Yahoo Finance is refusing requests ({what}) because too many were made in a short "
                              "time. Wait 15 minutes and try again.")
    raise MarketDataError(f"Couldn't reach Yahoo Finance ({what}). Check the internet connection and try again.",
                          detail=f"{type(last).__name__}: {last}")


def atomic_write(path, text):
    """Write via a temporary file so the website never reads a half-written file.
    CSV files get a UTF-8 byte-order mark so Excel shows accents (Bogotá) correctly."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text, encoding="utf-8-sig" if path.suffix == ".csv" else "utf-8", newline="\n")
    for attempt in range(5):                     # OneDrive can briefly lock a file it is syncing
        try:
            os.replace(tmp, path)
            return
        except PermissionError:
            time.sleep(1 + attempt)
    raise MarketDataError(f"Couldn't save {path.relative_to(PROJECT)} because another program is using it "
                          "(often OneDrive syncing). Wait a minute and run this again.")


# =============================================================================
# Turning Yahoo tables into saved data (pure functions, tested offline)
# =============================================================================

def frame_to_series(frame, today):
    """
    From one ticker's daily table (Close, Volume, Dividends) return:
      closes      [[YYYY-MM-DD, close], ...]   days with a price, up to today
      dividends   [[YYYY-MM-DD, amount], ...]  every dividend, even on days with no price
      last_traded YYYY-MM-DD of the last day with volume > 0 (None if volume is never positive)
    """
    if frame is None or frame.empty:
        return [], [], None
    f = frame.copy()
    f.index = [pd.Timestamp(d).strftime("%Y-%m-%d") for d in f.index]
    f = f[f.index <= str(today)[:10]]
    f = f[~f.index.duplicated(keep="last")].sort_index()
    closes = [[d, round(float(v), 4)] for d, v in f["Close"].items() if pd.notna(v)]
    dividends = []
    if "Dividends" in f:
        dividends = [[d, round(float(v), 6)] for d, v in f["Dividends"].items() if pd.notna(v) and v > 0]
    last_traded = None
    if "Volume" in f:
        traded = f[(f["Volume"] > 0) & f["Close"].notna()]
        last_traded = traded.index[-1] if len(traded) else None
    return closes, dividends, last_traded


def applies(ticker, applies_to):
    return applies_to == "*" or ticker.endswith(applies_to)


def apply_exclusions(line_id, ticker, closes, excluded=None):
    """Remove known bad price days. Returns (kept closes, log rows for audit/excluded_prices.csv)."""
    excluded = cfg.EXCLUDED_PRICE_DAYS if excluded is None else excluded
    bad = {d: reason for d, suffix, reason in excluded if applies(ticker, suffix)}
    kept, log = [], []
    for i, (d, v) in enumerate(closes):
        if d in bad:
            before = closes[i - 1] if i > 0 else [None, None]
            after = closes[i + 1] if i + 1 < len(closes) else [None, None]
            log.append({"line_id": line_id, "yahoo_ticker": ticker, "date": d, "removed_close": v,
                        "date_before": before[0], "close_before": before[1],
                        "date_after": after[0], "close_after": after[1], "reason": bad[d]})
        else:
            kept.append([d, v])
    return kept, log


def excluded_dates_for(ticker, excluded=None):
    excluded = cfg.EXCLUDED_PRICE_DAYS if excluded is None else excluded
    return {d for d, suffix, _ in excluded if applies(ticker, suffix)}


def filter_fx(pair, closes):
    """Drop FX points outside the sanity range. Returns (kept, removed)."""
    kept = [p for p in closes if fx_in_range(pair, p[1])]
    removed = [p for p in closes if not fx_in_range(pair, p[1])]
    return kept, removed


def merge_points(history, recent, skip_dates=()):
    """Replace or add dated points (history wins nothing: recent values overwrite the same date)."""
    merged = {d: v for d, v in history}
    for d, v in recent:
        if d not in skip_dates:
            merged[d] = v
    return [[d, merged[d]] for d in sorted(merged)]


def trim_history(points, start):
    return [p for p in points if p[0] >= str(start)[:10]]


def line_status(trade_date, reference_date, tolerance=None):
    """SPEC §7.5: 'ok' if the last trade is within `tolerance` business days of the latest session."""
    tolerance = cfg.STALE_AFTER_BUSINESS_DAYS if tolerance is None else tolerance
    if trade_date is None:
        return "error"
    return "stale" if business_days_between(trade_date, reference_date) > tolerance else "ok"


def year_end_pick(closes_with_volume, year, excluded_dates=()):
    """
    Last close of `year`: the last day up to 31 Dec with trading volume; if the line never traded
    in that window, the last day with a price. closes_with_volume: [[date, close, volume], ...].
    Returns (date, close) or (None, None).
    """
    end = f"{year}-12-31"
    rows = [r for r in closes_with_volume if r[0] <= end and r[0] >= f"{year}-01-01" and r[0] not in excluded_dates]
    traded = [r for r in rows if r[2] and r[2] > 0]
    pick = traded[-1] if traded else (rows[-1] if rows else None)
    return (pick[0], pick[1]) if pick else (None, None)


def fx_on_or_before(fx_closes, date):
    """Last FX close on or before `date`: (date, value) or (None, None)."""
    rows = [p for p in fx_closes if p[0] <= date]
    return (rows[-1][0], rows[-1][1]) if rows else (None, None)


def merge_year_end(existing, new, force=False):
    """Keep existing rows marked locked = Y unless force. Rows are dicts keyed by YE_COLUMNS."""
    out = {(r["line_id"], str(r["year"])): r for r in existing}
    kept_locked = []
    for r in new:
        key = (r["line_id"], str(r["year"]))
        old = out.get(key)
        if old and str(old.get("locked", "")).upper() == "Y" and not force:
            kept_locked.append(key)
            continue
        out[key] = r
    rows = sorted(out.values(), key=lambda r: (str(r["year"]), r["line_id"]))
    return rows, kept_locked


def render_js(payload, mode, when):
    header = ("/* GENERATED FILE: do not edit by hand.\n"
              "   What: market data for the Colombia Strategy Dashboard (prices, 5-year daily history,\n"
              "         dividends, FX) from Yahoo Finance.\n"
              f"   Produced by: scripts/fetch_market_data.py --{mode}\n"
              f"   When: {fmt_stamp(when)}\n"
              "*/\n")
    return header + JS_PREFIX + json.dumps(payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + ";\n"


def load_js(text):
    i = text.index(JS_PREFIX) + len(JS_PREFIX)
    return json.loads(text[i:].strip().rstrip(";"))


def prune_snapshots(folder, keep):
    files = sorted(folder.glob("*.json"))
    for f in files[:-keep] if len(files) > keep else []:
        f.unlink()


# =============================================================================
# Talking to Yahoo
# =============================================================================

def download_history(tickers, start, end=None):
    """One bulk download (SPEC §7.1). Returns {ticker: DataFrame with Close, Volume, Dividends}."""
    def call():
        df = yf.download(tickers, start=str(start)[:10], end=end, interval="1d", auto_adjust=False,
                         actions=True, group_by="ticker", threads=True, progress=False)
        if df is None or df.empty:
            raise RuntimeError("Yahoo returned an empty table")
        return df
    df = with_retries(call, "price history")
    out = {}
    for t in tickers:
        if t in df.columns.get_level_values(0):
            sub = df[t].copy()
            keep = [c for c in ("Close", "Volume", "Dividends") if c in sub.columns]
            sub = sub[keep]
            out[t] = sub if sub["Close"].notna().any() else None
        else:
            out[t] = None
    return out


def get_quote(ticker):
    """Latest quote (SPEC §7.1: fast_info, falling back to the last daily close) and the last 5 daily bars."""
    def call():
        t = yf.Ticker(ticker)
        bars = t.history(period="5d", interval="1d", auto_adjust=False, actions=True)
        if bars is None or bars.empty or bars["Close"].dropna().empty:
            raise RuntimeError("no recent prices")
        meta = t.get_history_metadata() or {}
        last = prev = None
        try:
            fi = t.fast_info
            last, prev = fi.last_price, fi.previous_close
        except Exception:
            pass
        closes = bars["Close"].dropna()
        last = clean_num(last) or clean_num(meta.get("regularMarketPrice")) or clean_num(closes.iloc[-1])
        prev = clean_num(prev) or (clean_num(closes.iloc[-2]) if len(closes) > 1 else None)
        rmt = meta.get("regularMarketTime")
        if isinstance(rmt, (int, float)):
            rmt = pd.Timestamp(rmt, unit="s", tz="UTC")
        return {"last_price": last, "previous_close": prev,
                "time": pd.Timestamp(rmt) if rmt is not None else None, "bars": bars}
    try:
        return with_retries(call, ticker)
    except MarketDataError as exc:
        return {"error": str(exc)}


def get_quotes(tickers):
    with ThreadPoolExecutor(max_workers=8) as pool:
        return dict(zip(tickers, pool.map(get_quote, tickers)))


# =============================================================================
# Building the saved data
# =============================================================================

def load_existing():
    if not MARKET_JS.exists():
        return None
    try:
        return load_js(MARKET_JS.read_text(encoding="utf-8"))
    except Exception:
        return None


def quote_trade_date(quote, last_traded):
    dates = [d for d in (last_traded,) if d]
    if quote and quote.get("time") is not None:
        dates.append(quote["time"].tz_convert(cfg.TIMEZONE).strftime("%Y-%m-%d"))
    return max(dates) if dates else None


def finish_payload(payload, now, mode):
    """Statuses, reference session and headline fields shared by both modes."""
    today = now.strftime("%Y-%m-%d")
    dates = [l["last_trade_date"] for l in payload["lines"].values() if l["status"] != "error" and l["last_trade_date"]]
    reference = min(max(dates), today) if dates else today
    for l in payload["lines"].values():
        if l["status"] != "error":
            l["status"] = line_status(l["last_trade_date"], reference)
            l["status_note"] = "" if l["status"] == "ok" else f"Last trade: {fmt_date(l['last_trade_date'])}"
    times = [l["last_trade_time"] for l in payload["lines"].values() if l["last_trade_time"]]
    statuses = [l["status"] for l in payload["lines"].values()] + [f["status"] for f in payload["fx"].values()]
    payload.update({
        "generated_at": iso_utc(now),
        "mode": mode,
        "prices_as_of": max(times) if times else None,
        "reference_session": reference,
        "status": "error" if "error" in statuses else ("stale" if "stale" in statuses else "ok"),
    })
    return payload


def build_full(now):
    today = now.strftime("%Y-%m-%d")
    start = (now - pd.DateOffset(years=cfg.HISTORY_YEARS)).strftime("%Y-%m-%d")
    existing = load_existing() or {"lines": {}, "fx": {}}
    fx_tickers = [v[0] for v in cfg.FX.values()]
    tickers = [l.yahoo_ticker for l in cfg.LINES] + fx_tickers

    frames = download_history(tickers, start)
    quotes = get_quotes(tickers)

    payload = {"_generated_file": "GENERATED FILE: do not edit by hand. Produced by scripts/fetch_market_data.py.",
               "source": f"Yahoo Finance via yfinance {yf.__version__} (auto_adjust=False)",
               "history_years": cfg.HISTORY_YEARS,
               "excluded_price_days": [{"date": d, "applies_to": s, "reason": r} for d, s, r in cfg.EXCLUDED_PRICE_DAYS],
               "fx": {}, "lines": {}}
    excluded_log, failures = [], []

    for line in cfg.LINES:
        t = line.yahoo_ticker
        closes, dividends, last_traded = frame_to_series(frames.get(t), today)
        closes, log = apply_exclusions(line.line_id, t, closes)
        excluded_log += log
        q = quotes.get(t) or {"error": "no quote"}
        old = existing["lines"].get(line.line_id)
        if not closes:
            failures.append(line.line_id)
            if old:
                payload["lines"][line.line_id] = dict(old, status="error",
                    status_note=f"Yahoo returned no data; showing prices saved at {fmt_stamp(existing['generated_at'])}")
            else:
                payload["lines"][line.line_id] = {"yahoo_ticker": t, "currency": line.currency, "last_price": None,
                    "last_trade_time": None, "last_trade_date": None, "previous_close": None, "status": "error",
                    "status_note": "Yahoo returned no data for this ticker", "history_start": None,
                    "history": [], "dividends": []}
            continue
        has_quote = "error" not in q
        last_price = q["last_price"] if has_quote else closes[-1][1]
        previous = (q["previous_close"] if has_quote else None) or (closes[-2][1] if len(closes) > 1 else None)
        payload["lines"][line.line_id] = {
            "yahoo_ticker": t, "currency": line.currency,
            "last_price": last_price,
            "last_trade_time": iso_utc(q["time"]) if has_quote and q["time"] is not None else None,
            "last_trade_date": quote_trade_date(q if has_quote else None, last_traded),
            "previous_close": previous,
            "status": "ok",
            "status_note": "" if has_quote else "Latest quote unavailable; using the last daily close",
            "history_start": closes[0][0], "history": closes, "dividends": dividends,
        }

    for pair, (t, lo, hi) in cfg.FX.items():
        closes, _, _ = frame_to_series(frames.get(t), today)
        closes, removed = filter_fx(pair, closes)
        for d, v in removed:
            excluded_log.append({"line_id": pair, "yahoo_ticker": t, "date": d, "removed_close": v,
                                 "date_before": None, "close_before": None, "date_after": None, "close_after": None,
                                 "reason": f"FX outside sanity range {lo:,}–{hi:,}"})
        q = quotes.get(t) or {"error": "no quote"}
        last = q.get("last_price") if "error" not in q else None
        old = existing["fx"].get(pair)
        if not fx_in_range(pair, last):
            bad = f"{last:,.4f}" if last is not None else "no value"
            note = f"Yahoo's {pair} ({bad}) was outside the {lo:,}–{hi:,} range or unavailable, so it was not used"
            last = closes[-1][1] if closes else (old or {}).get("last")
            status = "error"
        else:
            note, status = "", "ok"
        if not closes:
            failures.append(pair)
        payload["fx"][pair] = {"yahoo_ticker": t, "last": last,
                               "time": iso_utc(q["time"]) if "error" not in q and q["time"] is not None else None,
                               "status": status, "status_note": note,
                               "history": closes or (old or {}).get("history", [])}

    if len(failures) > len(cfg.LINES) / 2:
        raise MarketDataError(f"Yahoo Finance returned no data for {len(failures)} of {len(cfg.LINES) + len(cfg.FX)} "
                              "tickers, so nothing was saved. Try again in a few minutes.")
    return finish_payload(payload, now, "full"), excluded_log


QUOTES_ONLY_MAX_GAP_DAYS = 5    # --quotes-only merges the last 5 trading days; older saved data needs --full


def needs_full(existing, lines, now):
    """Why --quotes-only can't just top up the saved data (then the full history is downloaded), or None."""
    if not existing:
        return "there is no saved price history yet"
    missing = [l.line_id for l in lines if l.line_id not in existing.get("lines", {})]
    if missing:
        return f"{', '.join(missing)} {'is' if len(missing) == 1 else 'are'} not in the saved price history yet"
    saved = pd.Timestamp(existing["generated_at"])
    if (now - saved).days > QUOTES_ONLY_MAX_GAP_DAYS:
        return f"the saved price history is from {fmt_date(saved.tz_convert(cfg.TIMEZONE))}"
    return None


def build_quotes_only(now):
    existing = load_existing()
    if not existing:
        raise MarketDataError("There is no saved price history yet. Run 1_refresh_prices.bat first "
                              "(it downloads the full history).")
    today = now.strftime("%Y-%m-%d")
    start = (now - pd.DateOffset(years=cfg.HISTORY_YEARS)).strftime("%Y-%m-%d")
    payload = json.loads(json.dumps(existing))          # deep copy
    fx_tickers = {v[0]: pair for pair, v in cfg.FX.items()}
    tickers = [l.yahoo_ticker for l in cfg.LINES] + list(fx_tickers)
    quotes = get_quotes(tickers)
    if all("error" in q for q in quotes.values()):
        raise MarketDataError(f"Couldn't reach the price service. Showing prices saved at {fmt_stamp(existing['generated_at'])}.")

    for line in cfg.LINES:
        entry = payload["lines"].get(line.line_id)
        q = quotes[line.yahoo_ticker]
        if entry is None:
            continue                                     # a new line needs a --full run first
        if "error" in q:
            entry["status"] = "error"
            entry["status_note"] = f"Latest quote unavailable; showing prices saved at {fmt_stamp(existing['generated_at'])}"
            continue
        closes, dividends, last_traded = frame_to_series(q["bars"], today)
        skip = excluded_dates_for(line.yahoo_ticker)
        entry["history"] = trim_history(merge_points(entry["history"], closes, skip), start)
        entry["dividends"] = trim_history(merge_points(entry["dividends"], dividends), start)
        entry["history_start"] = entry["history"][0][0] if entry["history"] else None
        entry["last_price"] = q["last_price"]
        entry["previous_close"] = q["previous_close"] or entry.get("previous_close")
        entry["last_trade_time"] = iso_utc(q["time"]) if q["time"] is not None else entry.get("last_trade_time")
        entry["last_trade_date"] = quote_trade_date(q, last_traded or entry.get("last_trade_date"))
        entry["status"], entry["status_note"] = "ok", ""

    for t, pair in fx_tickers.items():
        entry, q = payload["fx"][pair], quotes[t]
        if "error" in q or not fx_in_range(pair, q["last_price"]):
            entry["status"] = "error"
            entry["status_note"] = (f"Latest {pair} unavailable or outside the sanity range; "
                                    f"showing the rate saved at {fmt_stamp(existing['generated_at'])}")
            continue
        closes, _, _ = frame_to_series(q["bars"], today)
        closes, _ = filter_fx(pair, closes)
        entry["history"] = trim_history(merge_points(entry["history"], closes), start)
        entry.update({"last": q["last_price"], "time": iso_utc(q["time"]) if q["time"] is not None else entry.get("time"),
                      "status": "ok", "status_note": ""})
    return finish_payload(payload, now, "quotes-only")


def save_payload(payload, now, mode):
    atomic_write(MARKET_JS, render_js(payload, mode, now))
    SNAPSHOTS.mkdir(parents=True, exist_ok=True)
    snap = SNAPSHOTS / f"{now:%Y-%m-%d_%H%M}.json"
    atomic_write(snap, json.dumps(payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False))
    prune_snapshots(SNAPSHOTS, cfg.SNAPSHOTS_KEPT)


def write_excluded_log(rows, now):
    cols = ["line_id", "yahoo_ticker", "date", "removed_close", "date_before", "close_before",
            "date_after", "close_after", "reason"]
    comments = ["# GENERATED FILE: do not edit by hand.",
                "# What: prices removed from the Yahoo history as known errors (market_config.EXCLUDED_PRICE_DAYS)",
                "#       and FX values outside the sanity ranges.",
                f"# Produced by: scripts/fetch_market_data.py --full, {fmt_stamp(now)}"]
    atomic_write(EXCLUDED_LOG, csv_text(comments, cols, rows))


def report_mode(mode):
    """On GitHub, tell the next workflow step which download ran (a full one is saved to the repository)."""
    out = os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a", encoding="utf-8") as f:
            f.write(f"mode={mode}\n")


# =============================================================================
# Year-end prices (SPEC §6.8): written to the YE_Prices sheet of the workbook
# =============================================================================

def year_end_rows(year, frames, lines, now):
    """New YE_Prices rows from downloaded Dec/Jan tables. Returns (rows, missing line_ids, FX closes by pair)."""
    fx_tickers = {pair: v[0] for pair, v in cfg.FX.items()}
    fetched = fmt_date(now)
    fx_closes = {}
    for pair, t in fx_tickers.items():
        closes, _, _ = frame_to_series(frames.get(t), f"{year + 1}-01-08")
        fx_closes[pair], _ = filter_fx(pair, closes)

    new, missing = [], []
    for line in lines:
        f = frames.get(line.yahoo_ticker)
        rows = []
        if f is not None:
            for d, r in f.iterrows():
                if pd.notna(r["Close"]):
                    rows.append([pd.Timestamp(d).strftime("%Y-%m-%d"), round(float(r["Close"]), 4),
                                 float(r["Volume"]) if pd.notna(r.get("Volume")) else 0.0])
        close_date, close = year_end_pick(rows, year, excluded_dates_for(line.yahoo_ticker))
        if close is None:
            missing.append(line.line_id)
            new.append({"line_id": line.line_id, "year": year, "close": None, "close_date": None, "usd_fx": None,
                        "source": f"No {year} price on Yahoo Finance for {line.yahoo_ticker} (checked {fetched})",
                        "locked": "N"})
            continue
        pair = cfg.FX_FOR_CURRENCY[line.currency]
        fx_date, fx = (close_date, 1.0) if pair is None else fx_on_or_before(fx_closes[pair], close_date)
        source = (f"Yahoo Finance {line.yahoo_ticker} close {close_date}"
                  + ("" if pair is None else f"; {pair} ({fx_tickers[pair]}) close {fx_date}")
                  + f"; fetched {fetched}")
        new.append({"line_id": line.line_id, "year": year, "close": close, "close_date": close_date,
                    "usd_fx": fx, "source": source, "locked": "Y" if fx is not None else "N"})
    return new, missing, fx_closes


def write_year_end(workbook, new, force, reason):
    """Merge new rows into YE_Prices, keeping locked rows unless force. Returns the locked keys that were kept."""
    import workbook_io as wio
    wb = wio.open_for_edit(workbook)
    if "YE_Prices" not in wb.sheetnames:
        raise wio.WorkbookError("The workbook has no 'YE_Prices' sheet. Restore it (sheets must not be renamed) and run again.")
    ws = wb["YE_Prices"]
    cols = wio.header_columns(ws)
    missing_cols = [c for c in YE_COLUMNS if c not in cols]
    if missing_cols:
        raise wio.WorkbookError(f"YE_Prices is missing the column(s) {', '.join(missing_cols)}. Restore the headers and run again.")
    existing = []
    for r in range(2, ws.max_row + 1):
        row = {c: ws.cell(r, cols[c]).value for c in YE_COLUMNS}
        if any(v not in (None, "") for v in row.values()):
            existing.append(row)
    rows, kept_locked = merge_year_end(existing, new, force)
    ws.delete_rows(2, ws.max_row)
    for i, r in enumerate(rows, start=2):
        for c in YE_COLUMNS:
            v = r.get(c)
            if c == "close_date" and isinstance(v, str) and v:
                v = pd.Timestamp(v).to_pydatetime()
            if c == "year" and v not in (None, ""):
                v = int(v)
            ws.cell(i, cols[c], None if v == "" else v)
    wio.save_workbook(wb, workbook, reason)
    return kept_locked


def seed_year_end(year, force, now, workbook=None):
    import workbook_io as wio
    import workbook_schema as S
    workbook = workbook or S.WORKBOOK
    wio.ensure_writable(workbook)                 # before any download: tell Juan to close Excel first
    fx_tickers = [v[0] for v in cfg.FX.values()]
    lines = cfg.LINES
    frames = download_history([l.yahoo_ticker for l in lines] + fx_tickers, f"{year}-12-01", f"{year + 1}-01-08")
    new, missing, fx_closes = year_end_rows(year, frames, lines, now)
    kept_locked = write_year_end(workbook, new, force, f"seed_year_end_{year}")
    return new, missing, kept_locked, fx_closes


# =============================================================================
# Command line
# =============================================================================

def main(argv=None):
    parser = argparse.ArgumentParser(description="Download market data for the Colombia Strategy Dashboard.")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--full", action="store_true", help="5 years of history, dividends, quotes and FX")
    mode.add_argument("--quotes-only", action="store_true", help="latest quotes and FX only")
    mode.add_argument("--seed-year-end", type=int, metavar="YEAR", help="save the last close of YEAR and the FX on that date")
    parser.add_argument("--force", action="store_true", help="with --seed-year-end: overwrite locked rows")
    args = parser.parse_args(argv)
    if args.force and args.seed_year_end is None:
        parser.error("--force only works together with --seed-year-end")

    logging.getLogger("yfinance").setLevel(logging.CRITICAL)   # its own messages would only confuse
    try:
        now = now_bogota()
        if args.seed_year_end is not None:
            year = args.seed_year_end
            new, missing, kept_locked, fx_closes = seed_year_end(year, args.force, now)
            captured = [r for r in new if r["close"] is not None]
            print(f"Year-end {year}: captured closing prices for {len(captured)} of {len(cfg.LINES)} lines."
                  + (f" No {year} price for: {', '.join(missing)}." if missing else ""))
            used = {}
            for line, r in zip(cfg.LINES, new):
                pair = cfg.FX_FOR_CURRENCY[line.currency]
                if pair and r["usd_fx"] is not None:
                    used.setdefault((pair, r["usd_fx"], r["close_date"]), []).append(line.line_id)
            print("FX used (the rate on each line's last trading day): " + " · ".join(
                f"{pair} {v:,.4f} on {fmt_date(d)} ({len(ids)} line{'s' if len(ids) > 1 else ''})"
                for (pair, v, d), ids in sorted(used.items())) + ".")
            print((f"Kept {len(kept_locked)} locked row(s) unchanged (use --force to overwrite). " if kept_locked else "")
                  + "Saved to the YE_Prices sheet of inputs\\BTG_Colombia_Inputs.xlsx.")
            return 0

        full = args.full
        if not full:
            reason = needs_full(load_existing(), cfg.LINES, now)
            if reason:
                print(f"Downloading the full history instead of just the latest prices, because {reason}.")
                full = True
        if full:
            payload, excluded_log = build_full(now)
            save_payload(payload, now, "full")
            write_excluded_log(excluded_log, now)
        else:
            payload = build_quotes_only(now)
            save_payload(payload, now, "quotes-only")
            excluded_log = None
        report_mode("full" if full else "quotes-only")

        lines = payload["lines"]
        ok = [k for k, v in lines.items() if v["status"] == "ok"]
        stale = [f"{k} (last trade {fmt_date(v['last_trade_date'])})" for k, v in lines.items() if v["status"] == "stale"]
        errors = [k for k, v in lines.items() if v["status"] == "error"]
        as_of = fmt_stamp(payload["prices_as_of"]) if payload["prices_as_of"] else "unknown"
        print(f"Prices: {len(ok) + len(stale)} of {len(cfg.LINES)} lines updated (latest quote {as_of})."
              + (f" Stale: {', '.join(stale)}." if stale else "")
              + (f" Failed: {', '.join(errors)} (previous data kept)." if errors else ""))
        print("FX: " + " · ".join(
            (f"{pair} {f['last']:,.4f}" if f["last"] is not None else f"{pair} unavailable")
            + ("" if f["status"] == "ok" else f" ({f['status_note']})")
            for pair, f in payload["fx"].items()) + ".")
        extra = ""
        if excluded_log is not None:
            n_days = len({r["date"] for r in excluded_log})
            extra = (f" {len(excluded_log)} known-bad prices on {n_days} day(s) removed "
                     f"(listed in {EXCLUDED_LOG.relative_to(PROJECT)}).")
        print(f"Saved to {MARKET_JS.relative_to(PROJECT)}.{extra}")
        return 0
    except MarketDataError as exc:
        print(f"{exc} The saved data was not changed.")
        if exc.detail:
            print(f"(Technical detail, only needed if you ask for help: {exc.detail})")
        return 1
    except Exception as exc:
        wio = sys.modules.get("workbook_io")        # not present on GitHub, where there is no workbook
        if isinstance(exc, cfg.ConfigError) or (wio and isinstance(exc, wio.WorkbookError)):
            print(exc)
            return 1
        raise


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(main())

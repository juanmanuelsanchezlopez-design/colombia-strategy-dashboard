"""
market_config.py — share lines and market-data settings for the Colombia Strategy Dashboard.

Since Stage 2 the share lines come from the Coverage and Companies sheets of
inputs/BTG_Colombia_Inputs.xlsx, and history_years, stale_after_business_days and
timezone from its Config sheet. They are read the first time a script asks for them.

The website copy on GitHub has no workbook (it stays on Juan's computer). There the same
lines and settings are read from the published site/data/btg_data.js (DECISIONS D21).

What stays here (not Juan's data): FX sanity ranges and known-bad Yahoo price days.
"""

import json
from collections import namedtuple

import workbook_schema as S

PUBLISHED_DATA = S.PROJECT / "site" / "data" / "btg_data.js"
PUBLISHED_PREFIX = "window.BTG_DATA = "

Line = namedtuple("Line", "company_id company sector line_id yahoo_ticker currency primary")

# SPEC §7.1: FX pairs, Yahoo ticker, and the sanity range a rate must fall in to be used.
FX = {
    "USDCOP": ("COP=X", 3000.0, 6000.0),
    "USDCAD": ("CAD=X", 1.0, 2.0),
}

# Which FX pair converts each listing currency to US$ (local currency per US$).
FX_FOR_CURRENCY = {"COP": "USDCOP", "CAD": "USDCAD", "USD": None}

SNAPSHOTS_KEPT = 30          # SPEC §4: audit/market_snapshots keeps the last 30

# Days whose Yahoo prices are errors and are removed from the history.
# Decided by Juan on 16 Sep 2026 after audit/ticker_verification.md: on both days
# most BVC lines show a 10–26% drop that is fully reversed the next session.
# "applies_to" is a ticker suffix: ".CL" = every BVC line. Dividends are never removed.
EXCLUDED_PRICE_DAYS = [
    # (date,        applies_to, reason)
    ("2024-05-03", ".CL", "Yahoo price error on most BVC lines (reversed next session); excluded by Juan, 16 Sep 2026"),
    ("2025-02-19", ".CL", "Yahoo price error on most BVC lines (reversed next session); excluded by Juan, 16 Sep 2026"),
]


class ConfigError(Exception):
    """A problem in the workbook's Coverage, Companies or Config sheet, in plain language."""


_DEFAULTS = {k: v for k, v, *_ in S.CONFIG_ROWS}
_cache = {}


def _int_setting(config, key):
    value = config.get(key, _DEFAULTS[key])
    try:
        return int(value)
    except (TypeError, ValueError):
        raise ConfigError(f"Config {key} is '{value}', which is not a whole number. Fix it in the workbook and run again.")


def _load_published(published):
    """Lines and settings from the published website data (used where there is no workbook)."""
    try:
        text = published.read_text(encoding="utf-8")
        data = json.loads(text[text.index(PUBLISHED_PREFIX) + len(PUBLISHED_PREFIX):].strip().rstrip(";"))
        companies = {c["company_id"]: c for c in data["companies"]}
        lines = [Line(l["company_id"], companies[l["company_id"]]["company_name"], companies[l["company_id"]]["sector"],
                      str(l["line_id"]), str(l["yahoo_ticker"]), l["listing_currency"], l.get("primary_line") == "Y")
                 for l in data["lines"]]
        config = data["config"]
    except (OSError, ValueError, KeyError, TypeError) as exc:
        raise ConfigError(f"The website data file {published.name} could not be read, so the share lines are unknown. "
                          f"Publish the website again. Detail: {exc}")
    return dict(
        LINES=lines,
        HISTORY_YEARS=_int_setting(config, "history_years"),
        STALE_AFTER_BUSINESS_DAYS=_int_setting(config, "stale_after_business_days"),
        TIMEZONE=config.get("timezone") or _DEFAULTS["timezone"],
    )


def load(workbook=S.WORKBOOK, published=PUBLISHED_DATA):
    """Read lines and settings from the workbook (once per run), or from the published data without one."""
    if _cache:
        return _cache
    if not workbook.exists() and published.exists():
        _cache.update(_load_published(published))
        return _cache
    import workbook_io as wio
    if not workbook.exists():
        raise ConfigError(f"The input workbook {wio.rel(workbook)} was not found, so the share lines are unknown.")
    book = wio.read_workbook(workbook)
    for sheet in ("Config", "Companies", "Coverage"):
        if sheet not in book.sheets:
            raise ConfigError(f"The workbook has no '{sheet}' sheet. Restore it (sheets must not be renamed) and run again.")
    config = {r.values.get("key"): r.values.get("value") for r in book.sheets["Config"].rows}
    companies = {r.values.get("company_id"): r.values for r in book.sheets["Companies"].rows}
    lines = []
    for r in book.sheets["Coverage"].rows:
        v = r.values
        where = f"Coverage row {r.number}"
        if not v.get("line_id") or not v.get("yahoo_ticker"):
            raise ConfigError(f"{where} has no line_id or yahoo_ticker. Fill it in (or delete the row) and run again.")
        if v.get("listing_currency") not in S.CURRENCIES:
            raise ConfigError(f"{where} ({v['line_id']}) has listing_currency '{v.get('listing_currency')}'. "
                              f"Use one of {', '.join(S.CURRENCIES)} and run again.")
        company = companies.get(v.get("company_id"))
        if company is None:
            raise ConfigError(f"{where} ({v['line_id']}) uses company_id '{v.get('company_id')}', which is not in the "
                              "Companies sheet. Fix it and run again.")
        lines.append(Line(v["company_id"], company.get("company_name"), company.get("sector"), str(v["line_id"]),
                          str(v["yahoo_ticker"]), v["listing_currency"], v.get("primary_line") == "Y"))
    _cache.update(
        LINES=lines,
        HISTORY_YEARS=_int_setting(config, "history_years"),
        STALE_AFTER_BUSINESS_DAYS=_int_setting(config, "stale_after_business_days"),
        TIMEZONE=config.get("timezone") or _DEFAULTS["timezone"],
    )
    return _cache


def __getattr__(name):
    if name in ("LINES", "HISTORY_YEARS", "STALE_AFTER_BUSINESS_DAYS", "TIMEZONE"):
        if name != "LINES" and not S.WORKBOOK.exists() and not PUBLISHED_DATA.exists():
            return {"HISTORY_YEARS": _DEFAULTS["history_years"], "TIMEZONE": _DEFAULTS["timezone"],
                    "STALE_AFTER_BUSINESS_DAYS": _DEFAULTS["stale_after_business_days"]}[name]
        return load()[name]
    raise AttributeError(name)

"""
workbook_schema.py — the single definition of inputs/BTG_Colombia_Inputs.xlsx (SPEC §6).

Every script that creates, reads, checks or writes the workbook uses this file:
sheet names and order, exact column headers, which columns are numbers, dates or
dropdowns, the allowed values, and the colours. Change the workbook's layout here
and nowhere else.
"""

import re
from collections import namedtuple
from pathlib import Path

PROJECT = Path(__file__).resolve().parent.parent
WORKBOOK = PROJECT / "inputs" / "BTG_Colombia_Inputs.xlsx"

# ---- colours (SPEC §6 conventions) -------------------------------------------
BLUE_FONT = "0000FF"        # input: Juan types here
GREY_FILL = "D9D9D9"        # filled automatically: don't type here
YELLOW_FILL = "FFEB9C"      # placeholder: to be replaced by BTG data
HEADER_FILL = "002060"      # BTG navy (docs/DESIGN_NOTES.md, --navy)
HEADER_FONT = "FFFFFF"

# ---- allowed values ---------------------------------------------------------------
CURRENCIES = ["COP", "USD", "CAD"]
FIN_UNITS = ["COP_bn", "USD_mn", "CAD_mn"]
FIN_UNIT_SCALE = {"COP_bn": ("COP", 1e9), "USD_mn": ("USD", 1e6), "CAD_mn": ("CAD", 1e6)}
PROFILES = ["FINANCIAL", "NON_FINANCIAL"]
EXCHANGES = ["BVC", "NYSE", "TSX"]
SHARE_CLASSES = ["ORD", "PREF", "COMMON"]
YES_NO = ["Y", "N"]
RATINGS = ["Buy", "Neutral", "Sell", "TBD"]
RATING_TP_SOURCES = ["BTG", "PLACEHOLDER"]
SHARES_SOURCES = ["COMPANY_FILING", "BTG", "YAHOO_PLACEHOLDER"]
VALUE_SOURCES = ["BTG", "YAHOO_PLACEHOLDER"]               # Estimates and DPS rows
METRICS = ["NET_INCOME", "EQUITY", "EBITDA", "NET_DEBT", "MINORITIES", "ROE_PCT"]
REQUIRED_METRICS = {
    "FINANCIAL": ["NET_INCOME", "EQUITY", "ROE_PCT"],
    "NON_FINANCIAL": ["NET_INCOME", "EQUITY", "EBITDA", "NET_DEBT", "ROE_PCT"],
}
ROWS_FOR_PROFILE = {                                       # Estimates rows created per company
    "FINANCIAL": ["NET_INCOME", "EQUITY", "ROE_PCT"],
    "NON_FINANCIAL": ["NET_INCOME", "EQUITY", "EBITDA", "NET_DEBT", "MINORITIES", "ROE_PCT"],
}
INVESTOR_TYPES = [          # SPEC §6.10: id, chart label, table label
    ("PENSION", "Pension Funds", "Pension Funds"),
    ("FOREIGN", "Foreigners + ADRs", "Foreign Funds"),
    ("RETAIL", "Retail", "Retail Investors"),
    ("BROKERS", "Brokers", "Brokers"),
    ("MUTUAL", "Mutual Funds", "Mutual Funds & Trusts"),
    ("CORPORATE", "Corporate", "Corporates"),
    ("OTHERS", "", "Others"),                               # not charted
]
INVESTOR_IDS = [t[0] for t in INVESTOR_TYPES]
ALLOCATION_SECTORS = ["CEMENT_CONSTRUCTION", "FINANCIALS", "OG", "OTHERS", "RETAIL", "UTILITIES", "ETF"]
FLOW_SOURCES = ["BTG", "DUMMY"]
WINDOWS = ["M", "L3M", "L6M", "L12M"]
SIDES = ["BUY", "SELL"]
PRICE_BASES = ["year_end", "current"]
SHARE_DISPLAY_MODES = ["primary_only", "all_lines"]
AUDIT_TOOLTIPS = ["local_only", "off"]

# ---- columns ----------------------------------------------------------------------
# kind: text | id | int | number | date | month | enum | yn | email | year_values
# ref:  another sheet whose key column the value must exist in
# list: name of an allowed-values list (a _Lists column) for a dropdown
# auto: True = filled by scripts (grey), False = typed by Juan (blue)
Col = namedtuple("Col", "name kind required list ref width fmt note")


def col(name, kind="text", required=False, list=None, ref=None, width=14, fmt=None, note=None):
    return Col(name, kind, required, list, ref, width, fmt, note)


YEAR_COLUMNS = "year_values"    # marker: one or more year columns (2025, 2026E, ...) go here

SHEETS = {
    "README": {"columns": [col("guide", width=120)], "key": None, "readme": True},
    "Config": {
        "columns": [col("key", "id", True, width=30), col("value", width=46), col("explanation", width=90)],
        "key": ["key"], "freeze": "B2",
    },
    "Analysts": {
        "columns": [col("order", "int", True, width=8), col("name", required=True, width=28),
                    col("email", "email", True, width=36)],
        "key": ["order"], "freeze": "A2",
    },
    "Companies": {
        "columns": [
            col("company_id", "id", True, width=14),
            col("company_name", required=True, width=24),
            col("sector", "enum", True, list="sector", width=20, note="Must be one of the sectors in Config sector_order."),
            col("reporting_currency", "enum", True, list="currency", width=12),
            col("fin_unit", "enum", True, list="fin_unit", width=10,
                note="Unit of this company's Estimates: COP_bn = COP billions, USD_mn = US$ millions, CAD_mn = CAD millions."),
            col("metrics_profile", "enum", True, list="metrics_profile", width=16,
                note="FINANCIAL companies show '–' for EV/EBITDA and Net debt/EBITDA."),
            col("sort_order", "int", True, width=10),
            col("notes", width=50, note="Internal only: never published on the website."),
        ],
        "key": ["company_id"], "freeze": "B2",
    },
    "Coverage": {
        "columns": [
            col("line_id", "id", True, width=13, note="BVC nemo, or the exchange ticker for non-BVC lines."),
            col("company_id", "id", True, ref="Companies", list="company_id", width=13),
            col("display_label", required=True, width=24),
            col("exchange", "enum", True, list="exchange", width=9),
            col("yahoo_ticker", required=True, width=14),
            col("yahoo_old_ticker", width=14, note="Optional. Only to join price history across a ticker change, and only after Juan approves it."),
            col("listing_currency", "enum", True, list="currency", width=10),
            col("share_class", "enum", True, list="share_class", width=9),
            col("primary_line", "yn", True, list="yes_no", width=9, note="Exactly one Y per company."),
            col("shares_mn", "number", width=12, fmt="#,##0.000", note="Shares outstanding for THIS class, in millions."),
            col("shares_as_of", "date", width=13, fmt="dd mmm yyyy"),
            col("shares_source", "enum", list="shares_source", width=18),
            col("rating", "enum", True, list="rating", width=9),
            col("target_price", "number", width=13, fmt="#,##0.00", note="In the listing currency. Blank = TBD."),
            col("tp_date", "date", width=13, fmt="dd mmm yyyy"),
            col("rating_tp_source", "enum", True, list="rating_tp_source", width=14),
            col("notes", width=50, note="Internal only: never published on the website."),
        ],
        "key": ["line_id"], "freeze": "B2",
    },
    "Estimates": {
        "columns": [
            col("company_id", "id", True, ref="Companies", list="company_id", width=13),
            col("metric", "enum", True, list="metric", width=13),
            YEAR_COLUMNS,
            col("source", "enum", list="value_source", width=18, note="Applies to the whole row: BTG or YAHOO_PLACEHOLDER."),
            col("last_updated", "date", width=13, fmt="dd mmm yyyy"),
            col("notes", width=50, note="Internal only: never published on the website."),
        ],
        "key": ["company_id", "metric"], "freeze": "C2",
        "year_fmt": "#,##0.0",
        "year_note": "In the company's fin_unit (Companies sheet). ROE_PCT as a percentage, e.g. 15.6.",
    },
    "DPS": {
        "columns": [
            col("line_id", "id", True, ref="Coverage", list="line_id", width=13),
            YEAR_COLUMNS,
            col("source", "enum", list="value_source", width=18),
            col("last_updated", "date", width=13, fmt="dd mmm yyyy"),
            col("notes", width=50, note="Internal only: never published on the website."),
        ],
        "key": ["line_id"], "freeze": "B2",
        "year_fmt": "#,##0.00",
        "year_note": "Dividend per share in the listing currency, by the year it is PAID.",
    },
    "YE_Prices": {
        "columns": [
            col("line_id", "id", True, ref="Coverage", width=13),
            col("year", "int", True, width=7),
            col("close", "number", width=12, fmt="#,##0.00"),
            col("close_date", "date", width=13, fmt="dd mmm yyyy"),
            col("usd_fx", "number", width=12, fmt="#,##0.0000", note="Listing currency per US$ on close_date (1 for US$ lines)."),
            col("source", width=70),
            col("locked", "yn", True, list="yes_no", width=8, note="Y = never overwritten unless fetch_market_data.py --seed-year-end YEAR --force."),
        ],
        "key": ["line_id", "year"], "freeze": "B2", "auto": True,
    },
    "Dividends_Override": {
        "columns": [
            col("line_id", "id", True, ref="Coverage", list="line_id", width=13),
            col("ex_date", "date", True, width=13, fmt="dd mmm yyyy"),
            col("amount", "number", True, width=12, fmt="#,##0.0000"),
            col("currency", "enum", True, list="currency", width=10),
            col("note", width=60, note="Internal only: never published on the website."),
        ],
        "key": ["line_id", "ex_date"], "freeze": "B2",
    },
    "Flows_Monthly": {
        "columns": [col("month", "month", True, width=10, note="YYYY-MM, e.g. 2026-08.")]
                   + [col(i, "number", width=11, fmt="#,##0.0") for i in INVESTOR_IDS]
                   + [col("source", "enum", True, list="flow_source", width=10), col("notes", width=50)],
        "key": ["month"], "freeze": "B2",
        # Annual totals are calculated from these months (Juan, 16 Sep 2026: no Flows_Annual sheet).
    },
    "Flows_Allocation": {
        "columns": [col("month", "month", True, width=10), col("investor_type", "enum", True, list="investor_type", width=13)]
                   + [col(s, "number", width=12, fmt="#,##0.0") for s in ALLOCATION_SECTORS],
        "key": ["month", "investor_type"], "freeze": "C2",
    },
    "Flows_BySecurity": {
        "columns": [col("month", "month", True, width=10), col("nemo", "id", True, list="nemo", width=13)]
                   + [col(i, "number", width=11, fmt="#,##0.00") for i in INVESTOR_IDS],
        "key": ["month", "nemo"], "freeze": "C2",
    },
    "Flows_SecurityMap": {
        "columns": [
            col("nemo", "id", True, width=13),
            col("display_name", required=True, width=28),
            col("allocation_sector", "enum", True, list="allocation_sector", width=22),
            col("company_id", "id", ref="Companies", list="company_id", width=13, note="Optional."),
            col("include_in_top5", "yn", True, list="yes_no", width=10),
            col("notes", width=60),
        ],
        "key": ["nemo"], "freeze": "B2",
    },
    "Flows_Top5_Override": {
        "columns": [
            col("month", "month", True, width=10),
            col("window", "enum", True, list="window", width=8),
            col("investor_type", "enum", True, list="investor_type", width=13),
            col("side", "enum", True, list="side", width=7),
            col("rank", "int", True, width=6),
            col("nemo", "id", True, width=13),
            col("usd_mn", "number", True, width=10, fmt="#,##0.0"),
        ],
        "key": ["month", "window", "investor_type", "side", "rank"], "freeze": "B2",
    },
    "Changelog": {
        "columns": [col("date", "date", True, width=13, fmt="dd mmm yyyy"), col("editor", width=22),
                    col("sheet", list="sheet", width=20), col("what_changed", width=60), col("source_reason", width=50)],
        "key": None, "freeze": "A2",
    },
    "_Lists": {"columns": None, "key": None, "hidden": True},
}
SHEET_ORDER = list(SHEETS)

# _Lists columns (dropdown values). company_id, line_id and nemo point at live sheet ranges instead.
LISTS = {
    "sector": ["Financials", "O&G", "Utilities", "Building Materials", "Retail"],
    "currency": CURRENCIES,
    "fin_unit": FIN_UNITS,
    "metrics_profile": PROFILES,
    "exchange": EXCHANGES,
    "share_class": SHARE_CLASSES,
    "yes_no": YES_NO,
    "rating": RATINGS,
    "rating_tp_source": RATING_TP_SOURCES,
    "shares_source": SHARES_SOURCES,
    "value_source": VALUE_SOURCES,
    "metric": METRICS,
    "investor_type": INVESTOR_IDS,
    "investor_chart_label": [t[1] for t in INVESTOR_TYPES],
    "investor_table_label": [t[2] for t in INVESTOR_TYPES],
    "allocation_sector": ALLOCATION_SECTORS,
    "flow_source": FLOW_SOURCES,
    "window": WINDOWS,
    "side": SIDES,
    "historical_price_basis": PRICE_BASES,
    "share_display_mode": SHARE_DISPLAY_MODES,
    "audit_tooltips": AUDIT_TOOLTIPS,
    "sheet": [s for s in SHEET_ORDER if s not in ("README", "_Lists")],
}
LIVE_LISTS = {"company_id": ("Companies", "A"), "line_id": ("Coverage", "A"), "nemo": ("Flows_SecurityMap", "A")}

# ---- Config (SPEC §6.2, plus go-live confirmations for the SPEC §11 checklist) ----
# key, default, kind, allowed list (dropdown), explanation
CONFIG_ROWS = [
    ("site_title", "Colombia Strategy Dashboard", "text", None, "Title in the sidebar and browser tab."),
    ("research_portal_url", "https://www.btgpactual.com/research/latest-documents", "text", None,
     "Where the BTG Pactual logo links to (opens in a new tab)."),
    ("actual_year", 2025, "int", None,
     "The frozen year. Its multiples use year-end prices (YE_Prices). Change only during the year roll (see README)."),
    ("estimate_years", "2026, 2027", "years", None, "Estimate columns shown on the website, comma-separated."),
    ("dps_display_year", 2026, "int", None, "Which DPS year the Stock Information tab shows."),
    ("historical_price_basis", "year_end", "enum", "historical_price_basis",
     "year_end = actual-year multiples use year-end prices (frozen); current = use the live price."),
    ("mcap_local_unit", "COP_tn, 1 decimal", "text", None, "Local market cap display unit."),
    ("mcap_usd_unit", "USD_mn, 0 decimals", "text", None, "US$ market cap display unit."),
    ("history_years", 5, "int", None, "Years of daily price history kept for the performance tab."),
    ("stale_after_business_days", 1, "int", None, "A price older than this many business days is flagged as stale."),
    ("tp_age_warning_days", 180, "int", None, "The validation report warns when a target price is older than this."),
    ("share_display_mode", "primary_only", "enum", "share_display_mode",
     "primary_only or all_lines (visitors can also toggle this on the site)."),
    ("sector_order", "Financials, O&G, Utilities, Building Materials, Retail", "list", None,
     "Sector order on the website, comma-separated. Companies must use these names."),
    ("timezone", "America/Bogota", "text", None, "All times on the site are shown in this time zone."),
    ("website_repository", None, "github_repo", None,
     "Address of the GitHub repository the website is published to, e.g. https://github.com/your-name/colombia-strategy-dashboard. "
     "Blank until it is set up (README, Putting the website online)."),
    ("audit_tooltips", "local_only", "enum", "audit_tooltips",
     "local_only = formula tooltips only when served from this computer; off = never."),
    ("disclaimer_text", "[PENDING — COMPLIANCE-APPROVED TEXT]", "text", None, "Footer disclaimer. Replace with compliance-approved text."),
    ("golive_disclaimer_approved", "N", "yn", "yes_no", "Go-live checklist: Y once compliance has approved the disclaimer text above."),
    ("golive_yahoo_display_signoff", "N", "yn", "yes_no", "Go-live checklist: Y once compliance signs off on showing Yahoo Finance data publicly."),
    ("golive_estimates_exposure_ack", "N", "yn", "yes_no",
     "Go-live checklist: Y once compliance knows the site's data file exposes the underlying estimates to anyone viewing the page source."),
    ("golive_hosted_price_service_live", "N", "yn", "yes_no", "Go-live checklist: Y once the hosted price service (SPEC §16) is live."),
    ("golive_spot_check_done", "N", "yn", "yes_no",
     "Go-live checklist: Y once the site has been spot-checked against the latest Valuation Snapshot and Equity Flows note."),
]
CONFIG_KEYS = [r[0] for r in CONFIG_ROWS]

# website_repository must look like this (group 1 = owner, group 2 = repository name).
GITHUB_REPOSITORY = re.compile(r"^https://github\.com/([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)/([A-Za-z0-9._-]+?)(?:\.git)?/?$")


def fixed_headers(sheet):
    """Headers before and after the year columns: (before, after). For sheets without year columns, after = []."""
    cols = SHEETS[sheet]["columns"]
    if YEAR_COLUMNS in cols:
        i = cols.index(YEAR_COLUMNS)
        return [c.name for c in cols[:i]], [c.name for c in cols[i + 1:]]
    return [c.name for c in cols], []


def column_defs(sheet, year_headers=()):
    """The Col list with the year columns expanded."""
    out = []
    spec = SHEETS[sheet]
    for c in spec["columns"]:
        if c == YEAR_COLUMNS:
            out += [col(h, "number", width=11, fmt=spec["year_fmt"], note=spec["year_note"]) for h in year_headers]
        else:
            out.append(c)
    return out


def year_label(year, actual_year):
    return str(year) if year <= actual_year else f"{year}E"

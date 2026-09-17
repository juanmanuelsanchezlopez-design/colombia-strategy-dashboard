/* =============================================================================
   calc.js — every number the dashboard displays is calculated here (SPEC §0.4, §8).

   Pure functions: plain numbers in, results out. No page access, no formatting
   (format.js), no data loading (app.js). Each function states its formula in words.

   Every result is an object { status, value, ... }:
     "ok"    value is a number
     "na"    an input is missing                  -> shown as "n.a."
     "nm"    not meaningful (price or denominator <= 0) -> shown as "n.m."
     "none"  nothing to show (e.g. no target price) -> shown as "–"

   Works in the browser (window.Calc) and in Node for the tests (require).
   Stage 3 covers SPEC §8.1 (market cap) and §8.4 (upside, DPS).
   ============================================================================= */
(function (root, factory) {
  var Calc = factory();
  if (typeof module === 'object' && module.exports) { module.exports = Calc; } else { root.Calc = Calc; }
}(this, function () {
  'use strict';

  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function ok(value, extra) { return Object.assign({ status: 'ok', value: value }, extra || {}); }
  function na(reason, extra) { return Object.assign({ status: 'na', value: null, reason: reason }, extra || {}); }
  function nm(reason, extra) { return Object.assign({ status: 'nm', value: null, reason: reason }, extra || {}); }
  function none(reason) { return { status: 'none', value: null, reason: reason }; }

  /* Local currency units per US$ for a currency.
     US$ = 1; COP = live USD/COP; CAD = live USD/CAD. Returns null when the rate is missing. */
  function perUsd(currency, fx) {
    if (currency === 'USD') { return 1; }
    var rate = currency === 'COP' ? fx && fx.USDCOP : currency === 'CAD' ? fx && fx.USDCAD : null;
    return isNum(rate) && rate > 0 ? rate : null;
  }

  /* Convert an amount from one currency to another through the US$.
     amount ÷ (from-currency per US$) × (to-currency per US$). */
  function convert(amount, from, to, fx) {
    if (!isNum(amount)) { return na('amount missing'); }
    var a = perUsd(from, fx), b = perUsd(to, fx);
    if (a === null) { return na('no US$/' + from + ' rate'); }
    if (b === null) { return na('no US$/' + to + ' rate'); }
    return ok(amount / a * b);
  }

  /* Market value of one share line, in its listing currency.
     price × shares outstanding (shares_mn × 1,000,000). */
  function lineMarketCap(price, sharesMn) {
    if (!isNum(price)) { return na('no price'); }
    if (!isNum(sharesMn)) { return na('no share count'); }
    if (price <= 0 || sharesMn <= 0) { return nm('price or share count is not positive'); }
    return ok(price * sharesMn * 1e6);
  }

  /* SPEC §8.1 — company market cap.
     Add up price × shares over ALL the company's share lines (not only the displayed one),
     each converted to US$ at live FX. Mkt cap (US$mn) = US$ total ÷ 10^6;
     Mkt cap (COP tn) = US$ total × live USD/COP ÷ 10^12 (GeoPark and Parex included).
     lines: [{ line_id, currency, price, shares_mn, shares_placeholder }]
     If any line lacks a price or share count the company total is n.a. (a partial sum would understate it).
     Also returns parts (for the audit tooltip), missing lines, and placeholder = a share count is from Yahoo. */
  function companyMarketCap(lines, fx) {
    var parts = [], missing = [], totalUsd = 0, placeholder = false, i;
    if (!lines || !lines.length) { return na('no share lines', { parts: parts, missing: missing, placeholder: false }); }
    for (i = 0; i < lines.length; i++) {
      var l = lines[i];
      var local = lineMarketCap(l.price, l.shares_mn);
      if (local.status !== 'ok') { missing.push({ line_id: l.line_id, reason: local.reason }); continue; }
      var usd = convert(local.value, l.currency, 'USD', fx);
      if (usd.status !== 'ok') { missing.push({ line_id: l.line_id, reason: usd.reason }); continue; }
      if (l.shares_placeholder) { placeholder = true; }
      parts.push({ line_id: l.line_id, currency: l.currency, price: l.price, shares_mn: l.shares_mn,
                   value_local: local.value, value_usd: usd.value });
      totalUsd += usd.value;
    }
    var extra = { parts: parts, missing: missing, placeholder: placeholder };
    if (missing.length) { return na('missing: ' + missing.map(function (m) { return m.line_id + ' (' + m.reason + ')'; }).join(', '), extra); }
    var copPerUsd = perUsd('COP', fx);
    return ok(totalUsd, Object.assign(extra, {
      usd_mn: totalUsd / 1e6,
      cop_tn: copPerUsd === null ? null : totalUsd * copPerUsd / 1e12
    }));
  }

  /* Sector and universe totals: add up the market caps that are available.
     items: [{ name, cap }] where cap is a companyMarketCap result.
     excluded lists the names left out because their market cap is n.a.; placeholder is true if any
     included market cap uses a Yahoo share count. n.a. only if nothing could be added. */
  function totalMarketCap(items, fx) {
    var usd = 0, used = 0, excluded = [], placeholder = false, i;
    for (i = 0; i < (items || []).length; i++) {
      var c = items[i].cap;
      if (c && c.status === 'ok') {
        usd += c.value; used++;
        if (c.placeholder) { placeholder = true; }
      } else {
        excluded.push(items[i].name);
      }
    }
    var extra = { excluded: excluded, placeholder: placeholder, count: used };
    if (!used) { return na('no market cap available', extra); }
    var copPerUsd = perUsd('COP', fx);
    return ok(usd, Object.assign(extra, { usd_mn: usd / 1e6, cop_tn: copPerUsd === null ? null : usd * copPerUsd / 1e12 }));
  }

  /* SPEC §8.4 — upside to the target price.
     target price ÷ price − 1, both in the line's listing currency.
     "none" when there is no target price; n.a. when the price is missing; n.m. when the price is not positive. */
  function upside(targetPrice, price) {
    if (!isNum(targetPrice)) { return none('no target price'); }
    if (!isNum(price)) { return na('no price'); }
    if (price <= 0) { return nm('price is not positive'); }
    return ok(targetPrice / price - 1);
  }

  /* SPEC §8.4 — DPS shown on Stock Information: the value for the display year (dps_display_year),
     listing currency per share. values: { "2026": 1200, ... }. n.a. when blank. */
  function dpsForYear(values, year) {
    var v = values ? values[String(year)] : null;
    return isNum(v) ? ok(v) : na('no DPS for ' + year);
  }

  return {
    perUsd: perUsd,
    convert: convert,
    lineMarketCap: lineMarketCap,
    companyMarketCap: companyMarketCap,
    totalMarketCap: totalMarketCap,
    upside: upside,
    dpsForYear: dpsForYear
  };
}));

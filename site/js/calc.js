/* =============================================================================
   calc.js — every number the dashboard displays is calculated here (SPEC §0.4, §8).

   Pure functions: plain numbers in, results out. No page access, no formatting
   (format.js), no data loading (app.js). Each function states its formula in words.

   Every result is an object { status, value, ... }:
     "ok"    value is a number
     "na"    an input is missing                  -> shown as "n.a."
     "nm"    not meaningful (price or denominator <= 0) -> shown as "n.m."
     "none"  nothing to show (e.g. no target price) -> shown as "–"

   Works in the browser (window.Calc) and in Node for the tests and the publishing checks (require).
   Stage 3: SPEC §8.1 (market cap), §8.4 (upside, DPS). Stage 4: §8.2 (price basis), §8.3 (multiples).
   Stage 5: §8.5 (price and total returns, local and US$).
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
    if (from === to) { return ok(amount); }                // same currency: no FX needed
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

  /* ===========================================================================
     Stage 4 — Valuation Tracker (SPEC §8.2, §8.3, §9.2)
     =========================================================================== */

  /* Companies fin_unit: the reporting currency and how many currency units one reported unit holds. */
  var FIN_UNITS = {
    COP_bn: { currency: 'COP', size: 1e9 },
    USD_mn: { currency: 'USD', size: 1e6 },
    CAD_mn: { currency: 'CAD', size: 1e6 }
  };

  /* SPEC §8.2 — which prices a year's multiples use.
     The actual year uses year-end prices and FX (YE_Prices) when historical_price_basis is "year_end",
     so its multiples never move; estimate years (and the actual year when "current") use live prices and FX. */
  function priceBasis(year, actualYear, historicalBasis) {
    return year === actualYear && historicalBasis === 'year_end' ? 'year_end' : 'live';
  }

  /* SPEC §8.3 — MC_RC: market cap in the company's reporting unit.
     For every share line: price × shares, converted from the listing currency to the reporting currency
     (through the US$; no FX when both are the same currency); add them up; ÷ the unit size
     (COP_bn ÷ 10^9, USD_mn and CAD_mn ÷ 10^6).
     lines: [{ line_id, currency, price, shares_mn, shares_placeholder, price_missing }], where price_missing
     explains a missing price (e.g. "no 2025 year-end price"). n.a. if any line can't be valued. */
  function marketCapReporting(lines, finUnit, fx) {
    var unit = FIN_UNITS[finUnit];
    var parts = [], missing = [], total = 0, placeholder = false, i;
    var extra = function () { return { unit: finUnit, parts: parts, missing: missing, placeholder: placeholder }; };
    if (!unit) { return na('unknown reporting unit ' + finUnit, extra()); }
    if (!lines || !lines.length) { return na('no share lines', extra()); }
    for (i = 0; i < lines.length; i++) {
      var l = lines[i];
      var local = lineMarketCap(l.price, l.shares_mn);
      if (local.status !== 'ok') {
        missing.push({ line_id: l.line_id, reason: l.price === null && l.price_missing ? l.price_missing : local.reason });
        continue;
      }
      var rc = convert(local.value, l.currency, unit.currency, fx);
      if (rc.status !== 'ok') { missing.push({ line_id: l.line_id, reason: rc.reason }); continue; }
      if (l.shares_placeholder) { placeholder = true; }
      parts.push({ line_id: l.line_id, currency: l.currency, price: l.price, shares_mn: l.shares_mn,
                   value_local: local.value, value_rc: rc.value });
      total += rc.value;
    }
    if (missing.length) {
      return na(missing.map(function (m) { return m.line_id + ': ' + m.reason; }).join('; '), extra());
    }
    return ok(total / unit.size, extra());
  }

  /* A multiple or ratio: numerator ÷ denominator.
     n.a. when either is missing; n.m. when the denominator is zero or negative (SPEC §8.3 display rules). */
  function ratio(numerator, denominator, names) {
    names = names || ['numerator', 'denominator'];
    if (!isNum(numerator)) { return na(names[0] + ' missing'); }
    if (!isNum(denominator)) { return na(names[1] + ' missing'); }
    if (denominator <= 0) { return nm(names[1] + ' is zero or negative'); }
    return ok(numerator / denominator);
  }

  /* P/E = MC_RC ÷ net income (controlling). */
  function priceEarnings(mcRc, netIncome) { return ratio(mcRc, netIncome, ['market cap', 'net income']); }

  /* P/BV = MC_RC ÷ equity (controlling, year-end). */
  function priceBook(mcRc, equity) { return ratio(mcRc, equity, ['market cap', 'equity']); }

  /* EV/EBITDA = (MC_RC + net debt + minorities) ÷ EBITDA. Minorities are optional: blank counts as 0.
     Each year uses that year's net debt (SPEC §17, A4). */
  function evEbitda(mcRc, netDebt, minorities, ebitda) {
    if (!isNum(mcRc)) { return na('market cap missing'); }
    if (!isNum(netDebt)) { return na('net debt missing'); }
    return ratio(mcRc + netDebt + (isNum(minorities) ? minorities : 0), ebitda, ['enterprise value', 'EBITDA']);
  }

  /* Net debt/EBITDA = net debt ÷ EBITDA (does not depend on the price). */
  function netDebtEbitda(netDebt, ebitda) { return ratio(netDebt, ebitda, ['net debt', 'EBITDA']); }

  /* ROE is an input (ROE_PCT, e.g. 15.6), not calculated (SPEC §17, A10). Returned as a fraction (0.156). */
  function returnOnEquity(roePct) { return isNum(roePct) ? ok(roePct / 100) : na('ROE missing'); }

  /* Dividend yield (share line) = DPS of the year ÷ price at that year's price basis, both in the listing currency. */
  function dividendYield(dps, price) {
    if (!isNum(dps)) { return na('DPS missing'); }
    if (!isNum(price)) { return na('price missing'); }
    if (price <= 0) { return nm('price is zero or negative'); }
    return ok(dps / price);
  }

  /* SPEC §8.2–8.3, §9.2 — the Valuation Tracker, for every company and year (actual year + estimate years).
     btg = the published BTG data (window.BTG_DATA); market = the market data (window.MARKET_DATA), may be null.
     For each company: its primary share line (rating, live price) and, per year:
       basis ("year_end" | "live"), fx used, mc (MC_RC), inputs (estimates used, with source), and the results
       pe, ev_ebitda, pbv, nd_ebitda, roe, dy. Financials get "none" ("–") for EV/EBITDA and net debt/EBITDA.
     Every ok result carries placeholder = true when any input came from Yahoo (estimates, share counts, DPS).
     Used by the website (tab_valuation.js) and by the publishing checks (scripts/calc_checks.js). */
  function valuation(btg, market) {
    var years = [btg.years.actual].concat(btg.years.estimates);
    var basisSetting = btg.config.historical_price_basis;
    var mLines = (market && market.lines) || {};
    var mFx = (market && market.fx) || {};
    var liveFx = { USDCOP: mFx.USDCOP ? mFx.USDCOP.last : null, USDCAD: mFx.USDCAD ? mFx.USDCAD.last : null };
    var FX_KEY = { COP: 'USDCOP', CAD: 'USDCAD' };

    var linesOf = {}, estimateOf = {}, dpsOf = {}, yearEndOf = {};
    btg.lines.forEach(function (l) { (linesOf[l.company_id] = linesOf[l.company_id] || []).push(l); });
    btg.estimates.forEach(function (e) { estimateOf[e.company_id + '|' + e.metric] = e; });
    btg.dps.forEach(function (d) { dpsOf[d.line_id] = d; });
    (btg.ye_prices || []).forEach(function (r) { yearEndOf[r.line_id + '|' + r.year] = r; });

    function livePrice(lineId) {
      var m = mLines[lineId];
      return m && isNum(m.last_price) ? m.last_price : null;
    }

    function lineInput(l, year, basis) {
      var input = { line_id: l.line_id, currency: l.listing_currency, shares_mn: l.shares_mn,
                    shares_placeholder: l.shares_source === 'YAHOO_PLACEHOLDER', shares_as_of: l.shares_as_of,
                    shares_source: l.shares_source };
      if (basis === 'year_end') {
        var ye = yearEndOf[l.line_id + '|' + year];
        input.price = ye && isNum(ye.close) ? ye.close : null;
        input.price_date = ye ? ye.close_date : null;
        input.price_missing = 'no ' + year + ' year-end price';
      } else {
        var m = mLines[l.line_id];
        input.price = livePrice(l.line_id);
        input.price_time = m ? m.last_trade_time : null;
        input.price_missing = 'no price from Yahoo Finance';
      }
      return input;
    }

    /* Year-end FX: each line's YE_Prices usd_fx is its listing currency per US$ on its closing day. */
    function yearEndFx(lines, year) {
      var fx = {};
      lines.forEach(function (l) {
        var ye = yearEndOf[l.line_id + '|' + year], key = FX_KEY[l.listing_currency];
        if (key && ye && isNum(ye.usd_fx) && !isNum(fx[key])) { fx[key] = ye.usd_fx; fx[key + '_date'] = ye.close_date; }
      });
      return fx;
    }

    function estimate(companyId, metric, year) {
      var row = estimateOf[companyId + '|' + metric];
      var v = row && row.values ? row.values[String(year)] : null;
      return { metric: metric, value: isNum(v) ? v : null, source: row ? row.source : null,
               last_updated: row ? row.last_updated : null,
               placeholder: !!row && row.source === 'YAHOO_PLACEHOLDER' && isNum(v) };
    }

    function tag(result, inputs) {
      if (result.status === 'ok') {
        result.placeholder = inputs.some(function (x) { return x && x.placeholder; });
      }
      return result;
    }

    return {
      years: years,
      companies: btg.companies.map(function (c) {
        var lines = linesOf[c.company_id] || [];
        var primary = lines.filter(function (l) { return l.primary_line === 'Y'; })[0] || lines[0] || null;
        var financial = c.metrics_profile === 'FINANCIAL';
        var byYear = {};
        years.forEach(function (year) {
          var basis = priceBasis(year, btg.years.actual, basisSetting);
          var fx = basis === 'year_end' ? yearEndFx(lines, year) : liveFx;
          var inputs = lines.map(function (l) { return lineInput(l, year, basis); });
          var mc = marketCapReporting(inputs, c.fin_unit, fx);
          var mcValue = mc.status === 'ok' ? mc.value : null;
          var est = {
            NET_INCOME: estimate(c.company_id, 'NET_INCOME', year),
            EQUITY: estimate(c.company_id, 'EQUITY', year),
            EBITDA: estimate(c.company_id, 'EBITDA', year),
            NET_DEBT: estimate(c.company_id, 'NET_DEBT', year),
            MINORITIES: estimate(c.company_id, 'MINORITIES', year),
            ROE_PCT: estimate(c.company_id, 'ROE_PCT', year)
          };
          var primaryInput = primary ? inputs[lines.indexOf(primary)] : null;
          var dpsRow = primary ? dpsOf[primary.line_id] : null;
          var dpsValue = dpsRow && dpsRow.values ? dpsRow.values[String(year)] : null;
          var dps = { value: isNum(dpsValue) ? dpsValue : null, source: dpsRow ? dpsRow.source : null,
                      last_updated: dpsRow ? dpsRow.last_updated : null,
                      placeholder: !!dpsRow && dpsRow.source === 'YAHOO_PLACEHOLDER' && isNum(dpsValue) };
          var notFinancial = function () { return none('not applicable to financials'); };
          byYear[year] = {
            basis: basis, fx: fx, mc: mc, inputs: est, dps: dps, price: primaryInput,
            pe: tag(priceEarnings(mcValue, est.NET_INCOME.value), [mc, est.NET_INCOME]),
            ev_ebitda: financial ? notFinancial()
              : tag(evEbitda(mcValue, est.NET_DEBT.value, est.MINORITIES.value, est.EBITDA.value), [mc, est.NET_DEBT, est.MINORITIES, est.EBITDA]),
            pbv: tag(priceBook(mcValue, est.EQUITY.value), [mc, est.EQUITY]),
            nd_ebitda: financial ? notFinancial() : tag(netDebtEbitda(est.NET_DEBT.value, est.EBITDA.value), [est.NET_DEBT, est.EBITDA]),
            roe: tag(returnOnEquity(est.ROE_PCT.value), [est.ROE_PCT]),
            dy: tag(dividendYield(dps.value, primaryInput ? primaryInput.price : null), [dps])
          };
          if (mc.status !== 'ok') {
            ['pe', 'ev_ebitda', 'pbv'].forEach(function (k) {
              var r = byYear[year][k];
              if (r.status === 'na' && r.reason === 'market cap missing') { r.reason = 'market cap n.a. (' + mc.reason + ')'; }
            });
          }
        });
        return {
          company: c, primary: primary, financial: financial,
          price: primary ? livePrice(primary.line_id) : null,
          market: primary ? mLines[primary.line_id] || null : null,
          byYear: byYear
        };
      })
    };
  }

  /* ===========================================================================
     Stage 5 — Stock Performance (SPEC §8.5, §9.3)
     Dates are "YYYY-MM-DD" strings; series are date-sorted [[date, value], ...].
     =========================================================================== */

  var FX_PAIR = { COP: 'USDCOP', CAD: 'USDCAD' };

  /* Position of the last point on or before date; -1 if the series starts later. */
  function indexOnOrBefore(series, date) {
    var lo = 0, hi = (series || []).length - 1, found = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (series[mid][0] <= date) { found = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    return found;
  }

  /* The point on or before date (a value carried forward over days without one); null if none. */
  function pointOnOrBefore(series, date) {
    var i = indexOnOrBefore(series, date);
    return i < 0 ? null : series[i];
  }

  function isoDate(y, m, d) {                     // month 1-12; day 0 = last day of the previous month
    var t = new Date(Date.UTC(y, m - 1, d));
    return t.toISOString().slice(0, 10);
  }

  /* SPEC §8.5 — the date whose last close (on or before it) starts each period, for the latest session `reference`.
     1D: the day before the session (previous session close; performance() uses each line's own latest session,
     so a line that hasn't traded yet today shows its last session's move, not 0%); MTD: last day of the previous month;
     YTD: 31 Dec of the previous year; 1Y: the same date one year earlier (29 Feb → 28 Feb). */
  function periodStart(period, reference) {
    var y = +reference.slice(0, 4), m = +reference.slice(5, 7), d = +reference.slice(8, 10);
    switch (period) {
      case '1D': return isoDate(y, m, d - 1);
      case 'MTD': return isoDate(y, m, 0);
      case 'YTD': return (y - 1) + '-12-31';
      case '1Y': return isoDate(y - 1, m, m === 2 && d === 29 ? 28 : d);
    }
    return null;
  }

  /* A share line's prices for returns: daily closes before its latest trade date, then the latest price on that
     date (it replaces that day's close). */
  function priceSeries(marketLine) {
    var history = (marketLine && marketLine.history) || [];
    var last = marketLine && isNum(marketLine.last_price) && marketLine.last_trade_date ? marketLine.last_price : null;
    if (last === null) { return history.slice(); }
    var out = history.filter(function (p) { return p[0] < marketLine.last_trade_date; });
    out.push([marketLine.last_trade_date, last]);
    return out;
  }

  /* SPEC §8.5 — return of one share line.
     series: priceSeries(); opts: {
       start: date (the last close on or before it is the start), end: date or null (null = latest price),
       total: false = price return, true = total return; usd: false = listing currency, true = US$;
       currency: listing currency; dividends: [[ex_date, amount]]; fx: local-per-US$ history; fxLatest: latest rate }
     Price return = P_end ÷ P_start − 1.
     Total return = TRI_end ÷ TRI_start − 1, TRI_t = TRI_(t−1) × (P_t + D_t) ÷ P_(t−1): dividends are reinvested on
     their ex-date; one paid on a day with no price is reinvested at the next close.
     US$: each price and dividend ÷ that day's local-per-US$ rate (carried forward over holidays); the latest price
     uses the latest rate. US$-listed shares need no FX.
     n.a. with history_start when the history doesn't reach the start date. */
  function lineReturn(series, opts) {
    if (!series || !series.length) { return na('no price history'); }
    var si = indexOnOrBefore(series, opts.start);
    if (si < 0) { return na('history starts ' + series[0][0], { history_start: series[0][0] }); }
    var ei = opts.end === null || opts.end === undefined ? series.length - 1 : indexOnOrBefore(series, opts.end);
    if (ei < si) { return na('the end date is before the start date'); }
    var latest = ei === series.length - 1 && (opts.end === null || opts.end === undefined || opts.end >= series[ei][0]);
    var needFx = opts.usd && opts.currency !== 'USD';
    var fxMissing = null;

    function rate(k) {
      if (!needFx) { return 1; }
      if (k === series.length - 1 && latest && isNum(opts.fxLatest)) { return opts.fxLatest; }
      var p = pointOnOrBefore(opts.fx || [], series[k][0]);
      if (!p || !isNum(p[1]) || p[1] <= 0) { fxMissing = fxMissing || series[k][0]; return null; }
      return p[1];
    }
    function price(k) { var r = rate(k); return r === null ? null : series[k][1] / r; }

    var p0 = price(si), p1 = price(ei);
    var extra = { start: series[si], end: series[ei], latest: latest,
                  fx_start: needFx ? rate(si) : null, fx_end: needFx ? rate(ei) : null, dividends: [] };
    if (fxMissing) { return na('no US$/' + opts.currency + ' rate on ' + fxMissing, extra); }
    if (!(series[si][1] > 0) || !(series[ei][1] > 0)) { return nm('price is zero or negative', extra); }

    var divs = (opts.dividends || []).filter(function (d) { return d[0] > series[si][0] && d[0] <= series[ei][0] && isNum(d[1]); })
      .sort(function (a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0; });
    extra.no_dividends = divs.length === 0;
    if (!opts.total) { return ok(p1 / p0 - 1, extra); }

    var tri = 1, j = 0, k;
    for (k = si + 1; k <= ei; k++) {
      var d = 0, prev = price(k - 1), now = price(k);
      while (j < divs.length && divs[j][0] <= series[k][0]) {
        var r = rate(k);
        extra.dividends.push({ ex_date: divs[j][0], amount: divs[j][1], reinvested: series[k][0], fx: needFx ? r : null });
        d += r === null ? 0 : divs[j][1] / r;
        j++;
      }
      if (fxMissing) { return na('no US$/' + opts.currency + ' rate on ' + fxMissing, extra); }
      tri = tri * (now + d) / prev;
    }
    return ok(tri - 1, extra);
  }

  /* The corporate events (market data "events") a return runs across: its start close is on or before the last
     session before the event, and its end on or after the first session after it. Returns their notes. */
  function eventsSpanned(events, lineId, startDate, endDate) {
    return (events || []).filter(function (e) {
      return e.lines.indexOf(lineId) >= 0 && startDate <= e.last_before && endDate >= e.first_after;
    }).map(function (e) { return e.note; });
  }

  /* SPEC §8.5 — checks a custom range before it is applied: both dates filled, start before end, start not before
     the price history, end not after today. Returns { ok: true } or { ok: false, problem: 'missing'|'order'|'start'|'end' }. */
  function checkCustomRange(start, end, earliest, today) {
    if (!start || !end) { return { ok: false, problem: 'missing' }; }
    if (start >= end) { return { ok: false, problem: 'order' }; }
    if (earliest && start < earliest) { return { ok: false, problem: 'start' }; }
    if (today && end > today) { return { ok: false, problem: 'end' }; }
    return { ok: true };
  }

  /* SPEC §8.5, §9.3 — the Stock Performance table for every share line.
     options: { total: bool, usd: bool, custom: { start, end } }.
     reference = the latest session in the market data. MTD, YTD and 1Y start from periodStart(reference); 1D from
     the previous close of each line's own latest session. The custom range ends at the latest price when its end
     date is on or after the latest session.
     Dividends come from Dividends_Override when that sheet has any row for the line (they replace Yahoo's), else Yahoo. */
  function performance(btg, market, options) {
    var mLines = (market && market.lines) || {};
    var mFx = (market && market.fx) || {};
    var dates = Object.keys(mLines).map(function (id) { return mLines[id].last_trade_date; }).filter(Boolean).sort();
    var reference = (market && market.reference_session) || dates[dates.length - 1] || null;
    var starts = Object.keys(mLines).map(function (id) { return mLines[id].history_start; }).filter(Boolean).sort();
    var custom = (options && options.custom) || {};
    var periods = reference ? {
      d1: { start: null, end: null },                         // per line: see below
      mtd: { start: periodStart('MTD', reference), end: null },
      ytd: { start: periodStart('YTD', reference), end: null },
      y1: { start: periodStart('1Y', reference), end: null },
      custom: { start: custom.start || periodStart('YTD', reference),
                end: custom.end && custom.end < reference ? custom.end : null }
    } : {};
    var overrides = {};
    (btg.dividends_override || []).forEach(function (d) {
      (overrides[d.line_id] = overrides[d.line_id] || []).push([d.ex_date, d.amount]);
    });
    return {
      reference: reference,
      earliest: starts[0] || null,
      periods: periods,
      lines: btg.lines.map(function (l) {
        var m = mLines[l.line_id] || null;
        var series = priceSeries(m);
        var pair = FX_PAIR[l.listing_currency];
        var fx = pair && mFx[pair] ? mFx[pair] : {};
        var dividendSource = overrides[l.line_id] ? 'Dividends_Override' : 'Yahoo Finance';
        var returns = {};
        Object.keys(periods).forEach(function (key) {
          var start = key === 'd1' ? (series.length ? periodStart('1D', series[series.length - 1][0]) : reference) : periods[key].start;
          var r = lineReturn(series, {
            start: start, end: periods[key].end, total: !!(options && options.total), usd: !!(options && options.usd),
            currency: l.listing_currency, dividends: overrides[l.line_id] || (m ? m.dividends : []),
            fx: fx.history || [], fxLatest: fx.last
          });
          r.events = r.start && r.end ? eventsSpanned(market && market.events, l.line_id, r.start[0], r.end[0]) : [];
          r.dividend_source = dividendSource;
          returns[key] = r;
        });
        return { line: l, market: m, price: m && isNum(m.last_price) ? m.last_price : null, returns: returns };
      })
    };
  }

  return {
    perUsd: perUsd,
    convert: convert,
    lineMarketCap: lineMarketCap,
    companyMarketCap: companyMarketCap,
    totalMarketCap: totalMarketCap,
    upside: upside,
    dpsForYear: dpsForYear,
    FIN_UNITS: FIN_UNITS,
    priceBasis: priceBasis,
    marketCapReporting: marketCapReporting,
    ratio: ratio,
    priceEarnings: priceEarnings,
    priceBook: priceBook,
    evEbitda: evEbitda,
    netDebtEbitda: netDebtEbitda,
    returnOnEquity: returnOnEquity,
    dividendYield: dividendYield,
    valuation: valuation,
    indexOnOrBefore: indexOnOrBefore,
    periodStart: periodStart,
    priceSeries: priceSeries,
    lineReturn: lineReturn,
    eventsSpanned: eventsSpanned,
    checkCustomRange: checkCustomRange,
    performance: performance
  };
}));

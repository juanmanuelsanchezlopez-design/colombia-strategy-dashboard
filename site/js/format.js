/* =============================================================================
   format.js — how numbers, dates and times look on the dashboard. Formatting only:
   no calculations (those live in calc.js).

   House style (SPEC §0.9, §5, §8): dates "16 Sep 2026"; times in Bogotá; "US$" not "$";
   COP prices without decimals, US$/CAD with 2; percentages with 1 decimal.
   ============================================================================= */
(function (root, factory) {
  var Fmt = factory();
  if (typeof module === 'object' && module.exports) { module.exports = Fmt; } else { root.Fmt = Fmt; }
}(this, function () {
  'use strict';

  var TZ = 'America/Bogota';
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var MINUS = '−';

  function isNum(x) { return typeof x === 'number' && isFinite(x); }

  /* 1234.5 -> "1,234.5"; negatives use a true minus sign. */
  function num(v, dp) {
    if (!isNum(v)) { return 'n.a.'; }
    var s = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
    var zero = Number(s.replace(/,/g, '')) === 0;
    return (v < 0 && !zero ? MINUS : '') + s;
  }

  function ccyLabel(ccy) { return ccy === 'USD' ? 'US$' : ccy; }

  /* Price and target price: COP 0 decimals, US$/CAD 2 decimals (SPEC §8.4). */
  function price(v, ccy) { return num(v, ccy === 'COP' ? 0 : 2); }

  /* DPS: COP 0 decimals, US$/CAD 2 decimals (SPEC §8.4). */
  function dps(v, ccy) { return num(v, ccy === 'COP' ? 0 : 2); }

  /* 0.1234 -> "+12.3%" */
  function pct(v, dp) {
    if (!isNum(v)) { return 'n.a.'; }
    var d = dp === undefined ? 1 : dp;
    var rounded = Number((v * 100).toFixed(d));
    return (rounded > 0 ? '+' : '') + num(v * 100, d) + '%';
  }

  function copTn(v) { return num(v, 1); }            // Mkt cap (COP tn), 1 decimal
  function usdMn(v) { return num(v, 0); }            // Mkt cap (US$mn), 0 decimals

  /* Display rule for a calc.js result (SPEC §8.3): ok -> formatted, na -> "n.a.", nm -> "n.m.", none -> "–". */
  function result(r, format) {
    if (!r) { return 'n.a.'; }
    if (r.status === 'ok') { return format(r.value); }
    return r.status === 'nm' ? 'n.m.' : r.status === 'none' ? '–' : 'n.a.';
  }

  /* "2026-09-16" -> "16 Sep 2026" (a calendar date, no time zone shift). */
  function date(iso) {
    if (!iso) { return 'n.a.'; }
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso));
    if (!m) { return String(iso); }
    return m[3] + ' ' + MONTHS[Number(m[2]) - 1] + ' ' + m[1];
  }

  function bogotaParts(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) { return null; }
    var parts = {};
    new Intl.DateTimeFormat('en-GB', {
      timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    }).formatToParts(d).forEach(function (p) { parts[p.type] = p.value; });
    return parts;
  }

  /* "2026-09-16T20:03:05Z" -> "16 Sep 2026, 15:03:05" in Bogotá time. */
  function dateTime(iso, withSeconds) {
    var p = bogotaParts(iso);
    if (!p) { return 'n.a.'; }
    var hh = p.hour === '24' ? '00' : p.hour;
    return p.day + ' ' + MONTHS[Number(p.month) - 1] + ' ' + p.year + ', ' + hh + ':' + p.minute +
           (withSeconds === false ? '' : ':' + p.second);
  }

  /* "2026-09-16T20:03:05Z" -> "15:03" in Bogotá time. */
  function time(iso) {
    var p = bogotaParts(iso);
    if (!p) { return 'n.a.'; }
    return (p.hour === '24' ? '00' : p.hour) + ':' + p.minute;
  }

  /* "2026-08" -> "Aug 2026" */
  function month(ym) {
    var m = /^(\d{4})-(\d{2})$/.exec(String(ym || ''));
    return m ? MONTHS[Number(m[2]) - 1] + ' ' + m[1] : 'n.a.';
  }

  /* Year column label: the actual year plain, estimate years with E (2026E). */
  function yearLabel(year, actualYear) { return year > actualYear ? year + 'E' : String(year); }

  return {
    num: num, ccyLabel: ccyLabel, price: price, dps: dps, pct: pct, copTn: copTn, usdMn: usdMn,
    result: result, date: date, dateTime: dateTime, time: time, month: month, yearLabel: yearLabel, MINUS: MINUS
  };
}));

/* =============================================================================
   tab_stock_info.js — the Stock Information tab (SPEC §9.1).

   Columns: Company · Ticker · Rating · Target price · Price · Upside · DPS · Mkt cap (COP tn) · Mkt cap (US$mn)
   Rows grouped by sector (Config sector_order), a total row per sector and a universe total.
   Controls: sector chips, company search, sortable columns (sorting stays within sectors),
   "Show all share classes".
   Every figure comes from calc.js; this file only arranges and labels them (SPEC §11 placeholders).
   ============================================================================= */
(function () {
  'use strict';

  var RATING_ORDER = { Buy: 0, Neutral: 1, Sell: 2, TBD: 3 };
  var PLACEHOLDER_TIP = 'Placeholder from Yahoo Finance — not a BTG Pactual estimate.';
  var SHARES_TIP = 'Uses a share count from Yahoo Finance (placeholder), not a figure verified by BTG Pactual.';
  var ui = { sector: 'ALL', q: '', showAll: null, sort: null, dir: 1 };   // kept while switching tabs

  function deaccent(s) {
    s = String(s || '');
    return (s.normalize ? s.normalize('NFD').replace(/[̀-ͯ]/g, '') : s).toLowerCase();
  }

  // ---------------------------------------------------------------------------
  // Model: one row per company (primary line) or per share line
  // ---------------------------------------------------------------------------
  function buildRows(A) {
    var btg = A.btg, fx = A.fx(), year = btg.years.dps_display;
    var linesOf = {}, dpsOf = {};
    btg.lines.forEach(function (l) { (linesOf[l.company_id] = linesOf[l.company_id] || []).push(l); });
    btg.dps.forEach(function (d) { dpsOf[d.line_id] = d; });

    function priceOf(l) { var m = A.marketLine(l.line_id); return m && typeof m.last_price === 'number' ? m.last_price : null; }
    function capInput(l) {
      return { line_id: l.line_id, currency: l.listing_currency, price: priceOf(l), shares_mn: l.shares_mn,
               shares_placeholder: l.shares_source === 'YAHOO_PLACEHOLDER', shares_as_of: l.shares_as_of };
    }

    var rows = [];
    btg.companies.forEach(function (c) {
      var lines = linesOf[c.company_id] || [];
      var companyCap = Calc.companyMarketCap(lines.map(capInput), fx);
      var shown = ui.showAll ? lines : lines.filter(function (l) { return l.primary_line === 'Y'; });
      shown.forEach(function (l) {
        var price = priceOf(l);
        var tbd = l.rating === 'TBD';
        var dpsRow = dpsOf[l.line_id];
        rows.push({
          company: c, line: l, sector: c.sector,
          name: ui.showAll ? l.display_label : c.company_name,
          market: A.marketLine(l.line_id),
          price: price,
          tp: tbd ? null : l.target_price,
          upside: tbd ? { status: 'none', value: null } : Calc.upside(l.target_price, price),
          dps: Calc.dpsForYear(dpsRow ? dpsRow.values : null, year),
          dpsPlaceholder: !!dpsRow && dpsRow.source === 'YAHOO_PLACEHOLDER',
          cap: ui.showAll ? Calc.companyMarketCap([capInput(l)], fx) : companyCap,
          companyCap: companyCap
        });
      });
    });
    return rows;
  }

  var COLUMNS = [
    { key: 'name', label: 'Company', cls: '' },
    { key: 'ticker', label: 'Ticker', cls: '' },
    { key: 'rating', label: 'Rating', cls: '' },
    { key: 'tp', label: 'Target price', cls: 'num' },
    { key: 'price', label: 'Price', cls: 'num' },
    { key: 'upside', label: 'Upside', cls: 'num' },
    { key: 'dps', label: 'DPS', cls: 'num' },
    { key: 'capCop', label: 'Mkt cap (COP tn)', cls: 'num' },
    { key: 'capUsd', label: 'Mkt cap (US$mn)', cls: 'num' }
  ];

  function sortValue(r, key) {
    switch (key) {
      case 'name': return deaccent(r.name);
      case 'ticker': return r.line.line_id;
      case 'rating': return RATING_ORDER[r.line.rating];
      case 'tp': return r.tp;
      case 'price': return r.price;
      case 'upside': return r.upside.status === 'ok' ? r.upside.value : null;
      case 'dps': return r.dps.status === 'ok' ? r.dps.value : null;
      case 'capCop': return r.cap.status === 'ok' ? r.cap.cop_tn : null;
      case 'capUsd': return r.cap.status === 'ok' ? r.cap.usd_mn : null;
    }
    return null;
  }

  function sortRows(rows) {
    if (!ui.sort) { return rows; }
    return rows.slice().sort(function (a, b) {
      var x = sortValue(a, ui.sort), y = sortValue(b, ui.sort);
      if (x === null || x === undefined) { return (y === null || y === undefined) ? 0 : 1; }   // n.a. always last
      if (y === null || y === undefined) { return -1; }
      return (typeof x === 'string' ? x.localeCompare(y) : x - y) * ui.dir;
    });
  }

  // ---------------------------------------------------------------------------
  // Cells
  // ---------------------------------------------------------------------------
  function mark(tip) { return '<span class="mark"' + App.tip(tip) + ' aria-label="' + App.esc(tip) + '">◦</span>'; }
  function ccy(code) { return '<span class="ccy">' + App.esc(Fmt.ccyLabel(code)) + '</span>'; }

  function pill(l) {
    var cls = { Buy: 'pill-buy', Neutral: 'pill-neutral', Sell: 'pill-sell' }[l.rating] || 'pill-tbd';
    var placeholder = l.rating !== 'TBD' && l.rating_tp_source === 'PLACEHOLDER';
    return '<span class="pill ' + cls + (placeholder ? ' placeholder-pill' : '') + '">' + App.esc(l.rating) + '</span>' +
           (placeholder ? mark('Rating not yet confirmed as BTG Pactual’s (source is PLACEHOLDER).') : '');
  }

  function priceCell(r) {
    var l = r.line, m = r.market;
    if (r.price === null) {
      return 'n.a.' + '<span class="error-mark"' + App.tip('No price from Yahoo Finance' + (m && m.status_note ? ': ' + m.status_note : '.')) + '></span>';
    }
    var tip = App.audit && m ? 'Last trade ' + (m.last_trade_time ? Fmt.dateTime(m.last_trade_time) + ' (Bogotá)' : Fmt.date(m.last_trade_date)) +
      '\nSource: Yahoo Finance ' + l.yahoo_ticker : '';
    var html = '<span' + App.tip(tip) + '>' + Fmt.price(r.price, l.listing_currency) + '</span>' + ccy(l.listing_currency);
    if (m && m.status === 'stale') {
      html += '<span class="stale-mark"' + App.tip('Last trade: ' + Fmt.date(m.last_trade_date)) + ' aria-label="Last trade: ' + App.esc(Fmt.date(m.last_trade_date)) + '"></span>';
    } else if (m && m.status === 'error') {
      html += '<span class="error-mark"' + App.tip('The last refresh failed for this share: ' + (m.status_note || 'no detail')) + '></span>';
    }
    return html;
  }

  function tpCell(r) {
    var l = r.line;
    if (r.tp === null || r.tp === undefined) { return '–'; }
    var placeholder = l.rating_tp_source === 'PLACEHOLDER';
    var text = Fmt.price(r.tp, l.listing_currency);
    if (App.audit && l.tp_date) { text = '<span' + App.tip('Target price set ' + Fmt.date(l.tp_date) + ' (source ' + l.rating_tp_source + ')') + '>' + text + '</span>'; }
    return (placeholder ? '<span class="placeholder">' + text + '</span>' + mark('Target price not yet confirmed as BTG Pactual’s (source is PLACEHOLDER).') : text) + ccy(l.listing_currency);
  }

  function upsideCell(r) {
    var u = r.upside, text = Fmt.result(u, Fmt.pct);
    if (u.status !== 'ok') { return text; }
    var cls = u.value > 0 ? 'up' : u.value < 0 ? 'down' : 'flat';
    var tip = '';
    if (App.audit) {
      var cur = r.line.listing_currency;
      tip = 'Upside = target price ÷ price − 1\n= ' + Fmt.price(r.tp, cur) + ' ÷ ' + Fmt.price(r.price, cur) + ' − 1 = ' + text +
            '\nSources: target price ' + r.line.rating_tp_source + (r.line.tp_date ? ' (' + Fmt.date(r.line.tp_date) + ')' : '') +
            '; price Yahoo Finance' + (r.market && r.market.last_trade_time ? ' ' + Fmt.dateTime(r.market.last_trade_time, false) : '');
    }
    return '<span class="' + cls + '"' + App.tip(tip) + '>' + text + '</span>';
  }

  function dpsCell(r) {
    var cur = r.line.listing_currency;
    if (r.dps.status !== 'ok') { return 'n.a.'; }
    var text = Fmt.dps(r.dps.value, cur);
    return (r.dpsPlaceholder ? '<span class="placeholder">' + text + '</span>' + mark(PLACEHOLDER_TIP) : text) + ccy(cur);
  }

  function capWorking(cap, unit) {
    if (!App.audit || cap.status !== 'ok') { return ''; }
    var fx = App.fx();
    var lines = cap.parts.map(function (p) {
      return p.line_id + ': ' + Fmt.price(p.price, p.currency) + ' ' + Fmt.ccyLabel(p.currency) + ' × ' + Fmt.num(p.shares_mn, 3) + 'mn shares';
    });
    var total = unit === 'cop' ? 'COP ' + Fmt.copTn(cap.cop_tn) + 'tn (at US$/COP ' + Fmt.num(fx.USDCOP, 2) + ')'
                               : 'US$' + Fmt.usdMn(cap.usd_mn) + 'mn';
    return 'Mkt cap = sum of price × shares' + (cap.parts.length > 1 ? ' over all share classes' : '') +
           ', converted at live FX\n' + lines.join('\n') + '\n= ' + total +
           (cap.parts.some(function (p) { return p.currency === 'CAD'; }) ? '\nCAD converted via US$ at US$/CAD ' + Fmt.num(fx.USDCAD, 4) : '') +
           '\nSources: prices Yahoo Finance; shares Coverage sheet' + (cap.placeholder ? ' (Yahoo placeholder)' : '');
  }

  function capCell(cap, unit) {
    var value = unit === 'cop' ? cap.cop_tn : cap.usd_mn;
    var format = unit === 'cop' ? Fmt.copTn : Fmt.usdMn;
    if (cap.status !== 'ok' || value === null || value === undefined) {
      var why = cap.missing && cap.missing.length
        ? 'n.a.: ' + cap.missing.map(function (m) { return m.line_id + ' has ' + m.reason; }).join('; ')
        : 'n.a.: ' + (cap.reason || 'missing input');
      return '<span' + App.tip(why) + '>n.a.</span>';
    }
    var text = '<span' + App.tip(capWorking(cap, unit)) + '>' + format(value) + '</span>';
    return cap.placeholder ? '<span class="placeholder">' + text + '</span>' + mark(SHARES_TIP) : text;
  }

  function totalCells(items, fx, unit) {
    var t = Calc.totalMarketCap(items, fx);
    var value = unit === 'cop' ? t.cop_tn : t.usd_mn;
    if (t.status !== 'ok' || value === null || value === undefined) { return 'n.a.'; }
    var text = (unit === 'cop' ? Fmt.copTn : Fmt.usdMn)(value);
    if (t.placeholder) { text = '<span class="placeholder">' + text + '</span>' + mark(SHARES_TIP); }
    if (t.excluded.length) {
      text += '<span class="mark"' + App.tip('Excludes ' + t.excluded.join(', ') + ' (market cap n.a.)') + '>†</span>';
    }
    return text;
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  function headerHtml(A) {
    return '<thead><tr>' + COLUMNS.map(function (c) {
      var label = c.key === 'dps' ? 'DPS ' + A.yearLabel(A.btg.years.dps_display) : c.label;
      var active = ui.sort === c.key;
      var aria = active ? (ui.dir > 0 ? 'ascending' : 'descending') : 'none';
      return '<th scope="col" class="sortable ' + c.cls + '" aria-sort="' + aria + '">' +
        '<button type="button" class="sort-btn" data-sort="' + c.key + '">' + App.esc(label) +
        (active ? '<span class="arrow" aria-hidden="true">' + (ui.dir > 0 ? '▲' : '▼') + '</span>' : '') +
        '</button></th>';
    }).join('') + '</tr></thead>';
  }

  function tableHtml(A, rows) {
    var fx = A.fx();
    var html = headerHtml(A) + '<tbody>';
    var visible = [];
    A.btg.sectors.forEach(function (sector) {
      var inSector = sortRows(rows.filter(function (r) { return r.sector === sector; }));
      if (!inSector.length) { return; }
      var companies = {};
      inSector.forEach(function (r) { companies[r.company.company_id] = 1; });
      var n = Object.keys(companies).length;
      html += '<tr class="band"><td colspan="' + COLUMNS.length + '"><span class="band-label">' + App.esc(sector) +
              '<span class="band-count">' + n + (n === 1 ? ' company' : ' companies') + '</span></span></td></tr>';
      inSector.forEach(function (r) {
        html += '<tr class="row">' +
          '<td class="company">' + App.esc(r.name) + '</td>' +
          '<td>' + App.esc(r.line.line_id) + '</td>' +
          '<td>' + pill(r.line) + '</td>' +
          '<td class="num">' + tpCell(r) + '</td>' +
          '<td class="num">' + priceCell(r) + '</td>' +
          '<td class="num">' + upsideCell(r) + '</td>' +
          '<td class="num">' + dpsCell(r) + '</td>' +
          '<td class="num">' + capCell(r.cap, 'cop') + '</td>' +
          '<td class="num">' + capCell(r.cap, 'usd') + '</td></tr>';
      });
      var items = totalItems(inSector);
      visible = visible.concat(items);
      html += '<tr class="total"><td class="label-cell">' + App.esc(sector) + ' total</td><td colspan="6"></td>' +
              '<td class="num">' + totalCells(items, fx, 'cop') + '</td><td class="num">' + totalCells(items, fx, 'usd') + '</td></tr>';
    });
    if (!visible.length) {
      return html + '</tbody>';
    }
    var filtered = ui.sector !== 'ALL' || ui.q;
    html += '<tr class="grand"><td>' + (filtered ? 'Total shown' : 'Universe total') + '</td><td colspan="6"></td>' +
            '<td class="num">' + totalCells(visible, fx, 'cop') + '</td><td class="num">' + totalCells(visible, fx, 'usd') + '</td></tr>';
    return html + '</tbody>';
  }

  /* Items for a total: one per company shown, using the whole-company market cap, so totals are the same
     whether one line per company or all share classes are displayed. */
  function totalItems(rows) {
    var seen = {}, items = [];
    rows.forEach(function (r) {
      if (seen[r.company.company_id]) { return; }
      seen[r.company.company_id] = 1;
      items.push({ name: r.company.company_name, cap: r.companyCap });
    });
    return items;
  }

  function filterRows(rows) {
    var q = deaccent(ui.q).trim();
    return rows.filter(function (r) {
      if (ui.sector !== 'ALL' && r.sector !== ui.sector) { return false; }
      if (!q) { return true; }
      return deaccent(r.company.company_name + ' ' + r.line.display_label + ' ' + r.line.line_id).indexOf(q) >= 0;
    });
  }

  function update(host, A) {
    var all = buildRows(A);
    var rows = filterRows(all);
    host.querySelector('#siTable').innerHTML = tableHtml(A, rows);
    host.querySelector('#siEmpty').hidden = rows.length > 0;
    var unit = ui.showAll ? 'share lines' : 'companies';
    host.querySelector('#siCount').textContent = 'Showing ' + rows.length + ' of ' + all.length + ' ' + unit;
    var placeholders = rows.some(function (r) {
      return (r.cap.status === 'ok' && r.cap.placeholder) || r.dpsPlaceholder ||
             (r.line.rating !== 'TBD' && r.line.rating_tp_source === 'PLACEHOLDER');
    });
    host.querySelector('#siBanner').innerHTML = placeholders
      ? A.banner('info', 'Some figures are Yahoo Finance placeholders, not BTG Pactual estimates. They are marked ◦.') : '';
    host.querySelectorAll('[data-sector]').forEach(function (b) {
      b.setAttribute('aria-pressed', b.getAttribute('data-sector') === ui.sector ? 'true' : 'false');
    });
    host.querySelector('#siAll').setAttribute('aria-pressed', ui.showAll ? 'true' : 'false');
  }

  function render(host, A) {
    if (ui.showAll === null) { ui.showAll = A.btg.config.share_display_mode === 'all_lines'; }
    var fx = A.fx();
    var chips = ['ALL'].concat(A.btg.sectors).map(function (s) {
      return '<button type="button" class="ctrl" data-sector="' + A.esc(s) + '" aria-pressed="false">' +
             A.esc(s === 'ALL' ? 'All sectors' : s) + '</button>';
    }).join('');
    host.innerHTML =
      '<div id="siBanner"></div>' +
      '<section class="panel" aria-labelledby="siTitle">' +
        '<div class="panel-head"><span id="siTitle">Coverage by sector</span><span class="spacer"></span>' +
          '<span class="ctrls"><span class="ctrl-group" role="group" aria-label="Filter by sector">' + chips + '</span>' +
          '<button type="button" class="ctrl ctrl-solo" id="siAll" aria-pressed="false">Show all share classes</button></span>' +
        '</div>' +
        '<div class="controls">' +
          '<input type="search" class="search" id="siSearch" placeholder="Search company or ticker…" aria-label="Search company or ticker" value="' + A.esc(ui.q) + '">' +
          '<span class="count" id="siCount" aria-live="polite"></span>' +
        '</div>' +
        '<div class="table-scroll"><table class="data" id="siTable"></table>' +
          '<div class="empty" id="siEmpty" hidden>No companies match the search or filter.</div></div>' +
        '<div class="panel-note">' +
          '<p>Price and target price are in each share’s listing currency (COP, US$ or CAD). Upside = target price ÷ price − 1. ' +
          'DPS is the dividend per share paid in ' + A.btg.years.dps_display + '.</p>' +
          '<p>Market cap adds up every share class of a company at live FX (US$/COP ' + Fmt.num(fx.USDCOP, 2) + ', US$/CAD ' +
          Fmt.num(fx.USDCAD, 4) + '). With all share classes shown, each row shows its own class; the totals are the same.</p>' +
          '<p>◦ placeholder, not a BTG Pactual figure. † total leaves out companies whose market cap is n.a. ' +
          'Amber dot: last trade from an earlier session. TBD: rating and target price not yet available.' +
          (A.audit ? ' Hover over prices, upsides and market caps to see the calculation (shown only on this computer).' : '') + '</p>' +
        '</div>' +
      '</section>';

    host.addEventListener('click', function (e) {
      var chip = e.target.closest('[data-sector]');
      if (chip) { ui.sector = chip.getAttribute('data-sector'); update(host, A); return; }
      if (e.target.closest('#siAll')) { ui.showAll = !ui.showAll; update(host, A); return; }
      var sort = e.target.closest('[data-sort]');
      if (sort) {
        var key = sort.getAttribute('data-sort');
        if (ui.sort === key) { ui.dir = -ui.dir; } else { ui.sort = key; ui.dir = (key === 'name' || key === 'ticker' || key === 'rating') ? 1 : -1; }
        update(host, A);
        var again = host.querySelector('[data-sort="' + key + '"]');
        if (again) { again.focus(); }
      }
    });
    host.querySelector('#siSearch').addEventListener('input', function () { ui.q = this.value; update(host, A); });
    update(host, A);
  }

  window.TabStockInfo = { render: render };
})();

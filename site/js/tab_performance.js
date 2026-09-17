/* =============================================================================
   tab_performance.js — the Stock Performance tab (SPEC §9.3).

   Columns: Company · Ticker · Price (LC) · 1D · MTD · YTD · 1Y · Custom
   Toggles: Return Price | Total; Currency Local | US$. Custom range: two dates plus Apply (default year to date).
   Rows grouped by sector, with sector chips, search, sorting within sectors and "Show all share classes".
   Markers: † the period includes a corporate event (market data "events", DECISIONS D23);
            * total return with no dividends recorded over a long window (SPEC §9.3, DECISIONS D23).
   Every figure comes from Calc.performance (calc.js); this file only arranges and labels them.
   ============================================================================= */
(function () {
  'use strict';

  var PERIODS = [
    { key: 'd1', label: '1D' },
    { key: 'mtd', label: 'MTD' },
    { key: 'ytd', label: 'YTD' },
    { key: 'y1', label: '1Y' },
    { key: 'custom', label: 'Custom' }
  ];
  var NO_DIVIDENDS_TIP = 'No dividends recorded by Yahoo for this period — check Dividends_Override.';
  var LONG_WINDOW_DAYS = 183;     // the no-dividends marker is shown on 1Y, and on YTD / Custom from about 6 months
  var ui = { sector: 'ALL', q: '', showAll: null, sort: null, dir: 1, total: false, usd: false, start: null, end: null, error: null };

  function today() { return Fmt.localDate(new Date().toISOString()); }
  function days(a, b) { return Math.round((Date.parse(b) - Date.parse(a)) / 86400000); }

  // ---------------------------------------------------------------------------
  // Cells
  // ---------------------------------------------------------------------------
  function working(A, row, key, label) {
    var r = row.returns[key], cur = row.line.listing_currency;
    var inUsd = ui.usd && cur !== 'USD';
    var kind = ui.total ? 'Total return' : 'Price return';
    var price = function (point, fx) {
      return Fmt.price(point[1], cur) + ' ' + Fmt.ccyLabel(cur) + (inUsd ? ' ÷ ' + Fmt.num(fx, cur === 'CAD' ? 4 : 2) + ' = US$' + Fmt.num(point[1] / fx, 4) : '');
    };
    var lines = [kind + ' ' + label + (ui.usd ? ' (US$)' : ' (' + Fmt.ccyLabel(cur) + ')') + ' = ' + Fmt.result(r, Fmt.pct),
      'Start: ' + Fmt.date(r.start[0]) + ' close, ' + price(r.start, r.fx_start),
      'End: ' + Fmt.date(r.end[0]) + (r.latest ? ' latest price, ' : ' close, ') + price(r.end, r.fx_end)];
    if (ui.total) {
      lines.push(r.dividends.length
        ? 'Dividends reinvested (' + r.dividend_source + '): ' + r.dividends.map(function (d) {
            return Fmt.dps(d.amount, cur) + ' ' + Fmt.ccyLabel(cur) + ' ex ' + Fmt.date(d.ex_date) +
                   (d.reinvested !== d.ex_date ? ' (reinvested at the ' + Fmt.date(d.reinvested) + ' close)' : '');
          }).join('; ')
        : 'No dividends in this period (' + r.dividend_source + ').');
      lines.push('TRI_t = TRI_(t−1) × (P_t + D_t) ÷ P_(t−1), daily from start to end');
    } else {
      lines.push('= end ÷ start − 1');
    }
    lines.push('Sources: prices Yahoo Finance ' + row.line.yahoo_ticker + (inUsd ? '; FX Yahoo Finance US$/' + cur + ' on each day' : ''));
    return lines.join('\n');
  }

  function returnCell(A, row, key, label) {
    var r = row.returns[key];
    var text = Fmt.result(r, Fmt.pct);
    if (r.status !== 'ok') {
      var why = r.history_start ? 'History starts ' + Fmt.date(r.history_start)
        : (r.status === 'nm' ? 'n.m.: ' : 'n.a.: ') + (r.reason || 'missing input');
      return '<td class="num"><span' + App.tip(why) + '>' + text + '</span></td>';
    }
    var cls = r.value > 0 && text !== '0.0%' ? 'up' : r.value < 0 && text !== '0.0%' ? 'down' : 'flat';
    var html = '<span class="' + cls + '"' + App.tip(A.audit ? working(A, row, key, label) : '') + '>' + text + '</span>';
    if (r.events.length) {
      html += '<span class="mark"' + App.tip(r.events.join('\n\n')) + ' aria-label="' + App.esc(r.events.join(' ')) + '">†</span>';
    }
    var long = key === 'y1' || ((key === 'ytd' || key === 'custom') && days(r.start[0], r.end[0]) >= LONG_WINDOW_DAYS);
    if (ui.total && r.no_dividends && long) {
      html += '<span class="mark"' + App.tip(NO_DIVIDENDS_TIP) + ' aria-label="' + App.esc(NO_DIVIDENDS_TIP) + '">*</span>';
    }
    return '<td class="num">' + html + '</td>';
  }

  // ---------------------------------------------------------------------------
  // Model, sorting and filtering
  // ---------------------------------------------------------------------------
  function sortValue(row, key) {
    if (key === 'name') { return App.deaccent(row.name); }
    if (key === 'ticker') { return row.line.line_id; }
    if (key === 'price') { return row.price; }
    var r = row.returns[key];
    return r && r.status === 'ok' ? r.value : null;
  }

  function buildRows(A, model) {
    var companies = {};
    A.btg.companies.forEach(function (c) { companies[c.company_id] = c; });
    return model.lines.filter(function (x) { return ui.showAll || x.line.primary_line === 'Y'; }).map(function (x) {
      var c = companies[x.line.company_id] || {};
      return { line: x.line, market: x.market, price: x.price, returns: x.returns, company: c, sector: c.sector,
               name: ui.showAll ? x.line.display_label : c.company_name };
    });
  }

  function filterRows(rows) {
    var q = App.deaccent(ui.q).trim();
    return rows.filter(function (r) {
      if (ui.sector !== 'ALL' && r.sector !== ui.sector) { return false; }
      return !q || App.deaccent(r.company.company_name + ' ' + r.line.display_label + ' ' + r.line.line_id).indexOf(q) >= 0;
    });
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  function customLabel(model) {
    var p = model.periods.custom;
    if (!p) { return 'Custom'; }
    var end = p.end === null ? model.reference : p.end;
    return Fmt.date(p.start) + ' → ' + Fmt.date(end);
  }

  function tableHtml(A, model, rows) {
    var cols = [
      { key: 'name', label: 'Company', cls: '' },
      { key: 'ticker', label: 'Ticker', cls: '' },
      { key: 'price', label: 'Price (LC)', cls: 'num' }
    ].concat(PERIODS.map(function (p) {
      return { key: p.key, label: p.key === 'custom' ? customLabel(model) : p.label, cls: 'num' };
    }));
    var html = '<thead><tr>' + cols.map(function (c) {
      var active = ui.sort === c.key;
      return '<th scope="col" class="sortable ' + c.cls + '" aria-sort="' + (active ? (ui.dir > 0 ? 'ascending' : 'descending') : 'none') + '">' +
        '<button type="button" class="sort-btn" data-sort="' + c.key + '">' + App.esc(c.label) +
        (active ? '<span class="arrow" aria-hidden="true">' + (ui.dir > 0 ? '▲' : '▼') + '</span>' : '') + '</button></th>';
    }).join('') + '</tr></thead><tbody>';

    A.btg.sectors.forEach(function (sector) {
      var inSector = rows.filter(function (r) { return r.sector === sector; });
      if (!inSector.length) { return; }
      if (ui.sort) { inSector = App.sortRows(inSector, function (r) { return sortValue(r, ui.sort); }, ui.dir); }
      var n = {};
      inSector.forEach(function (r) { n[r.company.company_id] = 1; });
      var count = Object.keys(n).length;
      html += '<tr class="band"><td colspan="' + cols.length + '"><span class="band-label">' + App.esc(sector) +
              '<span class="band-count">' + count + (count === 1 ? ' company' : ' companies') + '</span></span></td></tr>';
      inSector.forEach(function (r) {
        html += '<tr class="row"><td class="company">' + App.esc(r.name) + '</td>' +
          '<td>' + App.esc(r.line.line_id) + '</td>' +
          '<td class="num">' + App.priceCell(r.line, r.market, r.price) + '</td>' +
          PERIODS.map(function (p) { return returnCell(A, r, p.key, p.key === 'custom' ? customLabel(model) : p.label); }).join('') +
          '</tr>';
      });
    });
    return html + '</tbody>';
  }

  function toggleGroup(label, name, options, current) {
    return '<span class="ctrl-group" role="group" aria-label="' + App.esc(label) + '">' + options.map(function (o) {
      return '<button type="button" class="ctrl" data-' + name + '="' + o.value + '" aria-pressed="' + (o.value === current ? 'true' : 'false') + '">' +
             App.esc(o.label) + '</button>';
    }).join('') + '</span>';
  }

  function update(host, A) {
    var model = Calc.performance(A.btg, A.market(), { total: ui.total, usd: ui.usd, custom: { start: ui.start, end: ui.end } });
    var all = buildRows(A, model);
    var rows = filterRows(all);
    host.querySelector('#spTable').innerHTML = tableHtml(A, model, rows);
    host.querySelector('#spEmpty').hidden = rows.length > 0;
    host.querySelector('#spCount').textContent = 'Showing ' + rows.length + ' of ' + all.length + ' ' + (ui.showAll ? 'share lines' : 'companies');
    host.querySelectorAll('[data-sector]').forEach(function (b) {
      b.setAttribute('aria-pressed', b.getAttribute('data-sector') === ui.sector ? 'true' : 'false');
    });
    host.querySelectorAll('[data-total]').forEach(function (b) { b.setAttribute('aria-pressed', String((b.getAttribute('data-total') === '1') === ui.total)); });
    host.querySelectorAll('[data-usd]').forEach(function (b) { b.setAttribute('aria-pressed', String((b.getAttribute('data-usd') === '1') === ui.usd)); });
    host.querySelector('#spAll').setAttribute('aria-pressed', ui.showAll ? 'true' : 'false');
    var start = host.querySelector('#spStart'), end = host.querySelector('#spEnd');
    if (model.earliest) { start.min = model.earliest; end.min = model.earliest; }
    start.max = today(); end.max = today();
    if (!start.value) { start.value = model.periods.custom ? model.periods.custom.start : ''; }
    if (!end.value) { end.value = ui.end || today(); }
    host.querySelector('#spError').textContent = ui.error || '';
    return model;
  }

  function applyRange(host, A) {
    var start = host.querySelector('#spStart').value, end = host.querySelector('#spEnd').value;
    var model = Calc.performance(A.btg, A.market(), {});
    var check = Calc.checkCustomRange(start, end, model.earliest, today());
    if (!check.ok) {
      ui.error = {
        missing: 'Choose both dates.',
        order: 'The start date must be before the end date.',
        start: 'The start date is before the price history, which starts on ' + Fmt.date(model.earliest) + '.',
        end: 'The end date can’t be after today.'
      }[check.problem];
    } else {
      ui.error = null;
      ui.start = start;
      ui.end = end;
    }
    update(host, A);
  }

  function render(host, A) {
    if (ui.showAll === null) { ui.showAll = A.btg.config.share_display_mode === 'all_lines'; }
    host.innerHTML =
      '<section class="panel" aria-labelledby="spTitle">' +
        '<div class="panel-head"><span id="spTitle" role="heading" aria-level="3">Returns by sector</span><span class="spacer"></span>' +
          '<span class="ctrls">' +
            '<span class="ctrl-group" role="group" aria-label="Filter by sector">' + App.sectorChips() + '</span>' +
            toggleGroup('Return type', 'total', [{ value: '0', label: 'Price' }, { value: '1', label: 'Total' }], ui.total ? '1' : '0') +
            toggleGroup('Currency', 'usd', [{ value: '0', label: 'Local' }, { value: '1', label: 'US$' }], ui.usd ? '1' : '0') +
            '<button type="button" class="ctrl ctrl-solo" id="spAll" aria-pressed="false">Show all share classes</button>' +
          '</span>' +
        '</div>' +
        '<div class="controls">' +
          '<input type="search" class="search" id="spSearch" placeholder="Search company or ticker…" aria-label="Search company or ticker" value="' + A.esc(ui.q) + '">' +
          '<span class="range" role="group" aria-label="Custom range">' +
            '<label class="range-label" for="spStart">Custom from</label>' +
            '<input type="date" class="date-input" id="spStart" value="' + A.esc(ui.start || '') + '">' +
            '<label class="range-label" for="spEnd">to</label>' +
            '<input type="date" class="date-input" id="spEnd" value="' + A.esc(ui.end || '') + '">' +
            '<button type="button" class="btn btn-small" id="spApply">Apply</button>' +
            '<span class="range-error" id="spError" role="alert"></span>' +
          '</span>' +
          '<span class="count" id="spCount" aria-live="polite"></span>' +
        '</div>' +
        '<div class="table-scroll"><table class="data" id="spTable"></table>' +
          '<div class="empty" id="spEmpty" hidden>No companies match the search or filter.</div></div>' +
        '<div class="panel-note">' +
          '<p>Returns are in each share’s listing currency (COP, US$ or CAD), or in US$ with every price and dividend converted at that day’s rate. ' +
          '1D runs from the previous session close; MTD and YTD from the last close of the previous month or year; 1Y from the last close on or before ' +
          'the same date a year earlier; all to the latest price. Total return reinvests dividends on their ex-date ' +
          '(Yahoo Finance, or the Dividends_Override sheet where entered).</p>' +
          '<p>† the period includes a corporate event: hover for details. * no dividends recorded for this period (total return). ' +
          'n.a.: the price history doesn’t reach the start date. Amber dot: last trade from an earlier session.' +
          (A.audit ? ' Hover over a return to see the prices, dates and dividends used (shown only on this computer).' : '') + '</p>' +
        '</div>' +
      '</section>';

    host.addEventListener('click', function (e) {
      var t = e.target;
      var chip = t.closest('[data-sector]');
      if (chip) { ui.sector = chip.getAttribute('data-sector'); update(host, A); return; }
      var total = t.closest('[data-total]');
      if (total) { ui.total = total.getAttribute('data-total') === '1'; update(host, A); return; }
      var usd = t.closest('[data-usd]');
      if (usd) { ui.usd = usd.getAttribute('data-usd') === '1'; update(host, A); return; }
      if (t.closest('#spAll')) { ui.showAll = !ui.showAll; update(host, A); return; }
      if (t.closest('#spApply')) { applyRange(host, A); return; }
      var sort = t.closest('[data-sort]');
      if (sort) {
        var key = sort.getAttribute('data-sort');
        if (ui.sort === key) { ui.dir = -ui.dir; } else { ui.sort = key; ui.dir = (key === 'name' || key === 'ticker') ? 1 : -1; }
        update(host, A);
        var again = host.querySelector('[data-sort="' + key + '"]');
        if (again) { again.focus(); }
      }
    });
    host.querySelector('#spSearch').addEventListener('input', function () { ui.q = this.value; update(host, A); });
    host.querySelectorAll('.date-input').forEach(function (input) {
      input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { applyRange(host, A); } });
    });
    update(host, A);
  }

  window.TabPerformance = { render: render };
})();

/* =============================================================================
   tab_valuation.js — the Valuation Tracker tab (SPEC §9.2, layout of valuation_table_reference.png).

   Columns: Company · BTG Pactual Rating · Stock Price (LC), then P/E, EV/EBITDA, P/BV, Net debt/EBITDA,
   ROE (%) and Div Yield, each with a column per year (actual year + estimate years from Config).
   Rows grouped by sector; sector chips, search and sorting within sectors as on Stock Information.
   Every figure comes from Calc.valuation (calc.js); this file only arranges and labels them.
   On this computer (audit mode, SPEC §12.4) each figure's tooltip shows its full working.
   ============================================================================= */
(function () {
  'use strict';

  var GROUPS = [
    { key: 'pe', label: 'P/E', name: 'P/E', format: 'multiple' },
    { key: 'ev_ebitda', label: 'EV/EBITDA', name: 'EV/EBITDA', format: 'multiple' },
    { key: 'pbv', label: 'P/BV', name: 'P/BV', format: 'multiple' },
    { key: 'nd_ebitda', label: 'Net debt/EBITDA', name: 'Net debt/EBITDA', format: 'multiple' },
    { key: 'roe', label: 'ROE (%)', name: 'ROE', format: 'percent' },
    { key: 'dy', label: 'Div Yield', name: 'Dividend yield', format: 'percent' }
  ];
  var MULTIPLE_TIP = 'Uses a Yahoo Finance placeholder (an estimate, share count or DPS), not a BTG Pactual figure.';
  var ui = { sector: 'ALL', q: '', sort: null, dir: 1 };   // kept while switching tabs

  function yearLabel(A, y) { return A.yearLabel(y); }

  // ---------------------------------------------------------------------------
  // Audit tooltips: the working behind each figure (only on this computer)
  // ---------------------------------------------------------------------------
  function sharesText(v) { return Fmt.num(v, v < 10 ? 6 : 3) + 'mn shares'; }

  function sourceText(label, input) {
    if (!input || input.source === null) { return label + ': no source'; }
    if (input.source === 'YAHOO_PLACEHOLDER') { return label + ': Yahoo Finance placeholder, not BTG'; }
    return label + ': ' + input.source + (input.last_updated ? ' (updated ' + Fmt.date(input.last_updated) + ')' : '');
  }

  function marketCapWorking(A, row, year) {
    var y = row.byYear[year], mc = y.mc, unit = row.company.fin_unit;
    var rc = Calc.FIN_UNITS[unit] ? Calc.FIN_UNITS[unit].currency : null;
    var yearEnd = y.basis === 'year_end';
    var out = ['Mkt cap = sum of price × shares over all share classes, in ' + Fmt.finUnit(unit) +
               (yearEnd ? ', at ' + year + ' year-end prices (YE_Prices)' : ', at live prices')];
    var times = [];
    mc.parts.forEach(function (p) {
      out.push(p.line_id + ': ' + Fmt.price(p.price, p.currency) + ' ' + Fmt.ccyLabel(p.currency) + ' × ' + sharesText(p.shares_mn));
      if (yearEnd) {
        var ye = (A.btg.ye_prices || []).filter(function (r) { return r.line_id === p.line_id && r.year === year; })[0];
        if (ye && ye.close_date) { times.push('close ' + Fmt.date(ye.close_date)); }
      } else {
        var m = A.marketLine(p.line_id);
        if (m && m.last_trade_time) { times.push(m.last_trade_time); }
      }
      if (p.currency !== rc) {
        var rates = [p.currency, rc].filter(function (c) { return c !== 'USD'; }).map(function (c) {
          return 'US$/' + c + ' ' + Fmt.num(y.fx['USD' + c], 4);
        });
        out.push('  ' + Fmt.ccyLabel(p.currency) + ' → ' + Fmt.ccyLabel(rc) + (rates.length > 1 ? ' through US$' : '') + ' at ' + rates.join(' and ') +
                 (yearEnd ? ' (year-end)' : ' (live)'));
      }
    });
    out.push('= ' + Fmt.finAmount(mc.value, unit));
    var priceSource = yearEnd
      ? 'prices YE_Prices (' + times.filter(function (t, i) { return times.indexOf(t) === i; }).join(', ') + ')'
      : 'prices Yahoo Finance' + (times.length ? ', last trade ' + Fmt.dateTime(times.sort().pop(), false) + ' (Bogotá)' : '');
    var shareSources = A.btg.lines.filter(function (l) { return l.company_id === row.company.company_id; }).map(function (l) {
      return l.line_id + ' ' + (l.shares_source === 'YAHOO_PLACEHOLDER' ? 'Yahoo placeholder' : l.shares_source) +
             (l.shares_as_of ? ' as of ' + Fmt.date(l.shares_as_of) : '');
    });
    return { lines: out, sources: [priceSource, 'shares Coverage (' + shareSources.join('; ') + ')'] };
  }

  function working(A, row, key, year) {
    var y = row.byYear[year], unit = row.company.fin_unit, r = y[key], label = yearLabel(A, year);
    var amount = function (input) { return Fmt.finAmount(input.value, unit); };
    var result = Fmt.result(r, Fmt[key === 'roe' || key === 'dy' ? 'percent' : 'multiple']);
    var inp = y.inputs, lines = [], sources = [], mcw;
    switch (key) {
      case 'pe':
        mcw = marketCapWorking(A, row, year);
        lines = ['P/E ' + label + ' = Mkt cap ÷ Net income', '= ' + Fmt.finAmount(y.mc.value, unit) + ' ÷ ' + amount(inp.NET_INCOME) + ' = ' + result, ''].concat(mcw.lines);
        sources = mcw.sources.concat([sourceText('net income', inp.NET_INCOME)]);
        break;
      case 'pbv':
        mcw = marketCapWorking(A, row, year);
        lines = ['P/BV ' + label + ' = Mkt cap ÷ Equity', '= ' + Fmt.finAmount(y.mc.value, unit) + ' ÷ ' + amount(inp.EQUITY) + ' = ' + result, ''].concat(mcw.lines);
        sources = mcw.sources.concat([sourceText('equity', inp.EQUITY)]);
        break;
      case 'ev_ebitda':
        mcw = marketCapWorking(A, row, year);
        var minorities = inp.MINORITIES.value === null ? Fmt.finAmount(0, unit) + ' (blank = 0)' : amount(inp.MINORITIES);
        lines = ['EV/EBITDA ' + label + ' = (Mkt cap + Net debt + Minorities) ÷ EBITDA',
                 '= (' + Fmt.finAmount(y.mc.value, unit) + ' + ' + amount(inp.NET_DEBT) + ' + ' + minorities + ') ÷ ' + amount(inp.EBITDA) + ' = ' + result, ''].concat(mcw.lines);
        sources = mcw.sources.concat([sourceText('net debt', inp.NET_DEBT),
          inp.MINORITIES.value === null ? 'minorities: blank, counted as 0' : sourceText('minorities', inp.MINORITIES), sourceText('EBITDA', inp.EBITDA)]);
        break;
      case 'nd_ebitda':
        lines = ['Net debt/EBITDA ' + label + ' = Net debt ÷ EBITDA', '= ' + amount(inp.NET_DEBT) + ' ÷ ' + amount(inp.EBITDA) + ' = ' + result];
        sources = [sourceText('net debt', inp.NET_DEBT), sourceText('EBITDA', inp.EBITDA)];
        break;
      case 'roe':
        lines = ['ROE ' + label + ' = ' + result + ' (an input: Estimates, ROE_PCT)'];
        sources = [sourceText('ROE', inp.ROE_PCT)];
        break;
      case 'dy':
        var p = y.price, cur = p.currency;
        lines = ['Div yield ' + label + ' = DPS ÷ price (' + p.line_id + ')',
                 '= ' + Fmt.dps(y.dps.value, cur) + ' ' + Fmt.ccyLabel(cur) + ' ÷ ' + Fmt.price(p.price, cur) + ' ' + Fmt.ccyLabel(cur) + ' = ' + result];
        sources = [sourceText('DPS', y.dps), y.basis === 'year_end'
          ? 'price YE_Prices (' + year + ' close' + (p.price_date ? ' ' + Fmt.date(p.price_date) : '') + ')'
          : 'price Yahoo Finance' + (p.price_time ? ' (last trade ' + Fmt.dateTime(p.price_time, false) + ')' : '')];
        break;
    }
    return lines.join('\n') + '\n\nSources: ' + sources.join('; ');
  }

  // ---------------------------------------------------------------------------
  // Cells
  // ---------------------------------------------------------------------------
  function reasonText(A, r, year) {
    if (r.status === 'none') { return 'Not applicable to financials.'; }
    var why = String(r.reason || 'missing input');
    return (r.status === 'nm' ? 'n.m. (not meaningful), ' : 'n.a., ') + yearLabel(A, year) + ': ' +
           why.charAt(0).toUpperCase() + why.slice(1) + '.';
  }

  function metricCell(A, row, group, year, first) {
    var r = row.byYear[year][group.key];
    var text = Fmt.result(r, Fmt[group.format]);
    var cls = 'num' + (first ? ' group-start' : '');
    if (r.status !== 'ok') {
      return '<td class="' + cls + '"><span' + App.tip(reasonText(A, r, year)) + '>' + text + '</span></td>';
    }
    var inner = '<span' + App.tip(A.audit ? working(A, row, group.key, year) : '') + '>' + text + '</span>';
    return '<td class="' + cls + '">' + (r.placeholder ? '<span class="placeholder">' + inner + '</span>' + App.mark(MULTIPLE_TIP) : inner) + '</td>';
  }

  // ---------------------------------------------------------------------------
  // Model, sorting and filtering
  // ---------------------------------------------------------------------------
  function sortValue(row, key) {
    if (key === 'name') { return App.deaccent(row.company.company_name); }
    if (key === 'rating') { return row.primary ? App.ratingOrder(row.primary.rating) : null; }
    if (key === 'price') { return row.price; }
    var parts = key.split('|'), r = row.byYear[parts[1]] && row.byYear[parts[1]][parts[0]];
    return r && r.status === 'ok' ? r.value : null;
  }

  function filterRows(A, rows) {
    var q = App.deaccent(ui.q).trim();
    return rows.filter(function (row) {
      if (ui.sector !== 'ALL' && row.company.sector !== ui.sector) { return false; }
      if (!q) { return true; }
      var ids = A.btg.lines.filter(function (l) { return l.company_id === row.company.company_id; })
        .map(function (l) { return l.line_id + ' ' + l.display_label; }).join(' ');
      return App.deaccent(row.company.company_name + ' ' + ids).indexOf(q) >= 0;
    });
  }

  function sortButton(key, label) {
    var active = ui.sort === key;
    return '<button type="button" class="sort-btn" data-sort="' + App.esc(key) + '">' + App.esc(label) +
           (active ? '<span class="arrow" aria-hidden="true">' + (ui.dir > 0 ? '▲' : '▼') + '</span>' : '') + '</button>';
  }
  function ariaSort(key) { return ui.sort === key ? (ui.dir > 0 ? 'ascending' : 'descending') : 'none'; }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  function tableHtml(A, years, rows) {
    var columns = 3 + GROUPS.length * years.length;
    var html = '<thead><tr class="group-row">' +
      '<th scope="col" rowspan="2" class="sortable" aria-sort="' + ariaSort('name') + '">' + sortButton('name', 'Company') + '</th>' +
      '<th scope="col" rowspan="2" class="sortable" aria-sort="' + ariaSort('rating') + '">' + sortButton('rating', 'BTG Pactual Rating') + '</th>' +
      '<th scope="col" rowspan="2" class="sortable num" aria-sort="' + ariaSort('price') + '">' + sortButton('price', 'Stock Price (LC)') + '</th>' +
      GROUPS.map(function (g) {
        return '<th scope="colgroup" colspan="' + years.length + '" class="group-head group-start">' + App.esc(g.label) + '</th>';
      }).join('') + '</tr><tr class="year-row">' +
      GROUPS.map(function (g) {
        return years.map(function (y, i) {
          var key = g.key + '|' + y;
          return '<th scope="col" class="sortable num' + (i === 0 ? ' group-start' : '') + '" aria-sort="' + ariaSort(key) + '"' +
                 ' aria-label="' + App.esc(g.name + ' ' + yearLabel(A, y)) + '">' + sortButton(key, yearLabel(A, y)) + '</th>';
        }).join('');
      }).join('') + '</tr></thead><tbody>';

    A.btg.sectors.forEach(function (sector) {
      var inSector = rows.filter(function (r) { return r.company.sector === sector; });
      if (!inSector.length) { return; }
      if (ui.sort) { inSector = App.sortRows(inSector, function (r) { return sortValue(r, ui.sort); }, ui.dir); }
      html += '<tr class="band"><td colspan="' + columns + '"><span class="band-label">' + App.esc(sector) +
              '<span class="band-count">' + inSector.length + (inSector.length === 1 ? ' company' : ' companies') + '</span></span></td></tr>';
      inSector.forEach(function (row) {
        var l = row.primary;
        html += '<tr class="row"><td class="company">' + App.esc(row.company.company_name) + '</td>' +
          '<td>' + (l ? App.ratingPill(l) : 'n.a.') + '</td>' +
          '<td class="num">' + (l ? App.priceCell(l, row.market, row.price) : 'n.a.') + '</td>' +
          GROUPS.map(function (g) {
            return years.map(function (y, i) { return metricCell(A, row, g, y, i === 0); }).join('');
          }).join('') + '</tr>';
      });
    });
    return html + '</tbody>';
  }

  function hasPlaceholder(row, years) {
    var l = row.primary;
    if (l && l.rating !== 'TBD' && l.rating_tp_source === 'PLACEHOLDER') { return true; }
    return years.some(function (y) {
      return GROUPS.some(function (g) { var r = row.byYear[y][g.key]; return r.status === 'ok' && r.placeholder; });
    });
  }

  function update(host, A) {
    var model = Calc.valuation(A.btg, A.market());
    var rows = filterRows(A, model.companies);
    host.querySelector('#vtTable').innerHTML = tableHtml(A, model.years, rows);
    host.querySelector('#vtEmpty').hidden = rows.length > 0;
    host.querySelector('#vtCount').textContent = 'Showing ' + rows.length + ' of ' + model.companies.length + ' companies';
    host.querySelector('#vtBanner').innerHTML = rows.some(function (r) { return hasPlaceholder(r, model.years); })
      ? A.banner('info', App.PLACEHOLDER_BANNER) : '';
    host.querySelectorAll('[data-sector]').forEach(function (b) {
      b.setAttribute('aria-pressed', b.getAttribute('data-sector') === ui.sector ? 'true' : 'false');
    });
  }

  function render(host, A) {
    var actual = A.btg.years.actual;
    var frozen = A.btg.config.historical_price_basis === 'year_end';
    host.innerHTML =
      '<div id="vtBanner"></div>' +
      '<section class="panel" aria-labelledby="vtTitle">' +
        '<div class="panel-head"><span id="vtTitle">Valuation by sector</span><span class="spacer"></span>' +
          '<span class="ctrls"><span class="ctrl-group" role="group" aria-label="Filter by sector">' + App.sectorChips() + '</span></span>' +
        '</div>' +
        '<div class="controls">' +
          '<input type="search" class="search" id="vtSearch" placeholder="Search company or ticker…" aria-label="Search company or ticker" value="' + A.esc(ui.q) + '">' +
          '<span class="count" id="vtCount" aria-live="polite"></span>' +
        '</div>' +
        '<div class="table-scroll"><table class="data valuation" id="vtTable"></table>' +
          '<div class="empty" id="vtEmpty" hidden>No companies match the search or filter.</div></div>' +
        '<div class="panel-note">' +
          '<p><strong>' + (frozen ? actual + ' multiples use ' + actual + ' year-end prices.' : actual + ' multiples use live prices.') + '</strong> ' +
          'Estimate years use live prices and FX.</p>' +
          '<p>Multiples use company totals: market cap adds up every share class, in the company’s reporting currency. ' +
          'P/E = market cap ÷ net income; EV/EBITDA = (market cap + net debt + minorities) ÷ EBITDA; P/BV = market cap ÷ equity; ' +
          'ROE is BTG Pactual’s figure. Rating, price and dividend yield (DPS paid in the year ÷ price) are for the primary share class.</p>' +
          '<p>– not applicable to financials. n.m. not meaningful (zero or negative denominator). n.a. not available. ' +
          '◦ placeholder, not a BTG Pactual figure. TBD: rating not yet available.' +
          (A.audit ? ' Hover over any figure to see the calculation and its sources (shown only on this computer).' : '') + '</p>' +
        '</div>' +
      '</section>';

    host.addEventListener('click', function (e) {
      var chip = e.target.closest('[data-sector]');
      if (chip) { ui.sector = chip.getAttribute('data-sector'); update(host, A); return; }
      var sort = e.target.closest('[data-sort]');
      if (sort) {
        var key = sort.getAttribute('data-sort');
        if (ui.sort === key) { ui.dir = -ui.dir; } else { ui.sort = key; ui.dir = (key === 'name' || key === 'rating') ? 1 : -1; }
        update(host, A);
        var again = host.querySelector('[data-sort="' + key + '"]');
        if (again) { again.focus(); }
      }
    });
    host.querySelector('#vtSearch').addEventListener('input', function () { ui.q = this.value; update(host, A); });
    update(host, A);
  }

  window.TabValuation = { render: render };
})();

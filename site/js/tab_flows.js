/* =============================================================================
   tab_flows.js — the Equity Flows tab (SPEC §9.4; layout of pages 3–6 of the August Equity Flows note).

   A month selector (default: the latest month with data) drives every section:
     1. Chart 1  monthly net flows by investor type, 13 months
     2. Chart 2  L12M monthly average
     3. Chart 3  annual cumulative flows, 2016 to year to date (from the months, DECISIONS D18)
     4. Table 1  asset allocation by investor type (US$mn and %)
     5. Tables 2–7  top 5 net purchases and sales for six investor types, four windows
     6. Table 8  asset allocation by security (confirmed by Juan, 17 Sep 2026)
   A red banner shows while any flows row is sample (DUMMY) data.
   Every figure comes from calc.js; charts use Chart.js 4.5.1 (DECISIONS D3) with the colour tokens of tokens.css.
   ============================================================================= */
(function () {
  'use strict';

  var CHART_INVESTORS = ['PENSION', 'FOREIGN', 'RETAIL', 'BROKERS', 'MUTUAL', 'CORPORATE'];     // note's legend order
  var COLOUR_TOKEN = { PENSION: '--flow-pension', FOREIGN: '--flow-foreign', RETAIL: '--flow-retail',
                       BROKERS: '--flow-brokers', MUTUAL: '--flow-mutual', CORPORATE: '--flow-corporate' };
  var LABELLED = ['PENSION', 'FOREIGN'];                // bars with value labels in Charts 1 and 3, as in the note
  var TABLE1_ROWS = ['FOREIGN', 'PENSION', 'MUTUAL', 'RETAIL', 'CORPORATE', 'BROKERS', 'OTHERS'];
  var SECTOR_LABELS = { CEMENT_CONSTRUCTION: 'Cement & Construction', FINANCIALS: 'Financials', OG: 'O&G', OTHERS: 'Others',
                        RETAIL: 'Retail', UTILITIES: 'Utilities', ETF: 'ETF' };
  var CARDS = [                                          // SPEC §9.4 order and titles
    { id: 'PENSION', title: 'Pension Funds' }, { id: 'FOREIGN', title: 'Foreign Funds' }, { id: 'CORPORATE', title: 'Corporates' },
    { id: 'RETAIL', title: 'Retail Investors' }, { id: 'MUTUAL', title: 'Mutual Funds' }, { id: 'BROKERS', title: 'Brokers' }
  ];
  var WINDOWS = [{ id: 'M', label: null }, { id: 'L3M', label: 'Last 3 Months' }, { id: 'L6M', label: 'Last 6 Months' },
                 { id: 'L12M', label: 'Last 12 Months' }];
  var TABLE8_COLUMNS = ['FOREIGN', 'PENSION', 'RETAIL', 'CORPORATE', 'BROKERS', 'MUTUAL', 'OTHERS'];
  var FIRST_YEAR = 2016;                                 // SPEC §8.7: Chart 3 starts in 2016
  var SOURCE = 'Source: BVC and BTG Pactual.';
  var ui = { month: null };
  var charts = [];

  function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
  function flows(A) { return A.btg.flows || {}; }
  function label(A, id, kind) {
    var t = (flows(A).investor_types || []).filter(function (x) { return x.id === id; })[0];
    return t ? (kind === 'chart' ? t.chart_label : t.table_label) || t.table_label : id;
  }
  function months(A) {
    return (flows(A).monthly || []).map(function (r) { return r.month; }).sort();
  }
  function signClass(v, text) {
    if (typeof v !== 'number' || /^\(?0\.0+\)?%?$/.test(text)) { return ''; }
    return v > 0 ? 'up' : v < 0 ? 'down' : '';
  }

  // ---------------------------------------------------------------------------
  // Charts (Chart.js, styled with the RIGI chart tokens, DESIGN_NOTES §7)
  // ---------------------------------------------------------------------------
  function destroyCharts() {
    charts.forEach(function (c) { c.destroy(); });
    charts = [];
  }

  /* Draws value labels above positive bars and below negative ones, for the chosen investor types. */
  function valueLabels(ids, decimals) {
    return {
      id: 'valueLabels',
      afterDatasetsDraw: function (chart) {
        var ctx = chart.ctx;
        ctx.save();
        ctx.font = '700 11px ' + css('--font');
        ctx.fillStyle = css('--chart-ink');
        ctx.textAlign = 'center';
        chart.data.datasets.forEach(function (ds, i) {
          if (ids !== 'all' && ids.indexOf(ds.investor) < 0) { return; }
          chart.getDatasetMeta(i).data.forEach(function (bar, j) {
            var v = ds.data[j];
            if (typeof v !== 'number') { return; }
            ctx.textBaseline = v >= 0 ? 'bottom' : 'top';
            ctx.fillText(Fmt.num(v, decimals), bar.x, v >= 0 ? bar.y - 3 : bar.y + 3);
          });
        });
        ctx.restore();
      }
    };
  }

  function barChart(canvas, labels, datasets, opts) {
    var font = { family: css('--font'), size: 11 };
    var chart = new window.Chart(canvas, {
      type: 'bar',
      data: { labels: labels, datasets: datasets },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        layout: { padding: { top: 18 } },
        plugins: {
          legend: { position: 'bottom', labels: { boxWidth: 11, boxHeight: 11, color: css('--chart-label'), font: font, padding: 18 } },
          tooltip: { callbacks: { label: function (c) { return c.dataset.label + ': ' + Fmt.num(c.parsed.y, 1) + ' US$mn'; } } }
        },
        scales: {
          x: { grid: { display: false }, ticks: { color: css('--chart-axis'), font: font } },
          y: {
            title: { display: true, text: opts.yTitle, color: css('--chart-axis'), font: font },
            ticks: { color: css('--chart-axis'), font: font, callback: function (v) { return Fmt.num(v, 0); } },
            grid: { color: function (c) { return c.tick && c.tick.value === 0 ? css('--chart-rule') : css('--chart-grid'); } },
            border: { display: false }
          }
        }
      },
      plugins: [valueLabels(opts.labelled, opts.decimals)]
    });
    charts.push(chart);
  }

  function dataset(A, id, data) {
    return { label: label(A, id, 'chart'), investor: id, data: data, backgroundColor: css(COLOUR_TOKEN[id]),
             borderWidth: 0, categoryPercentage: 0.82, barPercentage: 0.92 };
  }

  /* Each draw starts from a fresh canvas: a box may hold a message from an earlier month. */
  function freshCanvas(host, id) {
    var box = host.querySelector('#' + id + 'Box');
    box.innerHTML = '<canvas id="' + id + '" role="img" aria-label="' + App.esc(box.getAttribute('data-title')) + '"></canvas>';
    return box.firstChild;
  }

  function drawCharts(host, A, month) {
    destroyCharts();
    ['flChart1', 'flChart2', 'flChart3'].forEach(function (id) { freshCanvas(host, id); });
    if (!window.Chart) {
      host.querySelectorAll('.chart-box').forEach(function (box) {
        box.innerHTML = '<div class="empty">The charts need an internet connection (the chart library loads from cdnjs). The tables below still work.</div>';
      });
      return;
    }
    var f = flows(A);
    var m13 = Calc.monthlyFlows(f.monthly, month, 13);
    barChart(host.querySelector('#flChart1'), m13.map(function (r) { return Fmt.monthShort(r.month); }),
      CHART_INVESTORS.map(function (id) { return dataset(A, id, m13.map(function (r) { return r.values ? r.values[id] : null; })); }),
      { yTitle: 'US$mn', labelled: LABELLED, decimals: 1 });

    var avg = Calc.averageFlows(f.monthly, month, CHART_INVESTORS);
    var box2 = host.querySelector('#flChart2Box');
    if (avg.status === 'ok') {
      barChart(host.querySelector('#flChart2'), ['L12M average'],
        CHART_INVESTORS.map(function (id) { return dataset(A, id, [avg.value[id]]); }),
        { yTitle: 'US$mn, monthly average', labelled: 'all', decimals: 1 });
    } else {
      box2.innerHTML = '<div class="empty">Needs ' + avg.needs + ' more month' + (avg.needs === 1 ? '' : 's') + ' of data.</div>';
    }

    var years = Calc.annualFlows(f.monthly, month, CHART_INVESTORS, FIRST_YEAR);
    barChart(host.querySelector('#flChart3'), years.map(function (y) {
      return (y.ytd ? 'YTD ' + y.year : String(y.year)) + (y.complete ? '' : '*');
    }), CHART_INVESTORS.map(function (id) {
      return dataset(A, id, years.map(function (y) { return y.values ? y.values[id] : null; }));
    }), { yTitle: 'US$mn, cumulative', labelled: LABELLED, decimals: 0 });
    var incomplete = years.filter(function (y) { return !y.complete; });
    host.querySelector('#flChart3Note').textContent = incomplete.length
      ? '* Incomplete year: ' + incomplete.map(function (y) { return y.year + ' (' + y.months + ' of ' + y.expected + ' months)'; }).join(', ') + '. '
      : '';
  }

  // ---------------------------------------------------------------------------
  // Tables
  // ---------------------------------------------------------------------------
  function table1(A, month) {
    var sectors = flows(A).allocation_sectors || [];
    var rows = Calc.allocationTable(flows(A).allocation, month, TABLE1_ROWS, sectors);
    var head = function (title) {
      return '<tr class="flows-head"><th scope="col">' + App.esc(title) + '</th>' + sectors.map(function (s) {
        return '<th scope="col" class="num">' + App.esc(SECTOR_LABELS[s] || s) + '</th>';
      }).join('') + '<th scope="col" class="num">Total</th></tr>';
    };
    var html = '<thead>' + head('Asset allocation – US$mn') + '</thead><tbody>';
    rows.forEach(function (r) {
      html += '<tr class="row"><td class="company">' + App.esc(label(A, r.investor, 'table')) + '</td>';
      if (r.status !== 'ok') { return (html += '<td colspan="' + (sectors.length + 1) + '" class="muted">n.a.: no allocation row for this month</td></tr>'); }
      sectors.concat(['TOTAL']).forEach(function (s) {
        var v = s === 'TOTAL' ? r.total : r.values[s], text = Fmt.paren(v, 1);
        html += '<td class="num"><span class="' + signClass(v, text) + '">' + text + '</span></td>';
      });
      html += '</tr>';
    });
    html += head('Asset allocation – %');
    rows.forEach(function (r) {
      html += '<tr class="row"><td class="company">' + App.esc(label(A, r.investor, 'table')) + '</td>';
      if (r.status !== 'ok') { return (html += '<td colspan="' + (sectors.length + 1) + '" class="muted">n.a.</td></tr>'); }
      sectors.concat(['TOTAL']).forEach(function (s) {
        var p = r.pct[s], text = Fmt.result(p, Fmt.percent);
        var tip = A.audit && p.status === 'ok' ? '= ' + Fmt.paren(s === 'TOTAL' ? r.total : r.values[s], 1) + ' ÷ ' + Fmt.paren(r.total, 1) + ' (row total)' : '';
        html += '<td class="num"><span class="' + (s === 'TOTAL' ? '' : signClass(p.value, text)) + '"' + App.tip(tip) + '>' + text + '</span></td>';
      });
      html += '</tr>';
    });
    return html + '</tbody>';
  }

  function top5Card(A, card, month) {
    var f = flows(A);
    var body = '';
    WINDOWS.forEach(function (w) {
      var r = Calc.topFive(f.by_security, f.security_map, f.top5_override, month, w.id, card.id);
      var title = w.label || Fmt.monthLong(month);
      body += '<tr class="band"><td colspan="4"><span class="band-label">' + App.esc(title) +
              (r.status === 'manual' ? '<span class="manual-pill"' + App.tip('Entered by hand in the Flows_Top5_Override sheet, not calculated.') + '>manual</span>' : '') +
              '</span></td></tr>';
      if (r.status === 'na') {
        body += '<tr class="row"><td colspan="4" class="muted">Needs ' + r.needs + ' more month' + (r.needs === 1 ? '' : 's') + ' of data.</td></tr>';
        return;
      }
      var tip = function (x) {
        return A.audit && r.status === 'ok'
          ? x.nemo + ': sum of Flows_BySecurity, ' + label(A, card.id, 'table') + ', ' + Fmt.month(r.months[0]) + ' to ' + Fmt.month(month) +
            ' = ' + Fmt.num(x.value, 2) + ' US$mn'
          : '';
      };
      for (var i = 0; i < 5; i++) {
        var b = r.buys[i], s = r.sells[i];
        body += '<tr class="row">' +
          '<td>' + (b ? App.esc(b.nemo) : '') + '</td><td class="num">' + (b ? '<span' + App.tip(tip(b)) + '>' + Fmt.num(b.value, 1) + '</span>' : '') + '</td>' +
          '<td class="split">' + (s ? App.esc(s.nemo) : '') + '</td><td class="num">' + (s ? '<span' + App.tip(tip(s)) + '>' + Fmt.num(s.value, 1) + '</span>' : '') + '</td>' +
          '</tr>';
      }
    });
    return '<section class="panel top5" aria-label="' + App.esc(card.title + ': top 5 net purchases and sales') + '">' +
      '<div class="panel-head">' + App.esc(card.title) + ' — top 5 purchases and sales (US$mn)</div>' +
      '<div class="table-scroll"><table class="data top5-table"><thead><tr>' +
        '<th scope="col" colspan="2">Main net purchases</th><th scope="col" colspan="2" class="split">Main net sales</th>' +
      '</tr></thead><tbody>' + body + '</tbody></table></div></section>';
  }

  function table8(A, month) {
    var t = Calc.securityTable(flows(A).by_security, flows(A).security_map, month, TABLE8_COLUMNS);
    var html = '<thead><tr><th scope="col">Nemo</th>' + TABLE8_COLUMNS.map(function (id) {
      return '<th scope="col" class="num">' + App.esc(label(A, id, 'table')) + '</th>';
    }).join('') + '<th scope="col" class="num">Total</th></tr></thead><tbody>';
    var cell = function (v) {
      var text = typeof v === 'number' && Math.abs(v) >= 0.005 ? Fmt.paren(v, 2) : '–';
      return '<td class="num"><span class="' + (text === '–' ? '' : signClass(v, text)) + '">' + text + '</span></td>';
    };
    t.rows.forEach(function (r) {
      var tip = r.combined ? 'Adds up ' + r.lines.join(' and ') + ' (built by the site)' : '';
      html += '<tr class="row' + (r.combined ? ' combined' : '') + '"><td class="company"><span' + App.tip(tip) + '>' + App.esc(r.nemo) + '</span></td>' +
        TABLE8_COLUMNS.map(function (id) { return cell(r.values[id]); }).join('') + cell(r.total) + '</tr>';
    });
    html += '<tr class="grand"><td>Total</td>' + TABLE8_COLUMNS.map(function (id) { return cell(t.totals[id]); }).join('') + cell(t.total) + '</tr>';
    return html + '</tbody>';
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  function update(host, A) {
    var month = ui.month;
    host.querySelector('#flTable1').innerHTML = table1(A, month);
    host.querySelector('#flTop5').innerHTML = CARDS.map(function (c) { return top5Card(A, c, month); }).join('');
    host.querySelector('#flTable8').innerHTML = table8(A, month);
    host.querySelector('#flTable8Title').textContent = 'Table 8 — Asset allocation by security, ' + Fmt.month(month) + ' (US$mn)';
    host.querySelector('#flTable1Title').textContent = 'Table 1 — Asset allocation by investor type, ' + Fmt.month(month);
    drawCharts(host, A, month);
  }

  function chartPanel(id, title, height, note) {
    return '<section class="panel" aria-labelledby="' + id + 'Title"><div class="panel-head" id="' + id + 'Title">' + App.esc(title) + '</div>' +
      '<div class="chart-scroll"><div class="chart-box" id="' + id + 'Box" data-title="' + App.esc(title) + '" style="height:' + height + 'px"></div></div>' +
      '<div class="panel-note"><p>' + (note || '') + SOURCE + '</p></div></section>';
  }

  function render(host, A) {
    destroyCharts();
    var list = months(A);
    if (!list.length) {
      host.innerHTML = '<section class="panel"><div class="coming"><h3>No flows data yet</h3>' +
        '<p>Fill in the Flows sheets of the workbook and publish (2_publish_excel_changes.bat).</p></div></section>';
      return;
    }
    if (!ui.month || list.indexOf(ui.month) < 0) { ui.month = list[list.length - 1]; }
    var dummy = (A.btg.status && A.btg.status.dummy_flows) || (flows(A).monthly || []).some(function (r) { return r.source === 'DUMMY'; });
    host.innerHTML =
      (dummy ? A.banner('', 'Sample data — not real BVC flows.') : '') +
      '<div class="flows-bar"><label class="range-label" for="flMonth">Month</label>' +
        '<select id="flMonth" class="date-input">' + list.slice().reverse().map(function (m) {
          return '<option value="' + m + '"' + (m === ui.month ? ' selected' : '') + '>' + Fmt.month(m) + '</option>';
        }).join('') + '</select>' +
        '<span class="count">All figures US$mn, net (positive = net purchase). Every section follows the month selected.</span></div>' +
      chartPanel('flChart1', 'Chart 1 — Equity market flows: buyers and sellers, monthly (US$mn)', 340,
                 'The 13 months to the selected month. Labels on Pension Funds and Foreigners + ADRs, as in the note. ') +
      '<div class="flows-pair">' +
        chartPanel('flChart2', 'Chart 2 — L12M monthly average (US$mn)', 300, 'Average of the 12 months to the selected month. ') +
        chartPanel('flChart3', 'Chart 3 — Annual cumulative flows (US$mn)', 300,
                   '<span id="flChart3Note"></span>Sum of each year’s months; the last year runs to the selected month. ') +
      '</div>' +
      '<section class="panel" aria-labelledby="flTable1Title"><div class="panel-head" id="flTable1Title">Table 1</div>' +
        '<div class="table-scroll"><table class="data flows-table" id="flTable1"></table></div>' +
        '<div class="panel-note"><p>% = value ÷ the row total. ' + SOURCE + '</p></div></section>' +
      '<div class="top5-grid" id="flTop5"></div>' +
      '<p class="flows-note">Tables 2–7: the five largest net purchases and sales per security over the selected month and the 3, 6 and 12 months to it, ' +
        'from Flows_BySecurity. Only securities marked include_in_top5 = Y in Flows_SecurityMap count; combined PF & ORD rows never do. ' + SOURCE + '</p>' +
      '<section class="panel" aria-labelledby="flTable8Title"><div class="panel-head" id="flTable8Title">Table 8</div>' +
        '<div class="table-scroll"><table class="data flows-table" id="flTable8"></table></div>' +
        '<div class="panel-note"><p>Every security traded in the month, A–Z. PF & ORD rows add up a company’s share classes ' +
        '(built by the site from Flows_SecurityMap). – = no net flow. ' + SOURCE + '</p></div></section>';

    host.querySelector('#flMonth').addEventListener('change', function () { ui.month = this.value; update(host, A); });
    update(host, A);
  }

  window.TabFlows = { render: render };
})();

/* =============================================================================
   app.js — the page shell: sidebar navigation, header strip, Refresh prices button,
   footer, tooltips, banners and the mobile menu (SPEC §2, §5, §7.5, §10).

   Data comes from data/btg_data.js (window.BTG_DATA, published from the Excel workbook) and
   data/market_data.js (window.MARKET_DATA, Yahoo Finance).

   Prices (DECISIONS D21): on the published website, GitHub rewrites data/market_data.js about
   every 10 minutes in market hours. Refresh prices, and an automatic check every few minutes,
   load that file again; if the prices changed, every tab is redrawn. On Juan's computer the
   same button reloads the file that run\1_refresh_prices.bat / 3_open_dashboard.bat saved.
   No server is needed. No figures are calculated here: the tabs use calc.js.
   ============================================================================= */
(function () {
  'use strict';

  var BTG = window.BTG_DATA;
  var MARKET = window.MARKET_DATA;
  var $ = function (id) { return document.getElementById(id); };

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  if (!BTG || !MARKET || !window.Calc || !window.Fmt) {
    var problems = [];
    if (!BTG) { problems.push('The BTG data file (site\\data\\btg_data.js) is missing. Double-click run\\2_publish_excel_changes.bat, then reload this page.'); }
    if (!MARKET) { problems.push('The price file (site\\data\\market_data.js) is missing. Double-click run\\1_refresh_prices.bat, then reload this page.'); }
    if (!window.Calc || !window.Fmt) { problems.push('A dashboard program file (site\\js) is missing. Keep the site folder complete.'); }
    $('loadError').innerHTML = '<strong>The dashboard could not start.</strong><br>' + problems.map(esc).join('<br>');
    $('loadError').hidden = false;
    return;
  }

  var TABS = [
    { id: 'stock-information', label: 'Stock Information', strip: 'Coverage universe', module: 'TabStockInfo',
      intro: 'Ratings, target prices, upside, dividends and market capitalisation for BTG Pactual’s Colombia coverage.' },
    { id: 'valuation', label: 'Valuation Tracker', strip: 'Valuation universe', stage: 4,
      what: 'P/E, EV/EBITDA, P/BV, net debt/EBITDA, ROE and dividend yield for the actual and estimate years.' },
    { id: 'performance', label: 'Stock Performance', strip: 'Stock performance', stage: 5,
      what: '1D, MTD, YTD, 1Y and custom-range returns: price and total return, in local currency and US$.' },
    { id: 'flows', label: 'Equity Flows', strip: 'Equity flows', stage: 6,
      what: 'Monthly BVC flows by investor type, allocation by sector, and the top 5 net purchases and sales.' }
  ];

  // This computer (file opened directly, or a local test server) rather than the published website.
  var LOCAL = location.protocol === 'file:' || /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  var MARKET_FILE = 'data/market_data.js';
  var CHECK_EVERY_MS = 5 * 60 * 1000;      // an open page looks for newer prices this often
  var LOAD_TIMEOUT_MS = 30 * 1000;

  var state = {
    market: MARKET,
    tab: null,
    busy: false,        // a check the visitor asked for is running (spinner)
    loading: false,     // any check is running
    lastCheck: 0,
    failure: null,      // message after a failed check the visitor asked for
    note: null          // message after a check that found nothing newer
  };

  var App = {
    btg: BTG,
    esc: esc,
    audit: BTG.config.audit_tooltips === 'local_only' && LOCAL,
    market: function () { return state.market; },
    fx: function () {
      var f = state.market.fx || {};
      return { USDCOP: f.USDCOP ? f.USDCOP.last : null, USDCAD: f.USDCAD ? f.USDCAD.last : null };
    },
    marketLine: function (id) { return (state.market.lines || {})[id] || null; },
    yearLabel: function (y) { return Fmt.yearLabel(y, BTG.years.actual); },
    banner: function (kind, text) { return '<div class="banner ' + kind + '" role="note">' + esc(text) + '</div>'; },
    tip: function (text) { return text ? ' data-tip="' + esc(text) + '" tabindex="0"' : ''; }
  };
  window.App = App;

  // ---------------------------------------------------------------------------
  // Shell: title, logo link, sidebar, analysts, footer
  // ---------------------------------------------------------------------------
  function buildShell() {
    var title = BTG.config.site_title || 'Colombia Strategy Dashboard';
    document.title = title + ' | BTG Pactual Research';
    $('siteTitle').textContent = title;
    $('sideTitle').textContent = title;
    if (BTG.config.research_portal_url) { $('logoLink').href = BTG.config.research_portal_url; }

    $('tabs').innerHTML = TABS.map(function (t) {
      return '<button type="button" class="tab" role="tab" id="tab-' + t.id + '" data-tab="' + t.id +
             '" aria-controls="view" aria-selected="false" tabindex="-1">' + esc(t.label) + '</button>';
    }).join('');

    var analysts = BTG.analysts || [];
    $('analysts').insertAdjacentHTML('beforeend', analysts.map(function (a) {
      return '<div class="side-analyst"><div class="side-analyst-name">' + esc(a.name) + '</div>' +
             '<a href="mailto:' + esc(a.email) + '">' + esc(a.email) + '</a></div>';
    }).join(''));
    $('footerNames').textContent = analysts.map(function (a) { return a.name; }).join(' · ');
    $('footerEmails').innerHTML = analysts.map(function (a) {
      return '<a href="mailto:' + esc(a.email) + '">' + esc(a.email) + '</a>';
    }).join('&nbsp;&middot;&nbsp;');
    $('footerDisclaimer').textContent = BTG.config.disclaimer_text || '';
  }

  function renderFooterStatus() {
    var s = BTG.status || {};
    var parts = [
      'Estimates last updated: ' + (s.estimates_last_updated ? Fmt.date(s.estimates_last_updated) : 'not yet (placeholders in use)'),
      'Flows data through: ' + (s.flows_through ? Fmt.month(s.flows_through) + (s.dummy_flows ? ' (sample data)' : '') : 'n.a.'),
      'Prices as of: ' + (state.market.prices_as_of ? Fmt.dateTime(state.market.prices_as_of) + ' (Bogotá)' : 'n.a.')
    ];
    $('footerStatus').textContent = parts.join(' · ');
  }

  // ---------------------------------------------------------------------------
  // Header strip: title, company count, price freshness, Refresh prices (SPEC §5, §7.5, §10)
  // ---------------------------------------------------------------------------
  function freshness() {
    if (state.failure) { return { cls: 'error', text: state.failure }; }
    var lines = BTG.lines.map(function (l) { return { id: l.line_id, m: App.marketLine(l.line_id) }; });
    var stale = lines.filter(function (x) { return !x.m || x.m.status === 'stale' || x.m.status === 'error'; });
    var text = 'Prices as of ' + (state.market.prices_as_of ? Fmt.dateTime(state.market.prices_as_of) + ' (Bogotá)' : 'n.a.');
    if (stale.length) { text += ' · ' + stale.length + ' price' + (stale.length > 1 ? 's' : '') + ' from an earlier session'; }
    if (state.note) { text += ' · ' + state.note; }
    return { cls: stale.length ? 'stale' : '', text: text };
  }

  function refreshButton() {
    if (state.busy) {
      return '<button type="button" class="btn" id="refreshBtn" disabled><span class="spinner" aria-hidden="true"></span>Refreshing…</button>';
    }
    var why = LOCAL
      ? 'Loads the prices saved on this computer. To download new ones, run 1_refresh_prices.bat or 3_open_dashboard.bat.'
      : 'Loads the latest prices. They are updated automatically about every 10 minutes during market hours (Yahoo Finance, may be delayed).';
    return '<button type="button" class="btn" id="refreshBtn"' + App.tip(why) + '>Refresh prices</button>';
  }

  function stripHtml(tab) {
    var f = freshness();
    var companies = BTG.companies.length;
    return '<div class="strip">' +
      '<h2 class="strip-title">' + esc(tab.strip) + '</h2>' +
      '<span class="chip">' + companies + ' companies</span>' +
      '<span class="status" role="status" aria-live="polite"><span class="dot ' + f.cls + '" aria-hidden="true"></span>' +
        '<span' + (f.cls === 'error' ? ' class="status-msg"' : '') + '>' + esc(f.text) + '</span></span>' +
      refreshButton() +
    '</div>';
  }

  // ---------------------------------------------------------------------------
  // Tabs
  // ---------------------------------------------------------------------------
  function tabById(id) {
    for (var i = 0; i < TABS.length; i++) { if (TABS[i].id === id) { return TABS[i]; } }
    return TABS[0];
  }

  function comingSoon(tab) {
    return '<section class="panel"><div class="panel-head">' + esc(tab.label) + '</div>' +
      '<div class="coming"><h3>Coming in a later stage</h3><p>' + esc(tab.what) + '</p>' +
      '<p>This tab is built in Stage ' + tab.stage + ' of the plan.</p></div></section>';
  }

  function render() {
    var tab = state.tab;
    var html = '<div class="page-head"><h2 class="page-title">' + esc(tab.label) + '</h2>' +
      '<div class="page-sub">BTG Pactual Research &mdash; Colombia Strategy</div>' +
      (tab.intro ? '<p class="intro">' + esc(tab.intro) + '</p>' : '') + '</div>' +
      '<div id="stripHost">' + stripHtml(tab) + '</div><div id="tabHost"></div>';
    $('view').innerHTML = html;
    var host = $('tabHost');
    var module = tab.module && window[tab.module];
    if (module) { module.render(host, App); } else { host.innerHTML = comingSoon(tab); }
    renderFooterStatus();
  }

  // Redraws keep the visitor's place: the focused control (e.g. the search box) and the scroll position.
  function keepingFocus(draw) {
    var active = document.activeElement;
    var id = active && active.id && $('view').contains(active) ? active.id : null;
    var caret = id && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;
    var scroll = window.pageYOffset;
    draw();
    var again = id && $(id);
    if (again) {
      again.focus({ preventScroll: true });
      if (caret && again.setSelectionRange) { try { again.setSelectionRange(caret[0], caret[1]); } catch (e) { /* not a text box */ } }
    }
    window.scrollTo(window.pageXOffset, scroll);
  }

  function renderStrip() {
    if ($('stripHost')) { keepingFocus(function () { $('stripHost').innerHTML = stripHtml(state.tab); }); }
    renderFooterStatus();
  }

  function selectTab(id, updateHash) {
    state.tab = tabById(id);
    TABS.forEach(function (t) {
      var b = $('tab-' + t.id);
      b.setAttribute('aria-selected', t === state.tab ? 'true' : 'false');
      b.tabIndex = t === state.tab ? 0 : -1;
    });
    if (updateHash && location.hash !== '#' + state.tab.id) { history.replaceState(null, '', '#' + state.tab.id); }
    closeMenu();
    render();
  }

  // ---------------------------------------------------------------------------
  // Refresh prices (SPEC §10)
  // ---------------------------------------------------------------------------
  // Loads data/market_data.js again as a script (this works on the website and on a file opened from disk).
  // The ?v= part makes the browser skip its cached copy.
  function loadMarketFile() {
    return new Promise(function (resolve, reject) {
      var previous = window.MARKET_DATA;
      var script = document.createElement('script');
      var timer = setTimeout(function () { finish(new Error('timed out')); }, LOAD_TIMEOUT_MS);
      function finish(err) {
        clearTimeout(timer);
        script.onload = script.onerror = null;
        if (script.parentNode) { script.parentNode.removeChild(script); }
        var data = window.MARKET_DATA;
        window.MARKET_DATA = previous;
        if (err) { reject(err); } else if (!data || !data.lines || !data.generated_at) {
          reject(new Error('the price file was empty or damaged'));
        } else { resolve(data); }
      }
      window.MARKET_DATA = null;
      script.onload = function () { finish(null); };
      script.onerror = function () { finish(new Error('the price file could not be loaded')); };
      script.src = MARKET_FILE + '?v=' + Date.now();
      document.body.appendChild(script);
    });
  }

  // What the tables show; a new file with the same prices only updates the "as of" time.
  function priceSignature(m) {
    var parts = Object.keys(m.lines || {}).sort().map(function (id) {
      var l = m.lines[id];
      return id + ':' + l.last_price + ':' + l.previous_close + ':' + l.status;
    });
    Object.keys(m.fx || {}).sort().forEach(function (p) { parts.push(p + ':' + m.fx[p].last); });
    return parts.join('|');
  }

  // asked = the visitor clicked Refresh prices (spinner and messages); otherwise a quiet background check.
  function checkPrices(asked) {
    if (state.loading) { return; }
    state.loading = true;
    state.lastCheck = Date.now();
    if (asked) { state.busy = true; state.failure = null; state.note = null; renderStrip(); }
    loadMarketFile()
      .then(function (data) {
        var changed = priceSignature(data) !== priceSignature(state.market);
        var newer = data.generated_at !== state.market.generated_at;
        state.failure = null;
        state.note = asked && !newer
          ? 'No newer prices yet (checked ' + Fmt.time(new Date().toISOString()) + ')' : null;
        if (newer) { state.market = data; }
        return changed;
      }, function (err) {
        if (window.console) { console.warn('Checking for newer prices failed:', err && err.message); }
        if (asked) {
          state.failure = 'Couldn’t reach the price service. Showing prices saved at ' +
            Fmt.dateTime(state.market.generated_at, false) + '.';
        }
        return false;
      })
      .then(function (changed) {
        state.loading = false;
        state.busy = false;
        var hadFocus = document.activeElement && document.activeElement.id === 'refreshBtn';
        if (changed) { keepingFocus(render); } else { renderStrip(); }
        if (asked || hadFocus) { var b = $('refreshBtn'); if (b) { b.focus({ preventScroll: true }); } }
      });
  }

  function refresh() {
    if (!state.busy) { checkPrices(true); }
  }

  function checkIfDue() {
    if (document.visibilityState !== 'hidden' && Date.now() - state.lastCheck >= CHECK_EVERY_MS) { checkPrices(false); }
  }

  // ---------------------------------------------------------------------------
  // Tooltips: any element with data-tip, on hover or keyboard focus
  // ---------------------------------------------------------------------------
  var tipEl = $('tip');
  function showTip(target) {
    var text = target.getAttribute('data-tip');
    if (!text) { return; }
    tipEl.textContent = text;
    tipEl.hidden = false;
    var r = target.getBoundingClientRect();
    var w = tipEl.offsetWidth, h = tipEl.offsetHeight;
    var left = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), window.innerWidth - w - 8);
    var top = r.bottom + 8;
    if (top + h > window.innerHeight - 8) { top = Math.max(8, r.top - h - 8); }
    tipEl.style.left = left + 'px';
    tipEl.style.top = top + 'px';
  }
  function hideTip() { tipEl.hidden = true; }
  document.addEventListener('mouseover', function (e) {
    var t = e.target.closest && e.target.closest('[data-tip]');
    if (t) { showTip(t); } else { hideTip(); }
  });
  document.addEventListener('focusin', function (e) {
    var t = e.target.closest && e.target.closest('[data-tip]');
    if (t) { showTip(t); } else { hideTip(); }
  });
  document.addEventListener('focusout', hideTip);
  window.addEventListener('scroll', hideTip, true);

  // ---------------------------------------------------------------------------
  // Mobile menu (below 900px the sidebar opens from a menu button)
  // ---------------------------------------------------------------------------
  function openMenu() {
    document.body.classList.add('menu-open');
    $('menuBackdrop').hidden = false;
    $('menuButton').setAttribute('aria-expanded', 'true');
    var sel = document.querySelector('.tab[aria-selected="true"]');
    if (sel) { sel.focus(); }
  }
  function closeMenu() {
    if (!document.body.classList.contains('menu-open')) { return; }
    document.body.classList.remove('menu-open');
    $('menuBackdrop').hidden = true;
    $('menuButton').setAttribute('aria-expanded', 'false');
  }

  // ---------------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------------
  buildShell();

  $('tabs').addEventListener('click', function (e) {
    var b = e.target.closest('.tab');
    if (b) { selectTab(b.getAttribute('data-tab'), true); $('main').focus({ preventScroll: true }); }
  });
  $('tabs').addEventListener('keydown', function (e) {
    var keys = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 };
    var i = TABS.indexOf(state.tab), next = null;
    if (keys[e.key]) { next = TABS[(i + keys[e.key] + TABS.length) % TABS.length]; }
    if (e.key === 'Home') { next = TABS[0]; }
    if (e.key === 'End') { next = TABS[TABS.length - 1]; }
    if (!next) { return; }
    e.preventDefault();
    selectTab(next.id, true);
    $('tab-' + next.id).focus();
  });
  $('view').addEventListener('click', function (e) {
    if (e.target.closest('#refreshBtn')) { refresh(); }
  });
  $('menuButton').addEventListener('click', function () {
    if (document.body.classList.contains('menu-open')) { closeMenu(); } else { openMenu(); }
  });
  $('menuBackdrop').addEventListener('click', closeMenu);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { hideTip(); if (document.body.classList.contains('menu-open')) { closeMenu(); $('menuButton').focus(); } }
  });
  window.addEventListener('hashchange', function () { selectTab(location.hash.replace('#', ''), false); });

  selectTab(location.hash.replace('#', ''), false);

  // Newer prices: check once now on the website (the browser may have shown a cached copy), then every few
  // minutes while the page is visible, and when the visitor comes back to the tab.
  state.lastCheck = Date.now();
  if (!LOCAL) { checkPrices(false); }
  setInterval(checkIfDue, 30 * 1000);
  document.addEventListener('visibilitychange', checkIfDue);
})();

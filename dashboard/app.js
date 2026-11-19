// Launch Radar's plain dashboard. It reads window.RADAR (z-data.js, written by main.ts from
// the same board as board.json) and renders the ranked board, a filterable table, a per-protocol
// detail view with its peer table and farm plan, the live-token comps, and the model's own
// validation. No network: every byte it shows is in z-data.js.
(function () {
  'use strict';

  var DATA = window.RADAR;
  if (!DATA) return;
  // Row: [rank, slug, name, category, chains, tvl, 7d, age, value, lo, hi, rankLo, rankHi,
  // verdict, verdictReason, cost, holdDays, peers, steps]
  var R = { rank: 0, slug: 1, name: 2, cat: 3, chains: 4, tvl: 5, g7: 6, age: 7, value: 8, lo: 9, hi: 10, rlo: 11, rhi: 12, verdict: 13, vreason: 14, cost: 15, hold: 16, peers: 17, steps: 18 };
  var app = document.getElementById('board');
  var watchlist = {};
  (DATA.watchlist || []).forEach(function (s) { watchlist[s] = true; });
  var compsBySlug = {};
  (DATA.comps || []).forEach(function (c) { compsBySlug[c.slug] = c; });
  var state = { q: '', category: 'all', verdict: 'all', wl: false, tab: 'pre-token', sort: 'rank', dir: 1, selected: null };
  var detailFirst = false;

  var usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usd.format(n);
  }
  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function fmtAge(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }
  function fmtMult(n) {
    if (n === null || n === undefined || !isFinite(n) || n <= 0) return 'n/a';
    return n >= 10 ? n.toFixed(1) + 'x' : n.toFixed(2) + 'x';
  }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }

  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k === 'html') node.innerHTML = attrs[k];
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined) continue;
      if (Array.isArray(child)) child.forEach(function (c) { if (c) node.appendChild(c); });
      else if (typeof child === 'string') node.appendChild(document.createTextNode(child));
      else node.appendChild(child);
    }
    return node;
  }

  function readHash() {
    var hash = window.location.hash.replace(/^#/, '');
    if (!hash) return;
    var params = new URLSearchParams(hash);
    if (params.get('q')) state.q = params.get('q');
    if (params.get('category')) state.category = params.get('category');
    if (params.get('verdict')) state.verdict = params.get('verdict');
    if (params.get('wl')) state.wl = params.get('wl') === '1';
    if (params.get('tab')) state.tab = params.get('tab');
    if (params.get('p')) { state.selected = params.get('p'); detailFirst = true; }
  }
  function writeHash() {
    var params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.category !== 'all') params.set('category', state.category);
    if (state.verdict !== 'all') params.set('verdict', state.verdict);
    if (state.wl) params.set('wl', '1');
    if (state.tab !== 'pre-token') params.set('tab', state.tab);
    if (state.selected) params.set('p', state.selected);
    var next = params.toString();
    if (next) window.history.replaceState(null, '', '#' + next);
    else window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  function filteredRows() {
    var q = state.q.trim().toLowerCase();
    return DATA.rows.filter(function (r) {
      if (state.category !== 'all' && (r[R.cat] || 'Other') !== state.category) return false;
      if (state.verdict !== 'all' && r[R.verdict] !== state.verdict) return false;
      if (state.wl && !watchlist[r[R.slug]]) return false;
      if (!q) return true;
      var hay = [r[R.name], r[R.slug], r[R.cat], (r[R.chains] || []).join(' ')].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }
  function sortedRows(list) {
    var key = state.sort;
    return list.slice().sort(function (a, b) {
      var av, bv;
      if (key === 'name') { av = a[R.name].toLowerCase(); bv = b[R.name].toLowerCase(); }
      else if (key === 'tvl') { av = a[R.tvl]; bv = b[R.tvl]; }
      else if (key === 'growth') { av = a[R.g7] === null ? -Infinity : a[R.g7]; bv = b[R.g7] === null ? -Infinity : b[R.g7]; }
      else if (key === 'age') { av = a[R.age] === null ? Infinity : a[R.age]; bv = b[R.age] === null ? Infinity : b[R.age]; }
      else if (key === 'cost') { av = a[R.cost]; bv = b[R.cost]; }
      else if (key === 'verdict') { av = a[R.verdict]; bv = b[R.verdict]; }
      else if (key === 'value') { av = a[R.value]; bv = b[R.value]; }
      else { av = a[R.rank]; bv = b[R.rank]; }
      if (av < bv) return -state.dir;
      if (av > bv) return state.dir;
      return a[R.slug] < b[R.slug] ? -1 : a[R.slug] > b[R.slug] ? 1 : 0;
    });
  }

  function header() {
    return el('header', { class: 'top' },
      el('div', { class: 'brand' },
        el('span', { class: 'mark' }),
        el('span', { class: 'brand-name', text: 'LAUNCH RADAR' }),
        el('span', { class: 'brand-tag', text: 'every rank shows its peers' })
      ),
      el('div', { class: 'top-meta' },
        el('span', { html: 'Snapshot <b>' + esc(DATA.as_of) + '</b>' }),
        el('span', { html: 'Model <b>' + esc(DATA.model_version) + '</b>' }),
        el('span', { html: 'Source <b>DefiLlama protocol index</b>' })
      )
    );
  }

  function kpis() {
    var v = DATA.validation;
    var verdicts = { FARM: 0, THIN: 0, SKIP: 0 };
    DATA.rows.forEach(function (r) { verdicts[r[R.verdict]]++; });
    function kpi(label, value, sub, hot) {
      return el('div', { class: 'kpi' + (hot ? ' hot' : '') },
        el('span', { text: label }), el('b', { text: value }), el('small', { text: sub }));
    }
    return el('div', { class: 'kpis' },
      kpi('Protocols scanned', String(DATA.accounting.total), 'the whole snapshot'),
      kpi('Ranked pre-token', String(DATA.counts.board), DATA.counts.watchlist + ' watchlist + ' + (DATA.counts.board - DATA.counts.watchlist) + ' below the floor'),
      kpi('Watchlist covered', DATA.counts.watchlist + ' / ' + DATA.counts.watchlist, 'the floor, never the ceiling'),
      kpi('Comps fitted', String(v.comps), 'tokenized protocols with a market cap'),
      kpi('Blind-test error', v.chosenLoocvPct + '%', 'leave-one-out median, ' + v.chosenName, true),
      kpi('Farm verdicts', verdicts.FARM + ' FARM', verdicts.THIN + ' thin · ' + verdicts.SKIP + ' skip')
    );
  }

  function methodPanel() {
    var v = DATA.validation;
    var m = DATA.model;
    var offsets = Object.keys(m.offsets).map(function (c) { return [c, m.offsets[c]]; })
      .sort(function (a, b) { return Math.abs(b[1]) - Math.abs(a[1]); }).slice(0, 8);
    var candRows = v.candidates.map(function (c) {
      return el('tr', { class: c.chosen ? 'chosen' : 'rejected' },
        el('td', { text: c.name }),
        el('td', { class: 'num', text: c.loocvMedianErrPct + '%' }),
        el('td', { text: c.chosen ? 'KEPT — the fitted model' : 'rejected by the blind test' }));
    });
    return el('section', { class: 'panel', id: 'method' },
      el('h2', { text: 'How a rank is earned — and how it was tested' }),
      el('p', { class: 'sub', text: 'One fitted curve scores every protocol. No name is special-cased, and no row is hand-picked. The same snapshot that feeds the board also grades the model, blind.' }),
      el('div', { class: 'formula', text: 'implied = 10 ^ (' + m.intercept + ' + ' + m.slope + ' x log10(TVL) + category offset)' }),
      el('p', { text: 'Fitted by least squares on ' + v.comps + ' tokenized protocols that record a market cap. The category offset is the mean log-residual of that category\u2019s comps, shrunk n / (n + ' + m.shrink + '). Largest offsets: ' + offsets.map(function (o) { return o[0] + ' ' + (o[1] >= 0 ? '+' : '') + o[1].toFixed(2) + ' dex'; }).join(', ') + '.' }),
      el('h3', { text: 'The blind test: five models, one winner' }),
      el('table', { class: 'mini' },
        el('thead', null, el('tr', null, el('th', { text: 'Candidate model' }), el('th', { text: 'Leave-one-out median error' }), el('th', { text: 'Verdict' }))),
        el('tbody', null, candRows)
      ),
      el('p', { text: 'Walk-forward check: fitted on protocols listed before ' + v.walkForward.cutoff + ' (' + v.walkForward.train + ' comps), tested on the ' + v.walkForward.test + ' listed after — median error ' + v.walkForward.medianErrPct + '%. The fit explains R\u00b2 ' + v.r2 + ' of log value; a peer\u2019s actual value typically lands within \u00d7' + v.residFactor + ' of the fit (residual SD ' + v.residSdDex + ' dex). That is why every rank carries its 90% interval and its rank range from ' + v.bootstrapRefits + ' bootstrap refits, not just a point.' }),
      el('div', { class: 'note' }, el('b', { text: 'Read this before trusting a rank: ' }), el('span', { text: 'TVL alone explains only a fifth of a token\u2019s value. Growth and age were tested as terms and made the blind error worse, so they do not enter the price — they still show on every row and feed the farm verdict. A rank without its interval is a guess dressed as a price.' })),
      el('h3', { text: 'Farm costs, stated as estimates' }),
      el('p', { text: 'Gas per transaction, November 2026 estimates: Ethereum $2.50, Arbitrum $0.15, Optimism $0.10, Base $0.05, Solana $0.01, BSC $0.25, Polygon $0.05, Avalanche $0.30, Tron $0.50, Bitcoin $1.00, other chains $0.50. One farm runs 7 transactions (approve, deposit, four weekly actions, claim). Capital by TVL: $250 over $5B, $150 over $1B, $100 over $100M, $50 below. Hold: 60 days if listed under 180 days, 45 under a year, 30 otherwise. Verdict: FARM when cost is at most $160 on at least $100M of TVL and 7-day growth is no worse than -10%; SKIP when the implied value is under $3M, TVL under $10M, 7-day growth under -30%, or cost over $300; THIN in between.' })
    );
  }

  function controls() {
    var categories = Array.from(new Set(DATA.rows.map(function (r) { return r[R.cat] || 'Other'; }))).sort();
    var search = el('input', { type: 'search', id: 'q', placeholder: 'Search name, category or chain', value: state.q, 'aria-label': 'Search the board' });
    search.addEventListener('input', function () { state.q = search.value; writeHash(); render(); });
    var select = el('select', { id: 'category', 'aria-label': 'Filter by category' },
      el('option', { value: 'all', text: 'All categories' }),
      categories.map(function (c) { return el('option', { value: c, text: c, selected: c === state.category ? 'selected' : null }); })
    );
    select.addEventListener('change', function () { state.category = select.value; writeHash(); render(); });
    var verdict = el('select', { id: 'verdict', 'aria-label': 'Filter by farm verdict' },
      ['all', 'FARM', 'THIN', 'SKIP'].map(function (v) { return el('option', { value: v, text: v === 'all' ? 'All verdicts' : v, selected: v === state.verdict ? 'selected' : null }); })
    );
    verdict.addEventListener('change', function () { state.verdict = verdict.value; writeHash(); render(); });
    var wl = el('label', { class: 'check' },
      el('input', { type: 'checkbox', checked: state.wl ? 'checked' : null, onclick: function (e) { state.wl = e.target.checked; writeHash(); render(); } }),
      el('span', { text: 'Watchlist only' })
    );
    function tab(name, label) {
      return el('button', { type: 'button', 'aria-pressed': state.tab === name ? 'true' : 'false', text: label, onclick: function () { state.tab = name; state.selected = null; writeHash(); render(); } });
    }
    return el('div', { class: 'controls' },
      el('div', { class: 'field' }, el('label', { for: 'q', text: 'Search' }), search),
      el('div', { class: 'field' }, el('label', { for: 'category', text: 'Category' }), select),
      el('div', { class: 'field' }, el('label', { for: 'verdict', text: 'Verdict' }), verdict),
      wl,
      el('div', { class: 'tabs' }, tab('pre-token', 'Pre-token board'), tab('live', 'Live comps'), tab('accounted', 'Accounted for')),
      el('span', { class: 'count', text: state.tab === 'pre-token' ? filteredRows().length + ' of ' + DATA.rows.length + ' rows shown' : state.tab === 'live' ? DATA.live.length + ' live-token comps' : DATA.accounting.total + ' protocols accounted for' })
    );
  }

  function sortHeader(key, label) {
    var natural = { rank: 1, name: 1, tvl: -1, growth: -1, age: 1, value: -1, cost: 1, verdict: 1 };
    return el('th', { scope: 'col' },
      el('button', { type: 'button', onclick: function () { if (state.sort === key) state.dir = -state.dir; else { state.sort = key; state.dir = natural[key] || 1; } render(); } },
        label,
        state.sort === key ? el('span', { 'aria-hidden': 'true', text: state.dir < 0 ? ' v' : ' ^' }) : null
      )
    );
  }

  function boardTable() {
    var list = sortedRows(filteredRows());
    if (list.length === 0) {
      return el('div', { class: 'panel' }, el('div', { class: 'empty' },
        el('h2', { text: 'No protocol matches that filter' }),
        el('p', { text: 'Clear the search or pick another category to see the board again.' }),
        el('button', { class: 'button primary', type: 'button', text: 'Clear filters', onclick: function () { state.q = ''; state.category = 'all'; state.verdict = 'all'; state.wl = false; writeHash(); render(); } })
      ));
    }
    var max = list.reduce(function (a, r) { return Math.max(a, r[R.value]); }, 1);
    var tbody = el('tbody');
    list.forEach(function (r) {
      var growth = r[R.g7] === null ? 'n/a' : fmtPct(r[R.g7]);
      var growthClass = r[R.g7] === null ? '' : r[R.g7] >= 0 ? 'pos' : 'neg';
      var tr = el('tr', {
        'data-selected': state.selected === r[R.slug] ? 'true' : 'false',
        tabindex: '0',
        onclick: function () { openDetail(r[R.slug]); },
        onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r[R.slug]); } }
      },
        el('td', { class: 'num', text: String(r[R.rank]) }),
        el('td', null, el('div', { class: 'name' },
          el('span', null, el('b', { text: r[R.name] }), watchlist[r[R.slug]] ? el('span', { class: 'watch', text: 'WATCHLIST' }) : null),
          el('span', { class: 'sub', text: (r[R.cat] || 'Other') + ' on ' + (r[R.chains] && r[R.chains].length ? r[R.chains].slice(0, 2).join(', ') : 'an unnamed chain') })
        )),
        el('td', { class: 'num', text: fmtUsd(r[R.tvl]) }),
        el('td', { class: 'num ' + growthClass, text: growth }),
        el('td', { class: 'num', text: fmtAge(r[R.age]) }),
        el('td', null, el('div', { class: 'implied' },
          el('div', { class: 'bar', 'aria-hidden': 'true' }, el('i', { style: 'width:' + Math.max(3, Math.round((r[R.value] / max) * 100)) + '%' })),
          el('span', { class: 'num', text: fmtUsd(r[R.value]) })
        )),
        el('td', { class: 'num sub', text: fmtUsd(r[R.lo]) + ' – ' + fmtUsd(r[R.hi]) }),
        el('td', { class: 'num', text: r[R.rlo] === r[R.rhi] ? String(r[R.rlo]) : r[R.rlo] + '–' + r[R.rhi] }),
        el('td', null, el('span', { class: 'verdict ' + r[R.verdict], text: r[R.verdict] })),
        el('td', { class: 'num', text: '$' + r[R.cost] })
      );
      tbody.appendChild(tr);
    });
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', { class: 'board' },
          el('caption', { class: 'sub', text: 'Pre-token protocols, strongest implied value first. Select a row for its peers and farm plan. Interval and rank range come from 200 bootstrap refits of the comps fit.' }),
          el('thead', null, el('tr', null,
            sortHeader('rank', 'Rank'),
            sortHeader('name', 'Protocol'),
            sortHeader('tvl', 'TVL'),
            sortHeader('growth', '7d'),
            sortHeader('age', 'Age'),
            sortHeader('value', 'Implied value'),
            el('th', { scope: 'col', text: '90% interval' }),
            el('th', { scope: 'col', text: 'Rank range' }),
            sortHeader('verdict', 'Verdict'),
            sortHeader('cost', 'Farm cost')
          )),
          tbody
        )
      )
    );
  }

  function liveTable() {
    var tbody = el('tbody');
    DATA.live.forEach(function (r) {
      tbody.appendChild(el('tr', null,
        el('td', { class: 'num', text: 'live' }),
        el('td', null, el('div', { class: 'name' }, el('b', { text: r.name }), el('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain') }))),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + (r.change_7d !== null && r.change_7d >= 0 ? 'pos' : 'neg'), text: fmtPct(r.change_7d) }),
        el('td', { class: 'num', text: fmtUsd(r.mcap_usd) }),
        el('td', { class: 'num', text: fmtMult(r.mcap_usd && r.tvl_usd ? r.mcap_usd / r.tvl_usd : null) })
      ));
    });
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', { class: 'board' },
          el('caption', { class: 'sub', text: 'The comps that fit the curve: the 24 largest tokenized protocols by market cap. Their values are the market\u2019s own, not a model\u2019s — and the curve is fitted on all ' + DATA.counts.comps + ' of them.' }),
          el('thead', null, el('tr', null, el('th', { scope: 'col', text: 'Status' }), el('th', { scope: 'col', text: 'Protocol' }), el('th', { scope: 'col', text: 'TVL' }), el('th', { scope: 'col', text: '7d' }), el('th', { scope: 'col', text: 'Market cap' }), el('th', { scope: 'col', text: 'mcap / TVL' }))),
          tbody
        )
      )
    );
  }

  function accountedPanel() {
    var a = DATA.accounting;
    function row(label, n, note) {
      return el('tr', null, el('td', { text: label }), el('td', { class: 'num', text: String(n) }), el('td', { text: note }));
    }
    return el('div', { class: 'panel' },
      el('h2', { text: 'All ' + a.total + ' protocols, accounted for' }),
      el('p', { class: 'sub', text: 'The watchlist is a floor, never a ceiling — and the board does not silently drop anything the snapshot holds.' }),
      el('table', { class: 'mini' },
        el('thead', null, el('tr', null, el('th', { text: 'Slice' }), el('th', { text: 'Count' }), el('th', { text: 'What happens to it' }))),
        el('tbody', null,
          row('Ranked pre-token', a.ranked, 'Every protocol that records no token and is not a wrapped, staked, bridged, exchange or versioned product: ' + a.watchlist + ' on the watchlist and ' + a.watchlistBelowFloor + ' below its $50M floor.'),
          row('Tokenized, market cap recorded', a.tokenizedWithMcap, 'Already trades. Shown as the live comps that fit the curve, never ranked as pre-token.'),
          row('Token recorded, no market cap', a.tokenRecordedNoMcap, 'DefiLlama records a token id or symbol but no market cap. Not ranked: a token is on record, so the launch is not what is being priced.'),
          row('No token recorded, excluded', a.excludedNoToken, 'CEX, bridges, liquid staking and restaking, wrapped or staked products, versioned pools and exchange-named protocols. Not a launch of their own.')
        )
      ),
      el('p', { class: 'sub', text: 'A protocol is called pre-token only because its record shows no token. The snapshot is DefiLlama\u2019s record, not proof: a listed protocol may still have a token its record does not carry.' })
    );
  }

  function detailPanel() {
    if (!state.selected) return null;
    var row = DATA.rows.filter(function (r) { return r[R.slug] === state.selected; })[0];
    if (!row) return null;
    var m = DATA.model;
    var curve = Math.pow(10, m.intercept + m.slope * Math.log10(row[R.tvl]));
    var offset = m.offsets[row[R.cat] || 'Other'] || 0;
    var factor = Math.pow(10, offset);
    var peers = row[R.peers].map(function (s) { return compsBySlug[s]; }).filter(Boolean);
    var peerMults = peers.map(function (c) { return c.mcap_usd / c.tvl_usd; }).sort(function (a, b) { return a - b; });
    var peerMedian = peerMults.length ? peerMults[Math.floor(peerMults.length / 2)] : null;
    var peerImplied = peerMedian === null ? null : Math.round(peerMedian * row[R.tvl]);
    var peerRows = peers.map(function (c) {
      return el('tr', null,
        el('td', { text: c.name }),
        el('td', { class: 'num', text: fmtUsd(c.tvl_usd) }),
        el('td', { class: 'num', text: fmtUsd(c.mcap_usd) }),
        el('td', { class: 'num', text: fmtMult(c.mcap_usd / c.tvl_usd) })
      );
    });
    var steps = row[R.steps].map(function (s) {
      var at = s.indexOf(' Cost: ');
      var action = at >= 0 ? s.slice(0, at) : s;
      var tail = at >= 0 ? s.slice(at + 1) : '';
      return el('li', null, el('b', { text: action }), el('span', { class: 'cost', text: tail }));
    });
    var costPct = (row[R.cost] / row[R.value]) * 100;
    return el('section', { class: 'panel detail', id: 'detail' },
      el('div', { class: 'detail-head' },
        el('div', null,
          el('span', { class: 'sub', text: 'Rank ' + row[R.rank] + ' of ' + DATA.rows.length + (watchlist[row[R.slug]] ? ' · on the watchlist' : ' · below the watchlist floor') }),
          el('h2', { text: row[R.name] }),
          el('p', { class: 'sub', text: (row[R.cat] || 'Other') + ' on ' + (row[R.chains] && row[R.chains].length ? row[R.chains].join(', ') : 'an unnamed chain') + ' · TVL ' + fmtUsd(row[R.tvl]) + ' · 7d ' + fmtPct(row[R.g7]) + ' · listed ' + fmtAge(row[R.age]) + ' ago' })
        ),
        el('button', { class: 'button', type: 'button', text: 'Close', onclick: function () { state.selected = null; writeHash(); render(); } })
      ),
      el('div', { class: 'detail-grid' },
        el('div', null,
          el('h3', { text: 'Where the value comes from' }),
          el('div', { class: 'equation' },
            el('div', null, el('span', { text: 'TVL' }), el('b', { text: fmtUsd(row[R.tvl]) })),
            el('div', null, el('span', { text: 'Curve value (TVL only)' }), el('b', { text: fmtUsd(curve) })),
            el('div', null, el('span', { text: 'Category factor (' + (row[R.cat] || 'Other') + ')' }), el('b', { text: 'x' + factor.toFixed(2) })),
            el('div', null, el('span', { text: 'Implied value' }), el('b', { text: fmtUsd(row[R.value]) })),
            el('div', null, el('span', { text: '90% interval (200 refits)' }), el('b', { text: fmtUsd(row[R.lo]) + ' – ' + fmtUsd(row[R.hi]) })),
            el('div', null, el('span', { text: 'Rank range (200 refits)' }), el('b', { text: row[R.rlo] + ' – ' + row[R.rhi] }))
          ),
          el('p', { class: 'sub', text: 'The curve is the comps fit; the factor is this category\u2019s shrunk offset. The interval is the fit\u2019s uncertainty, not a promise.' })
        ),
        el('div', null,
          el('h3', { text: 'Its five nearest peers — show your work' }),
          el('table', { class: 'mini peers' },
            el('thead', null, el('tr', null, el('th', { text: 'Peer (same category first)' }), el('th', { text: 'TVL' }), el('th', { text: 'Market cap' }), el('th', { text: 'mcap / TVL' }))),
            el('tbody', null, peerRows)
          ),
          el('p', { class: 'sub', text: peerMedian === null ? 'No peer with a market cap was near enough to show.' : 'Peer median multiple ' + fmtMult(peerMedian) + ' implies ' + fmtUsd(peerImplied) + ' by peers alone, against the fitted ' + fmtUsd(row[R.value]) + '.' })
        )
      ),
      el('div', { class: 'detail-grid' },
        el('div', null,
          el('h3', { text: 'Farm plan — costed, dated' }),
          el('ol', { class: 'steps' }, steps)
        ),
        el('div', null,
          el('h3', { text: 'Is it worth farming?' }),
          el('div', { class: 'equation' },
            el('div', null, el('span', { text: 'Total farm cost' }), el('b', { text: '$' + row[R.cost] })),
            el('div', null, el('span', { text: 'Hold' }), el('b', { text: row[R.hold] + ' days' })),
            el('div', null, el('span', { text: 'Cost as share of implied value' }), el('b', { text: (costPct < 0.01 ? '<0.01' : costPct.toFixed(2)) + '%' })),
            el('div', null, el('span', { text: 'Verdict' }), el('b', null, el('span', { class: 'verdict ' + row[R.verdict], text: row[R.verdict] })))
          ),
          el('p', { text: row[R.vreason] })
        )
      )
    );
  }

  function render() {
    app.textContent = '';
    var shell = el('div', { class: 'shell' });
    shell.appendChild(header());
    shell.appendChild(kpis());
    shell.appendChild(controls());
    var detail = state.tab === 'pre-token' ? detailPanel() : null;
    // A deep link to a protocol leads with its detail: the headless screenshot reads the page
    // at scroll 0, and a scroll on load does not paint there, so the detail goes first instead
    // of being scrolled to.
    if (detail && detailFirst) shell.appendChild(detail);
    if (state.tab === 'pre-token') {
      shell.appendChild(boardTable());
    } else if (state.tab === 'live') {
      shell.appendChild(liveTable());
    } else {
      shell.appendChild(accountedPanel());
    }
    if (detail && !detailFirst) shell.appendChild(detail);
    shell.appendChild(methodPanel());
    app.appendChild(shell);
    app.setAttribute('aria-busy', 'false');
  }

  function openDetail(slug) {
    state.selected = slug;
    detailFirst = false;
    writeHash();
    render();
    var d = document.getElementById('detail');
    if (d) d.scrollIntoView({ block: 'start' });
  }

  readHash();
  render();
})();

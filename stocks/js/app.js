import { analyze, SCALE_LABELS, CALLS, MOAT_SOURCES, isNum } from './analysis.js';
import { fetchCompany } from './providers/fmp.js';
import { demoCompany, demoQualitative } from './providers/demo.js';
import { assess, MODELS } from './ai.js';
import {
  esc, fmtMoney, fmtPct, fmtSigned, fmtX, fmtPrice, meter, stepper,
  multipleChart, growthChart, beatChart, shareBars, valueStrip, phaseDiagram, attachHover, setChartWidth,
} from './charts.js';

const $app = document.getElementById('app');
const CACHE_HOURS = 12;

// ---------- storage (every access guarded: private mode can throw) ----------

const store = {
  get(key, fallback = null) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
  },
  del(key) { try { localStorage.removeItem(key); } catch { /* ignore */ } },
  keys(prefix) {
    try { return Object.keys(localStorage).filter(k => k.startsWith(prefix)); } catch { return []; }
  },
};

const settings = () => ({ fmpKey: '', anthropicKey: '', model: MODELS[0][0], webSearch: true, ...store.get('ss.settings', {}) });

// ---------- view state ----------

const view = {
  symbol: null,
  company: null,
  ai: null,
  overrides: {},
  report: null,
  valYears: 5,
  aiBusy: false,
  aiStatus: '',
  aiError: '',
};

// ---------- routing ----------

function route() {
  const h = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
  if (h === 'settings') return renderSettings();
  const m = h.match(/^s\/([A-Za-z0-9.\-^]{1,15})$/);
  if (m) return openSymbol(m[1].toUpperCase());
  renderHome();
}

const go = path => { location.hash = '#/' + path; };

// ---------- home ----------

function renderHome() {
  document.title = 'Stock Simplifier';
  const s = settings();
  const recent = store.get('ss.recent', []);
  $app.innerHTML = `
  <header class="topbar"><a class="brand" href="#/">${logo()}<span>Stock Simplifier</span></a>
    <a class="iconbtn" href="#/settings" aria-label="Settings">${gear()}</a></header>
  <main class="home">
    <h1>Is it a buy?</h1>
    <p class="lede">Type a ticker. Get a plain-English read on the business, its moat, growth, management, risk and price — scored 1 to 5, with a verdict.</p>
    <form class="search" id="search">
      <input id="ticker" name="ticker" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="Ticker, e.g. MSFT" aria-label="Ticker symbol" maxlength="15">
      <button type="submit" class="btn primary">Analyze</button>
    </form>
    ${s.fmpKey ? '' : `<div class="notice">
      <b>One-time setup for real stocks:</b> add a free <a href="https://site.financialmodelingprep.com/developer/docs" target="_blank" rel="noopener">Financial Modeling Prep</a> API key in <a href="#/settings">Settings</a>.
      Until then, <a href="#/s/DEMO">explore the demo company</a>.</div>`}
    <div class="row-actions"><a class="btn ghost" href="#/s/DEMO">Try the demo</a></div>
    ${recent.length ? `<h2 class="h-sm">Recent</h2><ul class="recent">${recent.map(r => `
      <li><a href="#/s/${encodeURIComponent(r.symbol)}"><b>${esc(r.symbol)}</b><span>${esc(r.name)}</span>
      <em class="call call-${esc(r.call).toLowerCase()}">${esc(r.call)}</em><span class="q">${esc(r.quality)}/5</span></a></li>`).join('')}</ul>` : ''}
    <p class="fine">Not financial advice. Scores are rules applied to reported numbers, plus optional AI judgement for the qualitative questions — check the reasoning on each card and tap to overrule it.</p>
  </main>`;
  document.getElementById('search').addEventListener('submit', e => {
    e.preventDefault();
    const t = document.getElementById('ticker').value.trim().toUpperCase();
    if (t) go('s/' + t);
  });
}

// ---------- settings ----------

function renderSettings() {
  document.title = 'Settings · Stock Simplifier';
  const s = settings();
  $app.innerHTML = `
  <header class="topbar"><a class="brand" href="#/">${logo()}<span>Stock Simplifier</span></a></header>
  <main class="home settings">
    <h1>Settings</h1>
    <form id="settings">
      <label class="field"><span>Financial Modeling Prep API key <em>required for real stocks</em></span>
        <input name="fmpKey" type="password" autocomplete="off" value="${esc(s.fmpKey)}" placeholder="Paste key">
        <small>Free at <a href="https://site.financialmodelingprep.com/developer/docs" target="_blank" rel="noopener">financialmodelingprep.com</a>. One analysis uses about 11 requests; results are cached for ${CACHE_HOURS} hours.</small></label>
      <label class="field"><span>Anthropic API key <em>optional, for AI judgement</em></span>
        <input name="anthropicKey" type="password" autocomplete="off" value="${esc(s.anthropicKey)}" placeholder="sk-ant-…">
        <small>Lets Claude answer the questions numbers can't: moat sources, customer concentration, disruption. Get one at <a href="https://console.anthropic.com/" target="_blank" rel="noopener">console.anthropic.com</a>. Each run costs a few cents.</small></label>
      <label class="field"><span>Model</span>
        <select name="model">${MODELS.map(([id, name]) => `<option value="${id}" ${id === s.model ? 'selected' : ''}>${esc(name)}</option>`).join('')}</select></label>
      <label class="check"><input type="checkbox" name="webSearch" ${s.webSearch ? 'checked' : ''}> Let Claude search the web for current facts (slower, more accurate)</label>
      <p class="fine">Keys are saved only in this browser (localStorage) and sent only to the two services above. Don't use this on a shared computer.</p>
      <div class="row-actions"><button class="btn primary" type="submit">Save</button>
        <button class="btn ghost" type="button" id="clear">Clear cached data</button><a class="btn ghost" href="#/">Back</a></div>
      <p class="saved" id="saved" hidden>Saved.</p>
    </form>
  </main>`;
  const form = document.getElementById('settings');
  form.addEventListener('submit', e => {
    e.preventDefault();
    const fd = new FormData(form);
    store.set('ss.settings', {
      fmpKey: String(fd.get('fmpKey') || '').trim(),
      anthropicKey: String(fd.get('anthropicKey') || '').trim(),
      model: String(fd.get('model')),
      webSearch: fd.get('webSearch') === 'on',
    });
    document.getElementById('saved').hidden = false;
  });
  document.getElementById('clear').addEventListener('click', () => {
    for (const k of store.keys('ss.co.')) store.del(k);
    document.getElementById('saved').textContent = 'Cached market data cleared.';
    document.getElementById('saved').hidden = false;
  });
}

// ---------- loading a company ----------

async function openSymbol(symbol, { refresh = false } = {}) {
  const fresh = view.symbol !== symbol;
  Object.assign(view, { symbol, aiError: '', aiStatus: '' });
  if (fresh) view.valYears = 5;
  view.overrides = store.get('ss.ov.' + symbol, {});

  if (symbol === 'DEMO') {
    view.company = demoCompany();
    view.ai = store.get('ss.ai.DEMO') || demoQualitative();
    return renderReport();
  }

  const cached = store.get('ss.co.' + symbol);
  if (!refresh && cached && Date.now() - cached.ts < CACHE_HOURS * 3600e3) {
    view.company = cached.data;
  } else {
    renderLoading(symbol);
    try {
      view.company = await fetchCompany(symbol, settings().fmpKey);
      if (!store.set('ss.co.' + symbol, { ts: Date.now(), data: view.company })) {
        // Storage full: drop other cached companies and retry once.
        for (const k of store.keys('ss.co.')) store.del(k);
        store.set('ss.co.' + symbol, { ts: Date.now(), data: view.company });
      }
    } catch (e) {
      if (view.symbol === symbol) renderError(symbol, e);
      return;
    }
    if (view.symbol !== symbol) return; // user navigated away meanwhile
  }
  view.ai = store.get('ss.ai.' + symbol);
  renderReport();
}

function renderLoading(symbol) {
  $app.innerHTML = `${reportTopbar()}<main class="center"><div class="spinner" aria-hidden="true"></div><p>Fetching ${esc(symbol)}…</p></main>`;
}

function renderError(symbol, e) {
  const needsKey = e.status === 401 && !settings().fmpKey;
  $app.innerHTML = `${reportTopbar()}<main class="center">
    <h1 class="h-md">${needsKey ? 'Add a data key first' : `Couldn't analyze ${esc(symbol)}`}</h1>
    <p class="lede">${esc(e.message || String(e))}</p>
    <div class="row-actions">${needsKey ? '<a class="btn primary" href="#/settings">Open settings</a>' : '<button class="btn primary" id="retry">Try again</button>'}
    <a class="btn ghost" href="#/s/DEMO">See the demo</a><a class="btn ghost" href="#/">Home</a></div></main>`;
  document.getElementById('retry')?.addEventListener('click', () => openSymbol(symbol, { refresh: true }));
}

// ---------- report ----------

function computeReport() {
  view.report = analyze(view.company, { overrides: view.overrides, ai: view.ai?.answers || null });
  const r = view.report, c = view.company;
  const recent = store.get('ss.recent', []).filter(x => x.symbol !== c.symbol);
  recent.unshift({ symbol: c.symbol, name: c.name, call: r.verdict.call, quality: r.quality.toFixed(1) });
  store.set('ss.recent', recent.slice(0, 12));
}

const NAV = [['verdict', 'Verdict'], ['business', 'Business'], ['phase', 'Phase'], ['moat', 'Moat'], ['growth', 'Growth'],
  ['management', 'Management'], ['risk', 'Risk'], ['valuation', 'Valuation']];

// Inner width of a report card: page width minus gutters and card padding.
const cardWidth = () => Math.min(920, document.documentElement.clientWidth) - 32 - 32;

function renderReport() {
  computeReport();
  setChartWidth(cardWidth());
  const c = view.company, r = view.report;
  document.title = `${c.symbol} · Stock Simplifier`;
  const scrollY = window.scrollY;
  $app.innerHTML = `
  ${reportTopbar()}
  <div class="co-head">
    ${c.image ? `<img class="co-logo" src="${esc(c.image)}" alt="" onerror="this.remove()">` : `<span class="co-logo txt">${esc(c.symbol.slice(0, 4))}</span>`}
    <div class="co-id"><h1>${esc(c.name)}</h1>
      <p>${esc(c.symbol)} · ${fmtPrice(c.price, cur())} · ${esc([c.sector, c.industry].filter(Boolean).join(' · '))}</p></div>
  </div>
  ${c.demo ? '<p class="banner">Demo company with made-up numbers. Search a real ticker once your data key is set.</p>' : ''}
  <nav class="tabs" id="tabs">${NAV.map(([id, l]) => `<a href="#${id}" data-jump="${id}">${l}</a>`).join('')}</nav>
  <main class="report">
    ${aiPanel()}
    ${verdictSection(r)}
    ${businessSection(r)}
    ${phaseSection(r)}
    ${moatSection(r)}
    ${growthSection(r)}
    ${managementSection(r)}
    ${riskSection(r)}
    ${valuationSection(r)}
    <p class="fine">Data: ${c.demo ? 'generated demo data' : 'Financial Modeling Prep'}, as of ${esc(c.asOf)}. ${view.ai ? `Qualitative answers: ${view.ai.model === 'demo' ? 'demo' : `${esc(view.ai.model)}, ${esc(view.ai.createdAt.slice(0, 10))}`}.` : ''}
    Not financial advice — scores are rules of thumb applied to reported numbers. Read the reasoning on each card and overrule anything you disagree with.</p>
  </main>`;
  window.scrollTo(0, scrollY);
  // Year tables read newest-last; start them scrolled to the latest year.
  $app.querySelectorAll('.tscroll').forEach(el => { el.scrollLeft = el.scrollWidth; });
  attachHover($app);
  wireReport();
}

function reportTopbar() {
  return `<header class="topbar"><a class="brand" href="#/">${logo()}<span>Stock Simplifier</span></a>
    <form class="mini-search" id="mini"><input name="t" placeholder="Ticker" aria-label="Ticker symbol" autocapitalize="characters" maxlength="15"></form>
    <a class="iconbtn" href="#/settings" aria-label="Settings">${gear()}</a></header>`;
}

const cur = () => (view.company?.currency && view.company.currency !== 'USD' ? view.company.currency + ' ' : '$');

function sectionHead(id, title, sub = '') {
  return `<h2 class="sec-title" id="${id}">${esc(title)}${sub ? `<span class="sec-sub">${sub}</span>` : ''}</h2>`;
}

// --- AI panel ---

function aiPanel() {
  const c = view.company;
  if (c.demo) return '';
  const s = settings();
  const has = !!view.ai;
  let body;
  if (view.aiBusy) body = `<div class="spinner sm" aria-hidden="true"></div><span>${esc(view.aiStatus)}</span>`;
  else if (!s.anthropicKey) body = `<span>Questions like moat sources and customer concentration are blank until you set them by tapping, or <a href="#/settings">add an Anthropic key</a> to let Claude answer them.</span>`;
  else body = `<span>${has ? `AI assessment from ${esc(view.ai.createdAt.slice(0, 10))}.` : 'Let Claude answer the qualitative questions (moat, customers, disruption, management).'}</span>
    <button class="btn ${has ? 'ghost' : 'primary'} sm" data-action="ai">${has ? 'Re-run' : 'Run AI assessment'}</button>`;
  return `<div class="ai-panel ${view.aiError ? 'err' : ''}">${spark()}<div class="ai-body">${body}${view.aiError ? `<p class="ai-err">${esc(view.aiError)}</p>` : ''}</div></div>`;
}

// --- verdict ---

function verdictSection(r) {
  const rows = [
    ['Business', r.business.score, SCALE_LABELS.business],
    ['Moat', r.moat.width, SCALE_LABELS.moatWidth],
    ['Moat direction', r.moat.direction, SCALE_LABELS.moatDirection],
    ['Growth', r.growth.score, SCALE_LABELS.growth],
    ['Management', r.management.score, SCALE_LABELS.management],
    ['Risk', r.risk.score, SCALE_LABELS.risk],
  ];
  const v = r.valuation;
  return `<section class="sec">${sectionHead('verdict', 'My verdict')}
  <div class="card">
    <div class="calls">${CALLS.map(c => `<span class="callpill ${c === r.verdict.call ? 'on call-' + c.toLowerCase() : ''}">${c}</span>`).join('')}</div>
    <p class="verdict-line">${esc(r.verdict.line)}</p>
    ${view.ai?.text?.summary ? `<p class="muted small">${esc(view.ai.text.summary)}</p>` : ''}
  </div>
  <div class="card phase-chip"><span class="ph-k">Phase</span><b>${r.phase.phase} of 5</b> ${esc(r.phase.name)}</div>
  <div class="card">
    <div class="tbl-head"><span class="eyebrow">The business</span><span>composite <b class="big ${tone(Math.round(r.quality))}">${r.quality.toFixed(1)}</b>/5 · ${esc(r.qualityLabel)}</span></div>
    ${rows.map(([name, sc, labels]) => `<div class="score-row"><span>${name}</span><span class="lbl ${tone(sc)}">${labels[sc - 1]}</span>${meter(sc)}<b>${sc}</b></div>`).join('')}
  </div>
  <div class="card">
    <span class="eyebrow">The valuation</span>
    <div class="score-row"><span>${esc(v.metric.short)} ${fmtX(v.current)}</span>
      <span class="lbl ${tone(v.score)}">${SCALE_LABELS.valuation[v.score - 1]}</span>${meter(v.score)}<b>${v.score}</b></div>
    <p class="muted small flush">vs ${fmtX(v.average)} ${v.avgYears}-year median</p>
    ${valueStrip(v.prices, cur())}
  </div></section>`;
}

const tone = s => (s >= 4 ? 'good' : s === 3 ? 'mid' : 'bad');

// --- three-option question cards ---

const ICON = { 1: '✕', 2: '–', 3: '✓' };
const SOURCE = { auto: 'From the numbers', ai: 'AI', you: 'Your call', none: 'Not assessed — tap an option' };

function qCard(key, question, options, q) {
  return `<div class="card q">
    <div class="q-head"><h3>${esc(question)}</h3><span class="src src-${q.source}">${SOURCE[q.source]}</span></div>
    <div class="opts" role="radiogroup" aria-label="${esc(question)}">${options.map((o, i) => {
      const val = i + 1, on = q.value === val;
      return `<button class="opt t${val} ${on ? 'on' : ''}" role="radio" aria-checked="${on}" data-action="set" data-key="${key}" data-val="${val}">
        <span class="ico">${ICON[val]}</span><span>${esc(o)}</span></button>`;
    }).join('')}</div>
    ${q.note ? `<p class="note">${esc(q.note)}</p>` : ''}
    ${q.source === 'you' ? `<button class="link" data-action="reset" data-key="${key}">Undo my override</button>` : ''}
  </div>`;
}

// --- business ---

function businessSection(r) {
  const c = view.company, t = view.ai?.text, o = r.overview, q = r.business.questions;
  const info = (label, text) => text ? `<div class="card info"><span class="eyebrow">${label}</span><p>${esc(text)}</p></div>` : '';
  const g = o.growth, v = o.valuation, h = o.health, p = o.profitability, ret = o.returns;
  const tr = (k, val) => `<tr><th>${k}</th><td>${val}</td></tr>`;
  return `<section class="sec">${sectionHead('business', 'Business', `<span class="pill">${r.business.score}/5 · ${SCALE_LABELS.business[r.business.score - 1]}</span>`)}
  <h3 class="h-sub">Overview</h3>
  ${info('Mission', t?.mission)}
  ${info(`What does ${esc(c.name)} do?`, t?.whatItDoes || c.description?.split(/(?<=\.)\s/).slice(0, 2).join(' '))}
  ${info('How does it make money?', t?.howItMakesMoney)}
  <div class="card"><div class="tbl-head"><span class="eyebrow">Revenue by segment</span></div>${shareBars(c.segments, cur())}</div>
  <h3 class="h-sub">Customers</h3>
  ${info('Who are the customers?', t?.customers)}
  ${info(`Why do they buy from ${esc(c.name)}?`, t?.whyBuy)}
  <div class="card"><div class="tbl-head"><span class="eyebrow">Revenue by geography</span></div>${shareBars(c.geography, cur())}</div>
  <h3 class="h-sub">Financial overview <span class="muted small">last twelve months</span></h3>
  <div class="fin-grid">
    <div class="card"><h4>Profitability</h4><table class="kv">${tr('Gross margin', fmtPct(p.gross))}${tr('Operating margin', fmtPct(p.operating))}${tr('Net margin', fmtPct(p.net))}${tr('Free cash flow margin', fmtPct(p.fcf))}</table></div>
    <div class="card"><h4>Financial health</h4><table class="kv">${tr('Cash & investments', fmtMoney(h.cash, cur()))}${tr('Total debt', fmtMoney(h.debt, cur()))}${tr('Debt / equity', isNum(h.de) ? h.de.toFixed(2) + '×' : '—')}${tr('EBIT / interest', isNum(h.coverage) ? fmtX(h.coverage) : 'no interest')}${tr('Return on invested capital', fmtPct(h.roic))}</table></div>
    <div class="card"><h4>Growth · annualised</h4><table class="kv">${tr('Revenue 3-yr', fmtSigned(g.rev.y3))}${tr('Revenue 5-yr', fmtSigned(g.rev.y5))}${tr('Revenue 10-yr', fmtSigned(g.rev.y10))}${tr('EPS 3-yr', fmtSigned(g.eps.y3))}${tr('EPS 5-yr', fmtSigned(g.eps.y5))}${tr('FCF 3-yr', fmtSigned(g.fcf.y3))}${tr('FCF 5-yr', fmtSigned(g.fcf.y5))}</table></div>
    <div class="card"><h4>Valuation</h4><table class="kv">${tr('Market cap', fmtMoney(v.marketCap, cur()))}${tr('Price / sales', fmtX(v.ps))}${tr('Price / earnings', fmtX(v.pe))}${tr('Price / book', fmtX(v.pb))}${tr('Price / free cash flow', fmtX(v.pfcf))}</table></div>
    <div class="card"><h4>Shareholder returns</h4><table class="kv">${tr('Dividend yield', fmtPct(ret.dividend))}${tr('Buyback yield', fmtPct(ret.buyback))}${tr('Debt paydown yield', fmtPct(ret.paydown))}${tr('Total shareholder yield', fmtPct(ret.dividend + ret.buyback + ret.paydown))}</table></div>
  </div>
  <h3 class="h-sub">Business quality</h3>
  <div class="grid2">
    ${qCard('predictability', 'How predictable is revenue?', ['Unpredictable', 'Modest', 'Predictable'], q.predictability)}
    ${qCard('pricingPower', 'Can the company raise prices?', ['No', 'Sometimes', 'Easily'], q.pricingPower)}
    ${qCard('recession', 'How recession-proof is it?', ['Weak', 'Okay', 'Strong'], q.recession)}
    ${qCard('competitive', 'What is their competitive position?', ['Weak', 'Average', 'Dominant'], q.competitive)}
  </div></section>`;
}

// --- phase ---

function phaseSection(r) {
  const p = r.phase, c = view.company;
  const metric = r.valuation.metric;
  return `<section class="sec">${sectionHead('phase', 'Phase', `<span class="pill">${p.phase} of 5 · ${esc(p.name)}</span>`)}
  <div class="phase-top">
    <div class="card checks">${p.checks.map(ch => `<div class="check-row"><div><b>${esc(ch.q)}</b><span class="muted small">${esc(ch.detail)}</span></div>
      <span class="yn ${ch.yes ? 'yes' : 'no'}">${ch.yes ? '✓ Yes' : '✕ No'}</span></div>`).join('')}</div>
    <div class="card metric-card"><span class="eyebrow">Valuation metric</span><b>${esc(metric.label)}</b><span class="small">fits a phase ${p.phase} company</span></div>
  </div>
  <div class="card">${growthChart(r.points, cur(), 'operatingIncome', 'Operating profit')}</div>
  <div class="card">${phaseDiagram(p.phase, c.symbol)}</div></section>`;
}

// --- moat ---

const STRENGTH = ['None', 'Weak', 'Moderate', 'Strong'];
const DIR = { '-1': '↘ Narrowing', 0: '', 1: '↗ Widening' };

function moatSection(r) {
  const m = r.moat;
  return `<section class="sec">${sectionHead('moat', 'Moat')}
  <div class="grid2">
    <div class="card"><span class="eyebrow">Width</span>${stepper(m.width, SCALE_LABELS.moatWidth)}<p class="note">${esc(m.widthNote)}</p></div>
    <div class="card"><span class="eyebrow">Direction</span>${stepper(m.direction, SCALE_LABELS.moatDirection)}<p class="note">${esc(m.trendNote)}</p></div>
  </div>
  ${m.sources.map(s => {
    const st = s.strength;
    const cls = st === null ? 'unk' : st >= 3 ? 'good' : st === 2 ? 'mid' : 'bad';
    return `<div class="card moat-src">
      <button class="moat-btn" data-action="moat" data-key="${s.key}" aria-label="${esc(s.label)}: ${st === null ? 'not assessed' : STRENGTH[st]}. Tap to change.">
        <span class="ms-name">${esc(s.label)}</span>
        <span class="ms-bars ${cls}">${[1, 2, 3].map(i => `<i class="${st !== null && i <= st ? 'on' : ''}"></i>`).join('')}</span>
        <span class="ms-val ${cls}">${st === null ? 'Not assessed' : STRENGTH[st].toUpperCase()}</span>
        <span class="ms-dir">${st ? esc(DIR[s.direction] || '') : ''}</span>
      </button>
      ${s.note ? `<p class="note">${esc(s.note)}</p>` : ''}
      <span class="src src-${s.source}">${s.source === 'none' ? 'Tap to rate' : SOURCE[s.source]}</span>
      ${s.source === 'you' ? `<button class="link" data-action="reset" data-key="moat.${s.key}">Undo my override</button>` : ''}
    </div>`;
  }).join('')}</section>`;
}

// --- growth ---

function growthSection(r) {
  const g = r.growth;
  const tiles = (title, o, cls) => `<div class="card cagr"><span class="eyebrow ${cls}">${title}</span>
    <div class="cagr-row">${[['1Y', o.y1], ['3Y', o.y3], ['5Y', o.y5]].map(([k, v]) => `<div><span>${k}</span><b class="${isNum(v) ? (v >= 0 ? 'up' : 'down') : ''}">${fmtSigned(v)}</b></div>`).join('')}</div></div>`;
  return `<section class="sec">${sectionHead('growth', 'Growth')}
  <div class="card">${stepper(g.score, SCALE_LABELS.growth)}</div>
  <div class="grid2">${tiles('Revenue CAGR', g.rev, 's1')}${tiles('Earnings per share CAGR', g.eps, 's2')}</div>
  <div class="card">${growthChart(r.points, cur(), 'netIncome', 'Earnings')}</div>
  <div class="grid2">
    ${qCard('industryGrowing', 'Is the industry growing?', ['No', 'Slowly', 'Yes'], g.industryGrowing)}
    ${qCard('newOfferings', 'Room for new offerings?', ['Unlikely', 'Possible', 'Underway'], g.newOfferings)}
  </div></section>`;
}

// --- management ---

function managementSection(r) {
  const m = r.management;
  const surprise = s => (s ? `<span class="${s.beat / s.n >= 0.5 ? 'up' : 'down'}">Beat ${s.beat}/${s.n} · avg ${fmtSigned(s.avg)}</span>` : '');
  const tenure = isNum(m.ceoTenure.value) ? `${Math.round(m.ceoTenure.value)} yrs in the seat` : 'tenure unknown';
  const own = isNum(m.ownership.value) ? `owns ${fmtPct(m.ownership.value, 3)}` : '';
  const founder = m.founder.value === true ? ['Involved', m.founder.note || 'A founder still helps run the company.']
    : m.founder.value === false ? ['Not involved', m.founder.note || 'No founder is still involved in running the company.']
      : ['Unknown', 'Run the AI assessment or check the proxy statement.'];
  return `<section class="sec">${sectionHead('management', 'Management')}
  <div class="card">${stepper(m.score, SCALE_LABELS.management)}${m.reasons.length ? `<p class="note">${esc(cap(m.reasons.join('; ')))}.</p>` : ''}</div>
  <div class="grid2">
    <div class="card"><span class="eyebrow">CEO</span><b class="h-md">${esc(m.ceo || 'Unknown')}</b><p class="small muted">${esc([tenure, own].filter(Boolean).join(' · '))}</p></div>
    <div class="card"><span class="eyebrow">Founder</span><b class="h-md">${esc(founder[0])}</b><p class="small muted">${esc(founder[1])}</p></div>
  </div>
  <div class="card"><div class="tbl-head"><span class="eyebrow">Revenue vs. estimate</span>${surprise(m.revS)}</div>${beatChart(m.earnings, 'revenueActual', 'revenueEstimated', v => fmtMoney(v, cur()))}
    <div class="legend small"><span><i style="background:var(--good)"></i>Beat</span><span><i style="background:var(--bad)"></i>Miss</span><span><i class="ring"></i>Estimate</span></div></div>
  <div class="card"><div class="tbl-head"><span class="eyebrow">Earnings per share vs. estimate</span>${surprise(m.epsS)}</div>${beatChart(m.earnings, 'epsActual', 'epsEstimated', v => `${cur()}${v.toFixed(2)}`)}</div>
  <div class="grid2">
    <div class="card"><span class="eyebrow">Share count</span><b class="h-md ${isNum(m.shareCagr) ? (m.shareCagr <= 0 ? 'up' : m.shareCagr > 0.02 ? 'down' : '') : ''}">${isNum(m.shareCagr) ? fmtSigned(m.shareCagr) + ' / yr' : '—'}</b><p class="small muted">Falling = buybacks; rising = dilution from stock pay or raises.</p></div>
    <div class="card"><span class="eyebrow">How employees rate it</span><b class="h-md">${isNum(m.employeeRating.value) ? m.employeeRating.value.toFixed(1) + ' / 5' : '—'}</b><p class="small muted">${esc(m.employeeRating.note || 'On employee review sites. Needs the AI assessment.')}</p></div>
  </div></section>`;
}

// --- risk ---

function riskSection(r) {
  const q = r.risk.questions;
  return `<section class="sec">${sectionHead('risk', 'Risk')}
  <div class="card">${stepper(r.risk.score, SCALE_LABELS.risk)}</div>
  <div class="grid2">
    ${qCard('diversification', 'How diversified are revenues?', ['Concentrated', 'Moderate', 'Diversified'], q.diversification)}
    ${qCard('disruption', 'Is disruption a threat?', ['Yes', 'Some risk', 'No'], q.disruption)}
    ${qCard('outsideControl', 'How much is outside their control?', ['A lot', 'Some', 'Very little'], q.outsideControl)}
    ${qCard('financial', 'How healthy are the financials?', ['Weak', 'Mixed', 'Strong'], q.financial)}
  </div></section>`;
}

// --- valuation ---

function valuationSection(r) {
  const v = r.valuation, m = v.multiples;
  const span = v.history.length ? (new Date(v.history.at(-1).date) - new Date(v.history[0].date)) / (365.25 * 864e5) : 0;
  const choices = [1, 3, 5].filter(y => y === 1 || span >= y - 0.5);
  const years = choices.includes(view.valYears) ? view.valYears : choices.at(-1);
  return `<section class="sec">${sectionHead('valuation', 'Valuation')}
  <div class="card">${stepper(v.score, SCALE_LABELS.valuation)}</div>
  <div class="card reason">${esc(v.reason)}.</div>
  ${v.peakWarning ? `<div class="card warn">⚠ ${esc(v.peakWarning)}</div>` : ''}
  <div class="card">
    <div class="tbl-head"><span class="h-sm">${esc(v.metric.label)} (trailing)</span>
      <span class="seg" role="group" aria-label="Chart range">${choices.map(y => `<button class="${y === years ? 'on' : ''}" data-action="years" data-val="${y}">${y}Y</button>`).join('')}</span></div>
    <div class="legend small"><span><i style="background:var(--zone-good-solid)"></i>Cheap</span><span><i style="background:var(--zone-mid-solid)"></i>Fair value</span><span><i style="background:var(--zone-bad-solid)"></i>Expensive</span><span><i class="dash"></i>${v.avgYears}-yr median</span></div>
    ${multipleChart(v, years, cur())}
  </div>
  <div class="tiles">${[['P/S', m.ps], ['P/E', m.pe], ['P/B', m.pb], ['P/FCF', m.pfcf]].map(([k, x]) => `<div class="card tile"><span>${k}</span><b>${fmtX(x)}</b></div>`).join('')}</div>
  </section>`;
}

// ---------- interactions ----------

function wireReport() {
  document.getElementById('mini')?.addEventListener('submit', e => {
    e.preventDefault();
    const t = new FormData(e.target).get('t')?.toString().trim().toUpperCase();
    if (t) go('s/' + t);
  });
  $app.querySelectorAll('[data-jump]').forEach(a => a.addEventListener('click', e => {
    e.preventDefault();
    document.getElementById(a.dataset.jump)?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  }));
  $app.querySelector('.report')?.addEventListener('click', onReportClick);
  spy();
}

function saveOverrides() {
  store.set('ss.ov.' + view.symbol, view.overrides);
  renderReport();
}

function onReportClick(e) {
  const b = e.target.closest('[data-action]');
  if (!b) return;
  const { action, key, val } = b.dataset;
  if (action === 'set') {
    const n = Number(val);
    // Tapping your own choice again clears it.
    if (view.overrides[key] === n) delete view.overrides[key]; else view.overrides[key] = n;
    saveOverrides();
  } else if (action === 'reset') {
    delete view.overrides[key];
    saveOverrides();
  } else if (action === 'moat') {
    const src = view.report.moat.sources.find(s => s.key === key);
    const next = src.strength === null ? 1 : (src.strength + 1) % 4;
    view.overrides['moat.' + key] = { strength: next, direction: src.direction || 0 };
    saveOverrides();
  } else if (action === 'years') {
    view.valYears = Number(val);
    renderReport();
  } else if (action === 'ai') {
    runAI();
  }
}

async function runAI() {
  const s = settings();
  const symbol = view.symbol;
  view.aiBusy = true; view.aiError = ''; view.aiStatus = 'Starting…';
  renderReport();
  try {
    const result = await assess(view.company, view.report, {
      apiKey: s.anthropicKey, model: s.model, webSearch: s.webSearch,
      onStatus: msg => {
        view.aiStatus = msg;
        const el = $app.querySelector('.ai-body span');
        if (el && view.symbol === symbol) el.textContent = msg;
      },
    });
    store.set('ss.ai.' + symbol, result);
    if (view.symbol === symbol) view.ai = result;
  } catch (e) {
    if (view.symbol === symbol) view.aiError = e.message || String(e);
  } finally {
    view.aiBusy = false;
    if (view.symbol === symbol && location.hash.includes('s/' + symbol)) renderReport();
  }
}

// Highlight the tab of the section currently in view.
let observer;
function spy() {
  observer?.disconnect();
  const tabs = [...$app.querySelectorAll('#tabs a')];
  observer = new IntersectionObserver(entries => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      tabs.forEach(t => t.classList.toggle('on', t.dataset.jump === en.target.id));
      const on = tabs.find(t => t.dataset.jump === en.target.id);
      on?.scrollIntoView({ block: 'nearest', inline: 'center' });
    }
  }, { rootMargin: '-120px 0px -65% 0px' });
  NAV.forEach(([id]) => { const el = document.getElementById(id); if (el) observer.observe(el); });
}

// ---------- icons ----------

const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
function logo() {
  return '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3" fill="none" stroke="currentColor" stroke-width="2"/><path d="M7 15l3-3 3 2 4-5" fill="none" stroke="var(--accent)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
}
function gear() {
  return '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
}
function spark() {
  return '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" class="spark"><path d="M12 2l2.2 6.3L20.5 10l-6.3 2.2L12 18.5l-2.2-6.3L3.5 10l6.3-1.7z" fill="currentColor"/></svg>';
}

// ---------- start ----------

// Charts are drawn at real pixel width, so redraw when the width changes a lot.
let lastWidth = cardWidth();
window.addEventListener('resize', () => {
  clearTimeout(window.__rz);
  window.__rz = setTimeout(() => {
    if (Math.abs(cardWidth() - lastWidth) > 40 && view.report && /#\/s\//.test(location.hash)) {
      lastWidth = cardWidth();
      renderReport();
    }
  }, 200);
});

window.addEventListener('hashchange', route);
route();

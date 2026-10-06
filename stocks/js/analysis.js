// Stock analysis engine. Pure functions only: no DOM, no network.
//
// Input is a normalized `company` object (see providers/fmp.js for how it is
// built). Output is a report with one section per tab: business, phase, moat,
// growth, management, risk, valuation and the verdict.
//
// Qualitative questions (moat sources, disruption risk, ...) cannot be read off
// financial statements. Each one is resolved in this order:
//   1. the user's own override (tapping an option in the UI)
//   2. the AI assessment, if one was run
//   3. a heuristic computed from the numbers, when one exists
//   4. otherwise "not assessed", which scores as the neutral middle option.

const DAY = 86400000;
const YEAR = 365.25 * DAY;

// ---------- small numeric helpers ----------

export const isNum = v => typeof v === 'number' && Number.isFinite(v);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const mean = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const sum = a => a.reduce((s, v) => s + (isNum(v) ? v : 0), 0);
const last = a => a[a.length - 1];
const t = d => new Date(d).getTime();

export function safeDiv(a, b) {
  return isNum(a) && isNum(b) && b !== 0 ? a / b : null;
}

export function cagr(first, lastV, years) {
  if (!(first > 0) || !(lastV > 0) || !(years > 0)) return null;
  return Math.pow(lastV / first, 1 / years) - 1;
}

// Median rather than mean: multiples spike when earnings briefly collapse,
// and a few of those days would drag an average far from the typical level.
function median(values) {
  const v = values.filter(isNum).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

// ---------- trailing-twelve-month figures ----------

const FLOW = ['revenue', 'grossProfit', 'operatingIncome', 'netIncome', 'eps',
  'interestExpense', 'incomeTaxExpense', 'incomeBeforeTax', 'operatingCashFlow',
  'capex', 'freeCashFlow', 'dividendsPaid', 'buybacks', 'debtPaydown'];
const STOCK = ['cashAndInvestments', 'totalDebt', 'equity', 'sharesDiluted'];

// Sum of four quarters ending at index `end` (inclusive), or null.
function ttmAt(quarters, end) {
  if (end < 3) return null;
  const qs = quarters.slice(end - 3, end + 1);
  const out = { date: qs[3].date, filingDate: qs[3].filingDate, label: 'LTM' };
  for (const f of FLOW) out[f] = qs.every(q => isNum(q[f])) ? sum(qs.map(q => q[f])) : null;
  for (const f of STOCK) out[f] = qs[3][f] ?? null;
  return out;
}

// The latest twelve months. Uses the last four quarters when they are newer
// than the latest annual report, otherwise the latest annual report itself.
export function ltm(company) {
  const annual = company.annual || [];
  const q = company.quarterly || [];
  const la = last(annual);
  if (q.length >= 4 && (!la || t(last(q).date) > t(la.date) + 20 * DAY)) {
    const x = ttmAt(q, q.length - 1);
    for (const f of FLOW) if (!isNum(x[f]) && la) x[f] = la[f] ?? null;
    return x;
  }
  return la ? { ...la, label: 'LTM' } : null;
}

// Annual points plus an LTM point when it is newer. Used for CAGRs and charts.
export function yearlyPoints(company) {
  const annual = (company.annual || []).map(a => ({ ...a, label: 'FY' + String(a.fiscalYear).slice(-2) }));
  const l = ltm(company);
  if (l && (!annual.length || t(l.date) > t(last(annual).date) + 20 * DAY)) annual.push(l);
  return annual;
}

// CAGR of `field` over roughly `years`, measured to the latest point.
export function growthRate(points, field, years) {
  const end = last(points);
  if (!end) return null;
  const target = t(end.date) - years * YEAR;
  let best = null;
  for (const p of points) {
    if (p === end) continue;
    const gap = Math.abs(t(p.date) - target);
    if (gap < 0.6 * YEAR && (!best || gap < Math.abs(t(best.date) - target))) best = p;
  }
  if (!best) return null;
  return cagr(best[field], end[field], (t(end.date) - t(best.date)) / YEAR);
}

// One-year growth of the latest point. Quarter-based when quarters allow it.
export function oneYearGrowth(company, field) {
  const q = company.quarterly || [];
  if (q.length >= 8) {
    const now = ttmAt(q, q.length - 1), ago = ttmAt(q, q.length - 5);
    if (now && ago && isNum(now[field]) && isNum(ago[field]) && ago[field] !== 0) {
      if (ago[field] < 0) return null;
      return now[field] / ago[field] - 1;
    }
  }
  return growthRate(yearlyPoints(company), field, 1);
}

function yoy(points, field) {
  return points.map((p, i) => {
    const prev = points[i - 1];
    if (!prev || !isNum(p[field]) || !isNum(prev[field]) || prev[field] === 0) return null;
    return (p[field] - prev[field]) / Math.abs(prev[field]);
  });
}

// ---------- returns on capital ----------

export function roic(row) {
  const tax = safeDiv(row.incomeTaxExpense, row.incomeBeforeTax);
  const rate = isNum(tax) && tax >= 0 && tax <= 0.5 ? tax : 0.21;
  const ic = (row.equity ?? 0) + (row.totalDebt ?? 0) - (row.cashAndInvestments ?? 0);
  if (!isNum(row.operatingIncome) || !(ic > 0)) return null;
  return (row.operatingIncome * (1 - rate)) / ic;
}

// ---------- per-share history and valuation multiples ----------

const METRICS = {
  ps: { label: 'Price to Sales', short: 'P/S', field: 'revenue' },
  pe: { label: 'Price to Earnings', short: 'P/E', field: 'netIncome' },
  pfcf: { label: 'Price to Free Cash Flow', short: 'P/FCF', field: 'freeCashFlow' },
  pop: { label: 'Price to Operating Profit', short: 'P/OP', field: 'operatingIncome' },
};
export { METRICS };

// Step function of trailing per-share value, keyed by the date the figure
// became public (filing date, or period end plus a typical reporting lag).
export function perShareSteps(company, field) {
  const steps = [];
  const avail = (row, lagDays) => row.filingDate ? t(row.filingDate) : t(row.date) + lagDays * DAY;
  for (const a of company.annual || []) {
    const ps = safeDiv(a[field], a.sharesDiluted);
    if (isNum(ps)) steps.push({ at: avail(a, 60), value: ps });
  }
  const q = company.quarterly || [];
  for (let i = 3; i < q.length; i++) {
    const x = ttmAt(q, i);
    const ps = x && safeDiv(x[field], x.sharesDiluted);
    if (isNum(ps)) steps.push({ at: avail(q[i], 40), value: ps });
  }
  steps.sort((a, b) => a.at - b.at);
  return steps;
}

// Daily multiple history: price divided by the per-share figure known that day.
// Days where the figure is zero or negative have no meaningful multiple.
export function multipleHistory(company, field) {
  const steps = perShareSteps(company, field);
  const out = [];
  let j = -1;
  for (const p of company.prices || []) {
    const at = t(p.date);
    while (j + 1 < steps.length && steps[j + 1].at <= at) j++;
    if (j < 0) continue;
    const ps = steps[j].value;
    out.push({ date: p.date, price: p.close, multiple: ps > 0 ? p.close / ps : null });
  }
  return out;
}

export function currentMultiples(company) {
  const l = ltm(company) || {};
  const shares = l.sharesDiluted || last(company.annual || [])?.sharesDiluted;
  const mcap = company.marketCap || (isNum(company.price) && shares ? company.price * shares : null);
  const pos = v => (isNum(v) && v > 0 ? v : null);
  return {
    marketCap: mcap,
    ps: pos(safeDiv(mcap, l.revenue)),
    pe: pos(safeDiv(mcap, l.netIncome)),
    pb: pos(safeDiv(mcap, l.equity)),
    pfcf: pos(safeDiv(mcap, l.freeCashFlow)),
    pop: pos(safeDiv(mcap, l.operatingIncome)),
  };
}

// ---------- qualitative input resolution ----------

// Resolve one qualitative answer. `auto` is {value, note} from a heuristic.
function pick(key, overrides, ai, auto) {
  if (overrides && overrides[key] !== undefined && overrides[key] !== null) {
    return { value: overrides[key], note: ai?.[key]?.note ?? auto?.note ?? '', source: 'you' };
  }
  if (ai && ai[key] && ai[key].value !== undefined && ai[key].value !== null) {
    return { value: ai[key].value, note: ai[key].note || '', source: 'ai' };
  }
  if (auto && auto.value !== undefined && auto.value !== null) return { ...auto, source: 'auto' };
  return { value: null, note: '', source: 'none' };
}

// Three-way answers are 1 (bad), 2 (middle), 3 (good). Unknown counts as 2.
const tri = v => (v === 1 || v === 2 || v === 3 ? v : 2);
// Sum of four three-way answers (4..12) mapped onto 1..5.
const fourToFive = vals => clamp(1 + Math.round(((sum(vals.map(tri)) - 4) / 8) * 4), 1, 5);

// ---------- sections ----------

function businessSection(ctx) {
  const { points, roics, overrides, ai } = ctx;
  const annual = points.filter(p => p.label !== 'LTM');
  const growth = yoy(annual, 'revenue').filter(isNum);
  const declines = growth.filter(g => g < 0);
  const worstDrop = declines.length ? Math.min(...declines) : 0;
  const sd = growth.length > 1 ? Math.sqrt(mean(growth.map(g => (g - mean(growth)) ** 2))) : null;

  let predictability = null;
  if (growth.length >= 3) {
    const note = `Revenue fell in ${declines.length} of the last ${growth.length} years` +
      (declines.length ? `, worst year ${pct(worstDrop)}.` : '.');
    if (declines.length === 0 && sd < 0.15) predictability = { value: 3, note };
    else if (declines.length <= 1 && worstDrop > -0.1) predictability = { value: 2, note };
    else predictability = { value: 1, note };
  }

  const gms = annual.map(p => safeDiv(p.grossProfit, p.revenue)).filter(isNum);
  let pricing = null;
  if (gms.length >= 3) {
    const range = Math.max(...gms) - Math.min(...gms);
    const avg = mean(gms);
    const note = `Gross margin averaged ${pct(avg)} and moved in a ${pct(range, 0)}-point range.`;
    if (range > 0.2 || avg < 0.25) pricing = { value: 1, note };
    else if (avg >= 0.5 && range < 0.1) pricing = { value: 3, note };
    else pricing = { value: 2, note };
  }

  const opMargins = annual.map(p => safeDiv(p.operatingIncome, p.revenue)).filter(isNum);
  let recession = null;
  if (opMargins.length >= 3) {
    const worstOm = Math.min(...opMargins);
    const worstRoic = roics.filter(isNum).length ? Math.min(...roics.filter(isNum)) : null;
    const note = `Worst year: revenue ${pct(worstDrop)}, operating margin ${pct(worstOm)}` +
      (isNum(worstRoic) ? `, return on capital ${pct(worstRoic)}.` : '.');
    if (worstOm < 0 || worstDrop < -0.15) recession = { value: 1, note };
    else if (worstDrop < 0) recession = { value: 2, note };
    else recession = { value: 3, note };
  }

  const recentRoic = roics.filter(isNum).slice(-3);
  let competitive = null;
  if (recentRoic.length) {
    const r = mean(recentRoic);
    const note = `Return on invested capital averaged ${pct(r)} over the last ${recentRoic.length} years.`;
    competitive = { value: r >= 0.2 ? 3 : r >= 0.1 ? 2 : 1, note };
  }

  const q = {
    predictability: pick('predictability', overrides, ai, predictability),
    pricingPower: pick('pricingPower', overrides, ai, pricing),
    recession: pick('recession', overrides, ai, recession),
    competitive: pick('competitive', overrides, ai, competitive),
  };
  return { questions: q, score: fourToFive(Object.values(q).map(x => x.value)) };
}

export const MOAT_SOURCES = [
  ['switchingCosts', 'Switching Costs'],
  ['networkEffects', 'Network Effects'],
  ['intangibles', 'Intangible Assets'],
  ['lowCost', 'Low-Cost Production'],
  ['counterPositioning', 'Counter-Positioning'],
];

function moatSection(ctx) {
  const { roics, points, overrides, ai } = ctx;
  const r = roics.filter(isNum);

  // Width from returns on capital: a moat shows up as durable excess returns.
  let roicWidth = null;
  if (r.length >= 2) {
    const avg = mean(r), lo = Math.min(...r);
    roicWidth = avg >= 0.25 && lo >= 0.15 ? 5 : avg >= 0.15 ? 4 : avg >= 0.1 ? 3 : avg >= 0.05 ? 2 : 1;
  }

  const sources = MOAT_SOURCES.map(([key, label]) => {
    const s = pick('moat.' + key, overrides, ai, null);
    const v = s.value && typeof s.value === 'object' ? s.value : (isNum(s.value) ? { strength: s.value } : null);
    return { key, label, strength: v ? clamp(v.strength ?? 0, 0, 3) : null, direction: v?.direction ?? 0, note: s.note, source: s.source };
  });
  const assessed = sources.filter(s => s.strength !== null);
  let sourceWidth = null;
  if (assessed.length) {
    const maxS = Math.max(...assessed.map(s => s.strength));
    const strong = assessed.filter(s => s.strength >= 2).length;
    sourceWidth = clamp(1 + maxS + (strong >= 2 ? 1 : 0), 1, 5);
  }
  const widths = [roicWidth, sourceWidth].filter(isNum);
  const width = widths.length ? clamp(Math.round(mean(widths)), 1, 5) : 3;

  // Direction from the trend in returns on capital and gross margin.
  let trendDir = null, trendNote = '';
  if (r.length >= 4) {
    const half = Math.floor(r.length / 2);
    const delta = mean(r.slice(-2)) - mean(r.slice(0, half));
    const gms = points.map(p => safeDiv(p.grossProfit, p.revenue)).filter(isNum);
    const gmDelta = gms.length >= 4 ? mean(gms.slice(-2)) - mean(gms.slice(0, Math.floor(gms.length / 2))) : 0;
    const d = delta + gmDelta / 2;
    trendDir = d >= 0.08 ? 5 : d >= 0.03 ? 4 : d > -0.03 ? 3 : d > -0.08 ? 2 : 1;
    trendNote = `Return on capital moved ${pts(delta)} versus earlier years; gross margin ${pts(gmDelta)}.`;
  }
  const dirs = assessed.filter(s => s.strength > 0).map(s => 3 + 2 * clamp(s.direction, -1, 1));
  const srcDir = dirs.length ? mean(dirs) : null;
  const dirVals = [trendDir, srcDir].filter(isNum);
  const direction = dirVals.length ? clamp(Math.round(mean(dirVals)), 1, 5) : 3;

  return {
    width, direction, sources, trendNote,
    widthNote: r.length ? `Average return on invested capital ${pct(mean(r))} across ${r.length} years.` : '',
  };
}

function growthSection(ctx) {
  const { company, points, overrides, ai } = ctx;
  const rev = {
    y1: oneYearGrowth(company, 'revenue'),
    y3: growthRate(points, 'revenue', 3),
    y5: growthRate(points, 'revenue', 5),
    y10: growthRate(points, 'revenue', 10),
  };
  const eps = {
    y1: oneYearGrowth(company, 'eps'),
    y3: growthRate(points, 'eps', 3),
    y5: growthRate(points, 'eps', 5),
    y10: growthRate(points, 'eps', 10),
  };
  const fcf = {
    y3: growthRate(points, 'freeCashFlow', 3),
    y5: growthRate(points, 'freeCashFlow', 5),
    y10: growthRate(points, 'freeCashFlow', 10),
  };
  // Blend multi-year and recent growth so one boom year doesn't dominate.
  const basis = [rev.y3, rev.y5, rev.y1].filter(isNum);
  const g = basis.length ? (isNum(rev.y3) ? rev.y3 * 0.6 + (rev.y5 ?? rev.y3) * 0.2 + (rev.y1 ?? rev.y3) * 0.2 : basis[0]) : null;
  const score = !isNum(g) ? 3 : g >= 0.25 ? 5 : g >= 0.15 ? 4 : g >= 0.08 ? 3 : g >= 0.03 ? 2 : 1;
  return {
    rev, eps, fcf, score,
    revYoy: yoy(points, 'revenue'),
    earnYoy: yoy(points, 'netIncome'),
    industryGrowing: pick('industryGrowing', overrides, ai, null),
    newOfferings: pick('newOfferings', overrides, ai, null),
  };
}

function phaseSection(ctx) {
  const { company, points, l, growth } = ctx;
  const revG = growth.rev.y1 ?? growth.rev.y3;
  const growing = isNum(revG) ? revG > 0 : null;
  const opInc = l?.operatingIncome;
  const profitable = isNum(opInc) ? opInc > 0 : null;
  const prevOp = points.length >= 2 ? points[points.length - 2].operatingIncome : null;
  const mcap = currentMultiples(company).marketCap;
  const divs = l?.dividendsPaid ?? 0;
  const buys = l?.buybacks ?? 0;
  const returning = divs > 0 || (isNum(mcap) && buys > 0.005 * mcap);
  const returnKind = divs > 0 && buys > 0.005 * (mcap || Infinity) ? 'dividends and buybacks'
    : divs > 0 ? 'dividends only' : returning ? 'buybacks only' : 'none yet';
  const longDecline = isNum(growth.rev.y3) && growth.rev.y3 < -0.03 && isNum(growth.rev.y5) && growth.rev.y5 < 0;

  let phase;
  if (!profitable) phase = isNum(revG) && revG > 0.15 ? 2 : 1;
  else if (longDecline) phase = 5;
  else phase = returning ? 4 : 3;

  return {
    phase,
    name: PHASES[phase - 1],
    checks: [
      { q: 'Is revenue growing?', yes: !!growing, detail: isNum(revG) ? `${signedPct(revG)} in the last year` : 'not enough data' },
      { q: 'Is it profitable?', yes: !!profitable, detail: isNum(opInc) ? `${money(opInc)} operating profit${isNum(prevOp) ? (opInc > prevOp ? ', and rising' : ', but falling') : ''}` : 'not enough data' },
      { q: 'Is it returning capital?', yes: returning, detail: returnKind },
    ],
  };
}
export const PHASES = ['Startup', 'Hyper Growth', 'Operating Leverage', 'Capital Return', 'Decline'];

function managementSection(ctx) {
  const { company, roics, overrides, ai } = ctx;
  const er = (company.earnings || []).slice(-8);
  const beats = (a, e) => er.filter(x => isNum(x[a]) && isNum(x[e]));
  const revRows = beats('revenueActual', 'revenueEstimated');
  const epsRows = beats('epsActual', 'epsEstimated');
  const surprise = (rows, a, e) => rows.length
    ? { beat: rows.filter(x => x[a] >= x[e]).length, n: rows.length, avg: mean(rows.map(x => (x[a] - x[e]) / Math.abs(x[e] || 1))) }
    : null;
  const revS = surprise(revRows, 'revenueActual', 'revenueEstimated');
  const epsS = surprise(epsRows, 'epsActual', 'epsEstimated');

  // Share count trend: buybacks shrink it, heavy stock compensation grows it.
  const annual = company.annual || [];
  const sh = annual.map(a => a.sharesDiluted).filter(v => v > 0);
  const shareCagr = sh.length >= 3 ? cagr(sh[Math.max(0, sh.length - 6)], last(sh), Math.min(5, sh.length - 1)) : null;

  const founder = pick('founder', overrides, ai, null);
  const ceoTenure = pick('ceoTenure', overrides, ai, null);
  const ownership = pick('ceoOwnership', overrides, ai, null);

  let score = 1;
  const reasons = [];
  const beatRate = epsS ? epsS.beat / epsS.n : revS ? revS.beat / revS.n : null;
  if (isNum(beatRate) && beatRate >= 0.75) { score++; reasons.push('beats estimates consistently'); }
  const r3 = mean(roics.filter(isNum).slice(-3));
  if (isNum(r3) && r3 >= 0.15) { score++; reasons.push('earns high returns on capital'); }
  if (isNum(shareCagr) && shareCagr <= 0.01) { score++; reasons.push('keeps dilution in check'); }
  else if (isNum(shareCagr)) reasons.push(`share count growing ${pct(shareCagr)}/yr`);
  const skin = founder.value === true || (isNum(ownership.value) && ownership.value >= 0.01) || (isNum(ceoTenure.value) && ceoTenure.value >= 5);
  if (skin) { score++; reasons.push('leadership with tenure or skin in the game'); }
  if (!isNum(beatRate) && !founder.value && !isNum(ownership.value) && !isNum(ceoTenure.value)) score = Math.max(score, 3);

  return {
    ceo: company.ceo || ai?.ceoName?.value || null,
    founder, ceoTenure, ownership, revS, epsS, shareCagr,
    earnings: er, score: clamp(score, 1, 5), reasons,
    employeeRating: pick('employeeRating', overrides, ai, null),
  };
}

function riskSection(ctx) {
  const { l, company, overrides, ai } = ctx;
  let fin = null;
  if (l) {
    const cover = safeDiv(l.operatingIncome, l.interestExpense);
    const de = safeDiv(l.totalDebt, l.equity);
    const netCash = (l.cashAndInvestments ?? 0) - (l.totalDebt ?? 0);
    const parts = [];
    if (isNum(cover) && l.interestExpense > 0) parts.push(`operating profit covers interest ${cover.toFixed(1)}×`);
    if (isNum(de)) parts.push(`debt is ${de.toFixed(2)}× equity`);
    parts.push(netCash >= 0 ? `net cash of ${money(netCash)}` : `net debt of ${money(-netCash)}`);
    const note = cap(parts.join(', ')) + '.';
    const coverOk = !(l.interestExpense > 0) || (isNum(cover) && cover >= 10);
    if ((l.operatingIncome ?? 0) <= 0 && netCash < 0) fin = { value: 1, note };
    else if ((isNum(cover) && l.interestExpense > 0 && cover < 3) || (isNum(de) && (de > 2 || de < 0))) fin = { value: 1, note };
    else if (netCash >= 0 || (coverOk && isNum(de) && de < 0.5)) fin = { value: 3, note };
    else fin = { value: 2, note };
  }

  // Revenue concentration across reported segments, as a weak stand-in for
  // customer concentration (which only the annual report discloses).
  let div = null;
  const seg = company.segments?.items;
  if (seg && seg.length) {
    const total = sum(seg.map(s => s.value));
    const top = Math.max(...seg.map(s => s.value)) / (total || 1);
    const note = `Largest reported segment is ${pct(top, 0)} of revenue. Customer concentration isn't in the numbers — set it from the annual report.`;
    div = { value: top > 0.75 ? 1 : top > 0.45 ? 2 : 3, note };
  }

  const q = {
    diversification: pick('diversification', overrides, ai, div),
    disruption: pick('disruption', overrides, ai, null),
    outsideControl: pick('outsideControl', overrides, ai, null),
    financial: pick('financial', overrides, ai, fin),
  };
  return { questions: q, score: fourToFive(Object.values(q).map(x => x.value)) };
}

function valuationSection(ctx, phase) {
  const { company } = ctx;
  const now = currentMultiples(company);
  // The metric depends on the phase: early companies are valued on sales,
  // mature ones on earnings. Fall back when the preferred figure is negative.
  const prefs = phase <= 2 ? ['ps'] : phase === 3 ? ['pfcf', 'pop', 'ps'] : ['pe', 'pfcf', 'pop', 'ps'];
  const key = prefs.find(k => isNum(now[k])) || 'ps';
  const m = METRICS[key];
  const hist = multipleHistory(company, m.field);
  const lastDate = hist.length ? t(last(hist).date) : Date.now();
  const windowed = years => hist.filter(h => t(h.date) >= lastDate - years * YEAR);
  const span = hist.length ? (lastDate - t(hist[0].date)) / YEAR : 0;
  const avgYears = span >= 4.5 ? 5 : Math.max(1, Math.floor(span));
  const avg = median(windowed(avgYears).map(h => h.multiple));
  const cur = now[key];
  const ratio = safeDiv(cur, avg);
  const score = !isNum(ratio) ? 3 : ratio > 1.4 ? 1 : ratio > 1.15 ? 2 : ratio >= 0.85 ? 3 : ratio >= 0.65 ? 4 : 5;

  const l = ltm(company) || {};
  const perShare = safeDiv(l[m.field], l.sharesDiluted);

  // Cyclical businesses look cheapest on earnings right at the top of the
  // cycle, when margins are far above normal. Flag that case.
  const margins = (company.annual || []).map(a => safeDiv(a.operatingIncome, a.revenue)).filter(isNum);
  const lm = safeDiv(l.operatingIncome, l.revenue);
  const normal = margins.length >= 4 ? median(margins) : null;
  const peakWarning = isNum(lm) && isNum(normal) && normal > 0 && lm > normal * 1.5 && key !== 'ps'
    ? `Operating margin is ${pct(lm, 0)} versus a typical ${pct(normal, 0)}. If this is a cycle peak, today's multiple flatters the stock.`
    : null;
  const priceAt = mult => (isNum(perShare) && isNum(mult) ? mult * perShare : null);
  return {
    key, metric: m, current: cur, average: avg, avgYears, ratio, score,
    history: hist,
    window: windowed,
    band: { cheap: isNum(avg) ? avg * 0.85 : null, expensive: isNum(avg) ? avg * 1.15 : null },
    prices: { now: company.price, cheap: priceAt(avg * 0.85), fair: priceAt(avg), expensive: priceAt(avg * 1.15) },
    multiples: now, peakWarning,
    reason: `${company.name || company.symbol} is in phase ${phase}, so ${m.label} is useful`,
  };
}

export const SCALE_LABELS = {
  business: ['Avoid', 'Weak', 'Okay', 'Like it', 'Love it'],
  moatWidth: ['None', 'Thin', 'Narrow', 'Broad', 'Wide'],
  moatDirection: ['Narrowing', 'Eroding', 'Stable', 'Growing', 'Widening'],
  growth: ['Low', 'Below avg', 'Average', 'Above avg', 'High'],
  management: ['Poor', 'Below avg', 'Decent', 'Good', 'Great'],
  risk: ['Very high', 'High', 'Moderate', 'Low', 'Very low'],
  valuation: ['Very expensive', 'Expensive', 'Fair value', 'Attractive', 'Very attractive'],
};

export function qualityLabel(q) {
  return q >= 4.5 ? 'Exceptional' : q >= 3.8 ? 'Great' : q >= 3 ? 'Good' : q >= 2.2 ? 'Average' : 'Weak';
}

// Combine business quality and price into one call.
export function verdictFor(quality, valuation) {
  if (quality >= 3.8) {
    if (valuation >= 4) return { call: 'Buy', line: 'Great business, attractive price.' };
    if (valuation === 3) return { call: 'Buy', line: 'Great business at a fair price.' };
    return { call: 'Watch', line: 'Great business, bad valuation.' };
  }
  if (quality >= 3) {
    if (valuation >= 4) return { call: 'Buy', line: 'Good business, attractive price.' };
    if (valuation === 3) return { call: 'Hold', line: 'Good business, fair price.' };
    return { call: 'Watch', line: 'Good business, rich valuation.' };
  }
  if (quality >= 2.2) {
    if (valuation >= 4) return { call: 'Hold', line: 'Average business — cheap, but maybe for a reason.' };
    return { call: 'Pass', line: 'Average business, no edge at this price.' };
  }
  if (valuation >= 4) return { call: 'Pass', line: 'Weak business — cheap isn\'t enough.' };
  return { call: 'Sell', line: 'Weak business, expensive price.' };
}
export const CALLS = ['Sell', 'Pass', 'Hold', 'Watch', 'Buy'];

// ---------- financial overview table ----------

function overview(ctx, growth, now) {
  const l = ctx.l || {};
  const r = safeDiv;
  const mcap = now.marketCap;
  return {
    profitability: {
      gross: r(l.grossProfit, l.revenue), operating: r(l.operatingIncome, l.revenue),
      net: r(l.netIncome, l.revenue), fcf: r(l.freeCashFlow, l.revenue),
    },
    health: {
      cash: l.cashAndInvestments, debt: l.totalDebt, de: r(l.totalDebt, l.equity),
      coverage: l.interestExpense > 0 ? r(l.operatingIncome, l.interestExpense) : null,
    },
    returns: {
      dividend: r(l.dividendsPaid, mcap) ?? 0,
      buyback: r(l.buybacks, mcap) ?? 0,
      paydown: r(l.debtPaydown, mcap) ?? 0,
    },
    growth,
    valuation: now,
  };
}

// ---------- entry point ----------

export function analyze(company, { overrides = {}, ai = null } = {}) {
  const points = yearlyPoints(company);
  const roics = (company.annual || []).map(roic);
  const l = ltm(company);
  const ctx = { company, points, roics, l, overrides, ai };

  const business = businessSection(ctx);
  const moat = moatSection(ctx);
  const growth = growthSection(ctx);
  ctx.growth = growth;
  const phase = phaseSection(ctx);
  const management = managementSection(ctx);
  const risk = riskSection(ctx);
  const valuation = valuationSection(ctx, phase.phase);

  const parts = [business.score, moat.width, moat.direction, growth.score, management.score, risk.score];
  const quality = Math.round(mean(parts) * 10) / 10;
  const verdict = verdictFor(quality, valuation.score);
  const fin = overview(ctx, growth, valuation.multiples);
  fin.health.roic = last(roics.filter(isNum)) ?? null;

  return {
    company, points, roics, ltm: l,
    business, moat, growth, phase, management, risk, valuation, overview: fin,
    quality, qualityLabel: qualityLabel(quality), verdict,
  };
}

// ---------- formatting used in generated notes ----------

export function pct(v, digits = 1) {
  return isNum(v) ? (v * 100).toFixed(digits) + '%' : '—';
}
export function signedPct(v, digits = 1) {
  return isNum(v) ? (v >= 0 ? '+' : '') + (v * 100).toFixed(digits) + '%' : '—';
}
function pts(v) {
  return isNum(v) ? (v >= 0 ? '+' : '') + (v * 100).toFixed(1) + ' pts' : '—';
}
export function money(v, currency = '$') {
  if (!isNum(v)) return '—';
  const a = Math.abs(v), s = v < 0 ? '-' : '';
  if (a >= 1e12) return `${s}${currency}${(a / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `${s}${currency}${(a / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${s}${currency}${(a / 1e6).toFixed(0)}M`;
  if (a >= 1e3) return `${s}${currency}${(a / 1e3).toFixed(0)}K`;
  return `${s}${currency}${a.toFixed(2)}`;
}
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

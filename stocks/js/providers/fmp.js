// Financial Modeling Prep adapter. Fetches statements, prices and estimates
// and maps them onto the normalized company shape used by analysis.js.
//
// A free key (financialmodelingprep.com/developer) covers the required
// endpoints. Segments, quarterly statements and earnings estimates may need a
// paid plan; the app works without them and just shows less.

const BASE = 'https://financialmodelingprep.com/stable/';

export class ProviderError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function get(path, params, apiKey, fetchImpl) {
  const qs = new URLSearchParams({ ...params, apikey: apiKey });
  let res;
  try {
    res = await fetchImpl(`${BASE}${path}?${qs}`);
  } catch {
    throw new ProviderError('Could not reach Financial Modeling Prep. Check your connection.', 0);
  }
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  const msg = typeof body === 'string' ? body : body && (body['Error Message'] || body.message || body.error);
  if (!res.ok || (msg && !Array.isArray(body))) {
    const status = res.ok ? 400 : res.status;
    if (status === 401 || status === 403) throw new ProviderError('Your Financial Modeling Prep key was rejected. Check it in Settings.', status);
    if (status === 429) throw new ProviderError('Financial Modeling Prep daily limit reached. Try again tomorrow or use a paid key.', status);
    if (status === 402) throw new ProviderError(`Not included in your Financial Modeling Prep plan (${path}).`, status);
    throw new ProviderError(String(msg || `Request failed (${status}) for ${path}.`).slice(0, 240), status);
  }
  return Array.isArray(body) ? body : body ? [body] : [];
}

// Optional data: any failure (premium-only, missing) just yields null.
async function optional(promise) {
  try { return await promise; } catch { return null; }
}

// Free plans cap `limit`; ask for ten years, fall back to five.
async function statements(path, symbol, period, apiKey, f) {
  try {
    return await get(path, { symbol, period, limit: period === 'annual' ? 10 : 12 }, apiKey, f);
  } catch (e) {
    if (e.status !== 402 && e.status !== 400) throw e;
    return get(path, { symbol, period, limit: 5 }, apiKey, f);
  }
}

const n = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const first = (...vals) => vals.map(n).find(v => v !== null) ?? null;
const pos = v => (v === null ? null : Math.abs(v));

// Merge the three statements for each period into one row.
export function mergeStatements(income, balance, cash) {
  const key = r => r.date;
  const bMap = new Map((balance || []).map(r => [key(r), r]));
  const cMap = new Map((cash || []).map(r => [key(r), r]));
  const rows = (income || []).map(i => {
    const b = bMap.get(key(i)) || {};
    const c = cMap.get(key(i)) || {};
    const capex = pos(n(c.capitalExpenditure));
    const ocf = first(c.operatingCashFlow, c.netCashProvidedByOperatingActivities);
    const netDebt = first(c.netDebtIssuance);
    return {
      date: i.date,
      filingDate: i.filingDate || i.fillingDate || null,
      fiscalYear: Number(i.fiscalYear || i.calendarYear || String(i.date).slice(0, 4)),
      period: i.period,
      revenue: n(i.revenue),
      grossProfit: n(i.grossProfit),
      operatingIncome: n(i.operatingIncome),
      netIncome: first(i.netIncome, i.bottomLineNetIncome),
      eps: first(i.epsDiluted, i.epsdiluted, i.eps),
      sharesDiluted: first(i.weightedAverageShsOutDil, i.weightedAverageShsOut),
      interestExpense: pos(n(i.interestExpense)),
      incomeTaxExpense: n(i.incomeTaxExpense),
      incomeBeforeTax: n(i.incomeBeforeTax),
      cashAndInvestments: first(b.cashAndShortTermInvestments,
        n(b.cashAndCashEquivalents) !== null ? n(b.cashAndCashEquivalents) + (n(b.shortTermInvestments) || 0) : null),
      totalDebt: first(b.totalDebt),
      equity: first(b.totalStockholdersEquity, b.totalEquity),
      operatingCashFlow: ocf,
      capex,
      freeCashFlow: first(c.freeCashFlow, ocf !== null && capex !== null ? ocf - capex : null),
      dividendsPaid: pos(first(c.commonDividendsPaid, c.netDividendsPaid, c.dividendsPaid)) ?? 0,
      buybacks: pos(first(c.commonStockRepurchased)) ?? 0,
      debtPaydown: netDebt !== null && netDebt < 0 ? -netDebt : 0,
    };
  });
  return rows.filter(r => r.revenue !== null).sort((a, b) => a.date.localeCompare(b.date));
}

function segmentsFrom(rows) {
  if (!rows || !rows.length) return null;
  const sorted = [...rows].sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const cur = sorted[0]?.data, prev = sorted[1]?.data || {};
  if (!cur || typeof cur !== 'object') return null;
  const items = Object.entries(cur)
    .filter(([, v]) => typeof v === 'number' && v > 0)
    .map(([name, value]) => ({ name, value, prevValue: typeof prev[name] === 'number' ? prev[name] : null }))
    .sort((a, b) => b.value - a.value);
  return items.length ? { date: sorted[0].date, items } : null;
}

export async function fetchCompany(symbol, apiKey, fetchImpl = globalThis.fetch.bind(globalThis)) {
  if (!apiKey) throw new ProviderError('Add a Financial Modeling Prep API key in Settings to analyze real stocks.', 401);
  const sym = symbol.trim().toUpperCase();
  const from = new Date(Date.now() - 5.2 * 365.25 * 86400000).toISOString().slice(0, 10);
  const f = fetchImpl;

  const [profile, incA, balA, cfA, prices, incQ, balQ, cfQ, earnings, seg, geo] = await Promise.all([
    get('profile', { symbol: sym }, apiKey, f),
    statements('income-statement', sym, 'annual', apiKey, f),
    statements('balance-sheet-statement', sym, 'annual', apiKey, f),
    statements('cash-flow-statement', sym, 'annual', apiKey, f),
    get('historical-price-eod/light', { symbol: sym, from }, apiKey, f),
    optional(get('income-statement', { symbol: sym, period: 'quarter', limit: 12 }, apiKey, f)),
    optional(get('balance-sheet-statement', { symbol: sym, period: 'quarter', limit: 12 }, apiKey, f)),
    optional(get('cash-flow-statement', { symbol: sym, period: 'quarter', limit: 12 }, apiKey, f)),
    optional(get('earnings', { symbol: sym }, apiKey, f)),
    optional(get('revenue-product-segmentation', { symbol: sym, period: 'annual', structure: 'flat' }, apiKey, f)),
    optional(get('revenue-geographic-segmentation', { symbol: sym, period: 'annual', structure: 'flat' }, apiKey, f)),
  ]);

  const p = profile[0];
  if (!p) throw new ProviderError(`No company found for “${sym}”.`, 404);
  const annual = mergeStatements(incA, balA, cfA);
  if (!annual.length) throw new ProviderError(`No financial statements available for ${sym}.`, 404);
  const quarterly = incQ && balQ && cfQ ? mergeStatements(incQ, balQ, cfQ) : [];

  const series = (prices || [])
    .map(r => ({ date: r.date, close: first(r.price, r.close, r.adjClose) }))
    .filter(r => r.close !== null && r.date)
    .sort((a, b) => a.date.localeCompare(b.date));

  const today = new Date().toISOString().slice(0, 10);
  const reported = (earnings || [])
    .filter(e => e.date <= today && (n(e.epsActual) !== null || n(e.revenueActual) !== null))
    .map(e => ({
      date: e.date,
      epsActual: n(e.epsActual), epsEstimated: n(e.epsEstimated),
      revenueActual: n(e.revenueActual), revenueEstimated: n(e.revenueEstimated),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return {
    symbol: p.symbol || sym,
    name: p.companyName || sym,
    currency: p.currency || 'USD',
    price: first(p.price, series.length ? series[series.length - 1].close : null),
    marketCap: first(p.marketCap, p.mktCap),
    sector: p.sector || '',
    industry: p.industry || '',
    country: p.country || '',
    ceo: p.ceo || '',
    website: p.website || '',
    image: p.image || '',
    employees: Number(p.fullTimeEmployees) || null,
    ipoDate: p.ipoDate || '',
    description: p.description || '',
    annual,
    quarterly: quarterly.length >= 4 ? quarterly : [],
    prices: series,
    earnings: reported,
    segments: segmentsFrom(seg),
    geography: segmentsFrom(geo),
    asOf: today,
  };
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyze, cagr, ltm, yearlyPoints, growthRate, multipleHistory, verdictFor, roic,
} from '../js/analysis.js';
import { demoCompany, demoQualitative } from '../js/providers/demo.js';
import { fetchCompany, mergeStatements, ProviderError } from '../js/providers/fmp.js';
import { toAnswers } from '../js/ai.js';

const inRange = v => Number.isInteger(v) && v >= 1 && v <= 5;

test('cagr handles growth, decline and invalid inputs', () => {
  assert.ok(Math.abs(cagr(100, 121, 2) - 0.1) < 1e-9);
  assert.ok(cagr(100, 81, 2) < 0);
  assert.equal(cagr(-5, 10, 3), null);
  assert.equal(cagr(10, 0, 3), null);
  assert.equal(cagr(10, 20, 0), null);
});

test('ltm sums the last four quarters when they are newer than the annual report', () => {
  const c = demoCompany();
  const l = ltm(c);
  const q = c.quarterly.slice(-4);
  const expected = q.reduce((s, x) => s + x.revenue, 0);
  assert.ok(Math.abs(l.revenue - expected) < 1);
  assert.equal(l.date, q[3].date);
  assert.equal(l.cashAndInvestments, q[3].cashAndInvestments);
});

test('ltm falls back to the latest annual report without quarters', () => {
  const c = { ...demoCompany(), quarterly: [] };
  assert.equal(ltm(c).revenue, c.annual.at(-1).revenue);
  assert.equal(yearlyPoints(c).length, c.annual.length);
});

test('growth rates use the point closest to N years back', () => {
  const pts = [2016, 2017, 2018, 2019].map((y, i) => ({ date: `${y}-12-31`, revenue: 100 * 1.1 ** i }));
  assert.ok(Math.abs(growthRate(pts, 'revenue', 3) - 0.1) < 1e-3);
  assert.ok(Math.abs(growthRate(pts, 'revenue', 1) - 0.1) < 1e-3);
  assert.equal(growthRate(pts, 'revenue', 10), null);
});

test('roic uses the effective tax rate and skips non-positive invested capital', () => {
  const row = { operatingIncome: 100, incomeTaxExpense: 20, incomeBeforeTax: 100, equity: 400, totalDebt: 200, cashAndInvestments: 100 };
  assert.ok(Math.abs(roic(row) - 0.16) < 1e-9);
  assert.equal(roic({ ...row, equity: 0, totalDebt: 0 }), null);
});

test('multiple history leaves gaps where the per-share figure is negative', () => {
  const c = {
    annual: [
      { date: '2020-12-31', filingDate: '2021-02-01', netIncome: -10, sharesDiluted: 10 },
      { date: '2021-12-31', filingDate: '2022-02-01', netIncome: 20, sharesDiluted: 10 },
    ],
    quarterly: [],
    prices: [{ date: '2021-01-15', close: 50 }, { date: '2021-06-01', close: 40 }, { date: '2022-03-01', close: 30 }],
  };
  const h = multipleHistory(c, 'netIncome');
  assert.equal(h.length, 2); // first price predates any filing
  assert.equal(h[0].multiple, null);
  assert.equal(h[1].multiple, 15);
});

test('demo analysis produces a complete report with scores in range', () => {
  const r = analyze(demoCompany());
  for (const v of [r.business.score, r.moat.width, r.moat.direction, r.growth.score, r.management.score, r.risk.score, r.valuation.score]) {
    assert.ok(inRange(v), `score ${v} out of range`);
  }
  assert.equal(r.phase.phase, 4);
  assert.equal(r.valuation.key, 'pe');
  assert.ok(r.quality >= 1 && r.quality <= 5);
  assert.ok(['Sell', 'Pass', 'Hold', 'Watch', 'Buy'].includes(r.verdict.call));
  assert.ok(r.valuation.prices.cheap < r.valuation.prices.fair && r.valuation.prices.fair < r.valuation.prices.expensive);
  assert.ok(r.valuation.peakWarning, 'demo LTM margins are far above normal and should warn');
  // Without AI or overrides, judgement-only questions are not assessed.
  assert.equal(r.risk.questions.disruption.source, 'none');
  assert.equal(r.business.questions.predictability.source, 'auto');
});

test('user overrides beat AI answers, which beat heuristics', () => {
  const c = demoCompany();
  const ai = demoQualitative().answers;
  const withAi = analyze(c, { ai });
  assert.equal(withAi.business.questions.pricingPower.source, 'ai');
  assert.equal(withAi.business.questions.pricingPower.value, 1);

  const mine = analyze(c, { ai, overrides: { pricingPower: 3, 'moat.networkEffects': { strength: 3, direction: 1 } } });
  assert.equal(mine.business.questions.pricingPower.source, 'you');
  assert.equal(mine.business.questions.pricingPower.value, 3);
  assert.ok(mine.business.score >= withAi.business.score);
  const ne = mine.moat.sources.find(s => s.key === 'networkEffects');
  assert.equal(ne.strength, 3);
  assert.ok(mine.moat.width >= withAi.moat.width);
});

test('verdict combines quality and valuation', () => {
  assert.equal(verdictFor(4.2, 2).call, 'Watch');
  assert.equal(verdictFor(4.2, 2).line, 'Great business, bad valuation.');
  assert.equal(verdictFor(4.2, 3).call, 'Buy');
  assert.equal(verdictFor(3.4, 3).call, 'Hold');
  assert.equal(verdictFor(2.5, 2).call, 'Pass');
  assert.equal(verdictFor(1.8, 1).call, 'Sell');
});

// ---------- FMP adapter ----------

const fmpIncome = [
  { date: '2025-09-30', fiscalYear: '2025', period: 'FY', filingDate: '2025-11-01', revenue: 1000, grossProfit: 600, operatingIncome: 300, netIncome: 240, epsDiluted: 2.4, weightedAverageShsOutDil: 100, interestExpense: 10, incomeTaxExpense: 50, incomeBeforeTax: 290 },
  { date: '2024-09-30', fiscalYear: '2024', period: 'FY', filingDate: '2024-11-01', revenue: 800, grossProfit: 450, operatingIncome: 200, netIncome: 150, epsDiluted: 1.5, weightedAverageShsOutDil: 100, interestExpense: 10, incomeTaxExpense: 40, incomeBeforeTax: 190 },
];
const fmpBalance = [
  { date: '2025-09-30', cashAndShortTermInvestments: 500, totalDebt: 200, totalStockholdersEquity: 900 },
  { date: '2024-09-30', cashAndCashEquivalents: 300, shortTermInvestments: 50, totalDebt: 250, totalStockholdersEquity: 800 },
];
const fmpCash = [
  { date: '2025-09-30', operatingCashFlow: 350, capitalExpenditure: -100, freeCashFlow: 250, commonDividendsPaid: -40, commonStockRepurchased: -60, netDebtIssuance: -50 },
  { date: '2024-09-30', operatingCashFlow: 250, capitalExpenditure: -90, commonDividendsPaid: -30, commonStockRepurchased: 0, netDebtIssuance: 20 },
];

test('mergeStatements maps FMP fields onto the normalized shape, oldest first', () => {
  const rows = mergeStatements(fmpIncome, fmpBalance, fmpCash);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].fiscalYear, 2024);
  assert.equal(rows[0].cashAndInvestments, 350);
  assert.equal(rows[0].freeCashFlow, 160); // derived: 250 - 90
  assert.equal(rows[0].debtPaydown, 0);
  const r = rows[1];
  assert.equal(r.capex, 100);
  assert.equal(r.dividendsPaid, 40);
  assert.equal(r.buybacks, 60);
  assert.equal(r.debtPaydown, 50);
  assert.equal(r.eps, 2.4);
  assert.equal(r.sharesDiluted, 100);
});

function mockFetch(routes) {
  const calls = [];
  const f = async url => {
    const u = new URL(url);
    const path = u.pathname.replace('/stable/', '');
    calls.push(path + (u.searchParams.get('period') ? ':' + u.searchParams.get('period') : ''));
    const route = routes(path, u.searchParams);
    return {
      ok: route.status === 200,
      status: route.status,
      text: async () => JSON.stringify(route.body),
    };
  };
  f.calls = calls;
  return f;
}

test('fetchCompany builds a company and tolerates premium-only endpoints', async () => {
  const f = mockFetch((path, qs) => {
    if (qs.get('period') === 'quarter' || path.startsWith('revenue-') || path === 'earnings') {
      return { status: 402, body: 'Premium Query Parameter: this endpoint needs a paid plan' };
    }
    const body = {
      profile: [{ symbol: 'TEST', companyName: 'Test Co', price: 48, marketCap: 4800, currency: 'USD', ceo: 'A. Person', sector: 'Tech' }],
      'income-statement': fmpIncome,
      'balance-sheet-statement': fmpBalance,
      'cash-flow-statement': fmpCash,
      'historical-price-eod/light': [{ symbol: 'TEST', date: '2025-12-01', price: 48, volume: 1 }, { symbol: 'TEST', date: '2025-11-03', price: 40, volume: 1 }],
    }[path];
    return { status: 200, body };
  });
  const c = await fetchCompany('test', 'key', f);
  assert.equal(c.symbol, 'TEST');
  assert.equal(c.annual.length, 2);
  assert.deepEqual(c.quarterly, []);
  assert.equal(c.segments, null);
  assert.deepEqual(c.prices.map(p => p.date), ['2025-11-03', '2025-12-01']);
  const r = analyze(c);
  assert.equal(r.overview.valuation.pe, 20);
  assert.ok(Math.abs(r.growth.rev.y1 - 0.25) < 1e-3);
});

test('fetchCompany retries statements with a smaller limit on free plans', async () => {
  const f = mockFetch((path, qs) => {
    if (['income-statement', 'balance-sheet-statement', 'cash-flow-statement'].includes(path) && qs.get('limit') === '10') {
      return { status: 402, body: { 'Error Message': 'Premium' } };
    }
    if (qs.get('period') === 'quarter' || path.startsWith('revenue-') || path === 'earnings') return { status: 402, body: 'Premium' };
    const body = {
      profile: [{ symbol: 'TEST', companyName: 'Test Co', price: 48 }],
      'income-statement': fmpIncome, 'balance-sheet-statement': fmpBalance, 'cash-flow-statement': fmpCash,
      'historical-price-eod/light': [],
    }[path];
    return { status: 200, body };
  });
  const c = await fetchCompany('TEST', 'key', f);
  assert.equal(c.annual.length, 2);
});

test('fetchCompany explains bad keys and missing keys', async () => {
  const f = mockFetch(() => ({ status: 401, body: { 'Error Message': 'Invalid API KEY.' } }));
  await assert.rejects(fetchCompany('TEST', 'bad', f), e => e instanceof ProviderError && /rejected/.test(e.message));
  await assert.rejects(fetchCompany('TEST', '', f), e => e.status === 401 && /API key/.test(e.message));
});

// ---------- AI answer mapping ----------

test('toAnswers converts the AI schema into analysis inputs', () => {
  const t = (value, note = 'n') => ({ value, note });
  const m = (strength, direction) => ({ strength, direction, note: 'x' });
  const a = toAnswers({
    predictability: t(3), pricingPower: t(2), recession: t(3), competitive: t(3),
    switchingCosts: m(3, 1), networkEffects: m(0, 0), intangibles: m(2, 0), lowCost: m(0, 0), counterPositioning: m(1, -1),
    industryGrowing: t(3), newOfferings: t(2), founderInvolved: t(true), ceoName: t('Pat Lee'),
    ceoTenureYears: t(12), ceoOwnershipPercent: t(2.5), employeeRating: t(4.1),
    diversification: t(3), disruption: t(2), outsideControl: t(3),
  });
  assert.deepEqual(a['moat.switchingCosts'].value, { strength: 3, direction: 1 });
  assert.equal(a.ceoOwnership.value, 0.025);
  const r = analyze(demoCompany(), { ai: a });
  assert.equal(r.management.founder.value, true);
  assert.equal(r.risk.questions.disruption.source, 'ai');
  assert.ok(r.moat.width >= 3);
});

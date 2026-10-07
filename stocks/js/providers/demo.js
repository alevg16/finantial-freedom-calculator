// A fictional company with generated, deterministic numbers. It lets the app
// run with no API key and gives the tests a stable fixture. Nothing here
// describes a real business.

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let x = Math.imul(s ^ (s >>> 15), 1 | s);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

const iso = d => d.toISOString().slice(0, 10);
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);

// Yearly demand cycle for a memory-chip style business: boom, bust, boom.
const CYCLE = { 2016: 0.85, 2017: 1.15, 2018: 1.35, 2019: 0.95, 2020: 1.0, 2021: 1.2, 2022: 1.25, 2023: 0.62, 2024: 0.9, 2025: 1.25, 2026: 2.1 };

export function demoCompany() {
  const rand = rng(42);
  const quarters = [];
  let cash = 6e9, debt = 9e9, equity = 30e9, shares = 1.13e9;

  for (let y = 2016; y <= 2026; y++) {
    for (let qn = 1; qn <= 4; qn++) {
      const end = new Date(Date.UTC(y, qn * 3, 0));
      if (end > new Date(Date.UTC(2026, 6, 1))) break; // last reported: Q2 2026
      const i = quarters.length;
      const prevC = CYCLE[y - 1] ?? CYCLE[y];
      const c = prevC + (CYCLE[y] - prevC) * (qn / 4) + (rand() - 0.5) * 0.04;
      const base = 2.6e9 * Math.pow(1.025, i);
      const revenue = base * c;
      const gm = Math.max(0.12, Math.min(0.74, 0.22 + 0.42 * (c - 0.7)));
      const opex = 0.2 * base;
      const operatingIncome = revenue * gm - opex;
      const interestExpense = debt * 0.045 / 4;
      const pretax = operatingIncome - interestExpense + cash * 0.03 / 4;
      const tax = pretax > 0 ? pretax * 0.13 : 0;
      const netIncome = pretax - tax;
      const ocf = netIncome + 0.22 * base;
      const capex = 0.24 * base + (c > 1.2 ? 0.1 * revenue : 0);
      const fcf = ocf - capex;
      const dividendsPaid = y >= 2021 ? 0.115 * shares : 0;
      const buybacks = (y === 2021 || y === 2022) && fcf > 0 ? Math.min(fcf * 0.6, 1.2e9) : 0;
      const debtPaydown = y >= 2025 ? Math.min(debt * 0.12, Math.max(0, fcf * 0.3)) : 0;
      shares = shares * (1 + 0.002) - buybacks / 70;
      debt -= debtPaydown;
      cash = Math.max(2e9, cash + fcf - dividendsPaid - buybacks - debtPaydown);
      equity += netIncome - dividendsPaid - buybacks;
      quarters.push({
        date: iso(end), filingDate: iso(addDays(end, 34)), fiscalYear: y, period: 'Q' + qn,
        revenue, grossProfit: revenue * gm, operatingIncome, netIncome, eps: netIncome / shares,
        interestExpense, incomeTaxExpense: tax, incomeBeforeTax: pretax,
        operatingCashFlow: ocf, capex, freeCashFlow: fcf, dividendsPaid, buybacks, debtPaydown,
        cashAndInvestments: cash, totalDebt: debt, equity, sharesDiluted: shares,
      });
    }
  }

  // Annual rows are the sum of their quarters (balance items from Q4).
  const annual = [];
  for (let y = 2016; y <= 2025; y++) {
    const qs = quarters.filter(q => q.fiscalYear === y);
    if (qs.length !== 4) continue;
    const row = { date: qs[3].date, filingDate: iso(addDays(new Date(qs[3].date), 55)), fiscalYear: y, period: 'FY' };
    for (const k of ['revenue', 'grossProfit', 'operatingIncome', 'netIncome', 'eps', 'interestExpense', 'incomeTaxExpense',
      'incomeBeforeTax', 'operatingCashFlow', 'capex', 'freeCashFlow', 'dividendsPaid', 'buybacks', 'debtPaydown']) {
      row[k] = qs.reduce((s, q) => s + q[k], 0);
    }
    for (const k of ['cashAndInvestments', 'totalDebt', 'equity']) row[k] = qs[3][k];
    row.sharesDiluted = qs.reduce((s, q) => s + q.sharesDiluted, 0) / 4;
    annual.push(row);
  }

  // Daily prices: a sales multiple that drifts and mean-reverts, applied to
  // the trailing sales per share known on each day.
  const prices = [];
  let ps = 2.4;
  const start = new Date(Date.UTC(2021, 9, 4)), stop = new Date(Date.UTC(2026, 9, 2));
  for (let d = start; d <= stop; d = addDays(d, 1)) {
    const wd = d.getUTCDay();
    if (wd === 0 || wd === 6) continue;
    const known = quarters.filter(q => new Date(q.filingDate) <= d);
    if (known.length < 4) continue;
    const ttm = known.slice(-4);
    const sps = ttm.reduce((s, q) => s + q.revenue, 0) / ttm[3].sharesDiluted;
    ps += (rand() - 0.5) * 0.09 + (2.6 - ps) * 0.004 + (d.getUTCFullYear() === 2026 ? 0.006 : 0);
    ps = Math.max(1.2, ps);
    prices.push({ date: iso(d), close: Math.round(ps * sps * 100) / 100 });
  }
  const price = prices[prices.length - 1].close;

  const earnings = quarters.slice(-8).map((q, i) => {
    const miss = i === 2;
    const k = miss ? 1.03 : 0.94 - rand() * 0.06;
    return {
      date: q.filingDate,
      revenueActual: q.revenue, revenueEstimated: q.revenue * (miss ? 1.01 : 0.97 - rand() * 0.03),
      epsActual: q.eps, epsEstimated: q.eps * k,
    };
  });

  const lastFy = annual[annual.length - 1], prevFy = annual[annual.length - 2];
  const split = (total, prevTotal, parts) => parts.map(([name, share, prevShare]) => ({
    name, value: total * share, prevValue: prevTotal * prevShare,
  }));

  return {
    demo: true,
    symbol: 'DEMO',
    name: 'Northwind Memory',
    currency: 'USD',
    price,
    marketCap: price * quarters[quarters.length - 1].sharesDiluted,
    sector: 'Technology',
    industry: 'Semiconductors',
    country: 'US',
    ceo: 'Jordan Avery',
    website: '',
    image: '',
    employees: 41000,
    ipoDate: '1989-05-01',
    description: 'Northwind Memory is a fictional company used to demonstrate the app. It designs and manufactures memory and storage chips for data centers, phones, PCs and cars.',
    annual,
    quarterly: quarters.slice(-12),
    prices,
    earnings,
    segments: {
      date: lastFy.date,
      items: split(lastFy.revenue, prevFy.revenue, [
        ['Cloud Memory', 0.36, 0.3], ['Mobile & Client', 0.32, 0.36], ['Core Data Center', 0.19, 0.2], ['Automotive & Embedded', 0.13, 0.14],
      ]),
    },
    geography: {
      date: lastFy.date,
      items: split(lastFy.revenue, prevFy.revenue, [
        ['United States', 0.47, 0.44], ['Taiwan', 0.18, 0.19], ['Mainland China', 0.12, 0.14], ['Other Asia Pacific', 0.13, 0.13], ['Europe', 0.1, 0.1],
      ]),
    },
    asOf: '2026-10-02',
  };
}

// A canned qualitative assessment in the same shape the AI returns, so the
// demo shows every card filled in.
export function demoQualitative() {
  return {
    model: 'demo',
    createdAt: '2026-10-02T00:00:00Z',
    text: {
      mission: 'Make memory faster, denser and cheaper for every device that computes.',
      whatItDoes: 'Northwind makes the memory and storage chips that hold data inside data centers, phones, PCs and cars.',
      howItMakesMoney: 'It owns its fabs and sells chips at prices set by industry supply and demand, earning its margin by shrinking chips faster than prices fall.',
      customers: 'Companies building computing hardware — increasingly the ones building AI infrastructure.',
      whyBuy: 'Qualifying a memory part into a platform takes real engineering work, so switching isn\'t free, but several rivals can second-source.',
      summary: 'A strong operator in a cyclical commodity market; returns swing with memory prices.',
    },
    answers: {
      predictability: { value: 1, note: 'Memory prices follow an industry cycle the company doesn\'t control, so revenue swings sharply year to year.' },
      pricingPower: { value: 1, note: 'A price taker: rivals sell substitutable parts and new industry supply pushes prices down.' },
      recession: { value: 1, note: 'Demand depends on cloud capex and device cycles; downturns hit revenue and margins hard.' },
      competitive: { value: 2, note: 'A top-tier maker with leading-edge parts, but returns on capital sit near the peer median.' },
      'moat.switchingCosts': { value: { strength: 2, direction: 1 }, note: 'Qualification work makes leaving costly, more so for custom AI memory.' },
      'moat.networkEffects': { value: { strength: 0, direction: 0 }, note: '' },
      'moat.intangibles': { value: { strength: 1, direction: 0 }, note: 'A large patent portfolio, but rivals hold comparable ones.' },
      'moat.lowCost': { value: { strength: 0, direction: 0 }, note: '' },
      'moat.counterPositioning': { value: { strength: 0, direction: 0 }, note: '' },
      industryGrowing: { value: 3, note: 'AI servers need far more memory per system.' },
      newOfferings: { value: 2, note: 'Custom high-bandwidth memory is an opening; most products are incremental.' },
      founder: { value: false, note: 'No founder is still involved in running the company.' },
      ceoTenure: { value: 7, note: '' },
      ceoOwnership: { value: 0.0003, note: '' },
      diversification: { value: 2, note: 'One unnamed customer is about 15% of revenue.' },
      disruption: { value: 2, note: 'New memory technologies could matter in time; none is displacing current chips yet.' },
      outsideControl: { value: 1, note: 'Prices are set by the market, most revenue is earned abroad, and export controls apply.' },
    },
  };
}

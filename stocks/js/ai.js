// Optional qualitative assessment by Claude: moat sources, disruption risk,
// customer concentration and the other questions financial statements can't
// answer. Runs in the browser with the user's own Anthropic API key, which is
// stored only in this browser's localStorage.

import { fmtMoney, fmtPct, fmtSigned } from './charts.js';

const SDK_URL = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.131.0/+esm';

export const MODELS = [
  ['claude-opus-5-5', 'Claude Opus 5.5 (best)'],
  ['claude-sonnet-5-5', 'Claude Sonnet 5.5 (cheaper)'],
];

const triple = desc => ({
  type: 'object',
  description: desc,
  properties: { value: { type: 'integer', enum: [1, 2, 3] }, note: { type: 'string' } },
  required: ['value', 'note'],
  additionalProperties: false,
});
const moatSource = desc => ({
  type: 'object',
  description: desc,
  properties: {
    strength: { type: 'integer', enum: [0, 1, 2, 3], description: '0 none, 1 weak, 2 moderate, 3 strong' },
    direction: { type: 'integer', enum: [-1, 0, 1], description: '-1 narrowing, 0 stable, 1 widening' },
    note: { type: 'string' },
  },
  required: ['strength', 'direction', 'note'],
  additionalProperties: false,
});
const nullableNumber = desc => ({
  type: 'object',
  description: desc,
  properties: { value: { anyOf: [{ type: 'number' }, { type: 'null' }] }, note: { type: 'string' } },
  required: ['value', 'note'],
  additionalProperties: false,
});
const str = description => ({ type: 'string', description });

const SCHEMA = {
  type: 'object',
  properties: {
    text: {
      type: 'object',
      properties: {
        mission: str('The company mission in one sentence, close to its own wording.'),
        whatItDoes: str('What the company does, in one plain-English sentence.'),
        howItMakesMoney: str('How it makes money: the business model in one or two sentences.'),
        customers: str('Who the customers are, one sentence.'),
        whyBuy: str('Why customers buy from this company rather than a rival, one or two sentences.'),
        summary: str('One-sentence overall take on the business quality (not the stock price).'),
      },
      required: ['mission', 'whatItDoes', 'howItMakesMoney', 'customers', 'whyBuy', 'summary'],
      additionalProperties: false,
    },
    predictability: triple('How predictable is revenue? 1 unpredictable, 2 modest, 3 predictable (recurring, contracted).'),
    pricingPower: triple('Can the company raise prices? 1 no (price taker), 2 sometimes, 3 easily.'),
    recession: triple('How recession-proof is it? 1 weak, 2 okay, 3 strong.'),
    competitive: triple('Competitive position: 1 weak, 2 average, 3 dominant.'),
    switchingCosts: moatSource('Switching costs moat.'),
    networkEffects: moatSource('Network effects moat.'),
    intangibles: moatSource('Intangible assets moat: brands, patents, licenses, regulatory permits.'),
    lowCost: moatSource('Low-cost production / scale advantage moat.'),
    counterPositioning: moatSource('Counter-positioning moat: a business model incumbents cannot copy without hurting themselves.'),
    industryGrowing: triple('Is the industry growing? 1 no, 2 slowly, 3 yes.'),
    newOfferings: triple('Room for new offerings or markets? 1 unlikely, 2 possible, 3 clear and underway.'),
    founderInvolved: {
      type: 'object',
      properties: { value: { type: 'boolean' }, note: { type: 'string' } },
      required: ['value', 'note'],
      additionalProperties: false,
    },
    ceoName: { type: 'object', properties: { value: { type: 'string' }, note: { type: 'string' } }, required: ['value', 'note'], additionalProperties: false },
    ceoTenureYears: nullableNumber('Years the current CEO has been in the role, or null if unknown.'),
    ceoOwnershipPercent: nullableNumber('Percent of shares outstanding the CEO owns, e.g. 0.02 for 0.02%, or null if unknown.'),
    employeeRating: nullableNumber('Typical employee review-site rating out of 5, or null if unknown.'),
    diversification: triple('How diversified are revenues across customers? 1 concentrated (a customer >20%), 2 moderate (a customer 10-20%), 3 diversified.'),
    disruption: triple('Is disruption a threat? 1 yes, 2 some risk, 3 no.'),
    outsideControl: triple('How much of the business is outside management control (commodity prices, regulation, geopolitics)? 1 a lot, 2 some, 3 very little.'),
  },
  required: ['text', 'predictability', 'pricingPower', 'recession', 'competitive', 'switchingCosts', 'networkEffects', 'intangibles',
    'lowCost', 'counterPositioning', 'industryGrowing', 'newOfferings', 'founderInvolved', 'ceoName', 'ceoTenureYears',
    'ceoOwnershipPercent', 'employeeRating', 'diversification', 'disruption', 'outsideControl'],
  additionalProperties: false,
};

const SYSTEM = `You are a long-term equity analyst who writes for everyday investors. You assess business quality, not the share price.

Answer every question in the schema for the company described. Ground answers in facts: the latest annual report (10-K or equivalent), recent earnings calls, and the financial figures provided. When the web search tool is available, use it to check current facts such as customer concentration, the CEO's tenure and ownership, and regulatory or export issues.

Each "note" is one or two plain sentences (under 45 words) giving the concrete fact behind the rating: a number, a named rival, a named risk. No hedging filler. Be willing to give low ratings; most businesses do not have strong moats. If something is genuinely unknown, say so in the note and pick the middle option (or null where allowed).`;

function factSheet(company, report) {
  const l = report.ltm || {};
  const g = report.growth;
  const cur = '$';
  const lines = [
    `Company: ${company.name} (${company.symbol})`,
    `Sector / industry: ${company.sector || '?'} / ${company.industry || '?'}; country ${company.country || '?'}`,
    `CEO on file: ${company.ceo || 'unknown'}; employees ${company.employees || '?'}; IPO ${company.ipoDate || '?'}`,
    `Description: ${(company.description || '').slice(0, 1500)}`,
    '',
    `Latest twelve months (to ${l.date || '?'}): revenue ${fmtMoney(l.revenue, cur)}, gross margin ${fmtPct(report.overview.profitability.gross)}, operating margin ${fmtPct(report.overview.profitability.operating)}, net income ${fmtMoney(l.netIncome, cur)}, free cash flow ${fmtMoney(l.freeCashFlow, cur)}.`,
    `Revenue growth: 1y ${fmtSigned(g.rev.y1)}, 3y CAGR ${fmtSigned(g.rev.y3)}, 5y CAGR ${fmtSigned(g.rev.y5)}.`,
    `Annual revenue / operating income: ${(company.annual || []).map(a => `FY${a.fiscalYear} ${fmtMoney(a.revenue, cur)} / ${fmtMoney(a.operatingIncome, cur)}`).join('; ')}`,
    `Return on invested capital by year: ${report.roics.map((r, i) => `FY${company.annual[i].fiscalYear} ${fmtPct(r)}`).join(', ')}`,
    `Cash & investments ${fmtMoney(l.cashAndInvestments, cur)}, total debt ${fmtMoney(l.totalDebt, cur)}.`,
  ];
  if (company.segments?.items?.length) lines.push(`Segments: ${company.segments.items.map(s => `${s.name} ${fmtMoney(s.value, cur)}`).join('; ')}`);
  if (company.geography?.items?.length) lines.push(`Regions: ${company.geography.items.map(s => `${s.name} ${fmtMoney(s.value, cur)}`).join('; ')}`);
  return lines.join('\n');
}

// Pull the JSON answer out of the final text, after any search results.
function finalJson(content) {
  let lastTool = -1;
  content.forEach((b, i) => { if (b.type !== 'text') lastTool = i; });
  const text = content.slice(lastTool + 1).filter(b => b.type === 'text').map(b => b.text).join('')
    || content.filter(b => b.type === 'text').map(b => b.text).pop() || '';
  try { return JSON.parse(text); } catch { /* fall through */ }
  const a = text.indexOf('{'), z = text.lastIndexOf('}');
  if (a >= 0 && z > a) return JSON.parse(text.slice(a, z + 1));
  throw new Error('Claude did not return an assessment. Try again.');
}

// Convert the schema answer into the key → {value, note} map analysis.js reads.
export function toAnswers(r) {
  const out = {};
  for (const k of ['predictability', 'pricingPower', 'recession', 'competitive', 'industryGrowing', 'newOfferings',
    'diversification', 'disruption', 'outsideControl']) out[k] = r[k];
  for (const k of ['switchingCosts', 'networkEffects', 'intangibles', 'lowCost', 'counterPositioning']) {
    const m = r[k];
    if (m) out['moat.' + k] = { value: { strength: m.strength, direction: m.direction }, note: m.note };
  }
  out.founder = r.founderInvolved;
  out.ceoName = r.ceoName;
  out.ceoTenure = r.ceoTenureYears;
  out.ceoOwnership = r.ceoOwnershipPercent && typeof r.ceoOwnershipPercent.value === 'number'
    ? { value: r.ceoOwnershipPercent.value / 100, note: r.ceoOwnershipPercent.note } : r.ceoOwnershipPercent;
  out.employeeRating = r.employeeRating;
  return out;
}

export async function assess(company, report, { apiKey, model = MODELS[0][0], webSearch = true, onStatus = () => {} }) {
  if (!apiKey) throw new Error('Add your Anthropic API key in Settings to run the AI assessment.');
  onStatus('Loading the Claude SDK…');
  const { default: Anthropic } = await import(SDK_URL);
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });

  const messages = [{
    role: 'user',
    content: `Assess this business.\n\n${factSheet(company, report)}`,
  }];
  const params = {
    model,
    max_tokens: 16000,
    system: SYSTEM,
    messages,
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
    // Re-run a declined request on Anthropic's recommended fallback model.
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
  };
  if (webSearch) params.tools = [{ type: 'web_search_20260209', name: 'web_search', max_uses: 6 }];

  onStatus(webSearch ? 'Claude is reading up on the company (this can take a minute)…' : 'Claude is assessing the company…');
  let res;
  try {
    res = await client.beta.messages.create(params);
    // Server-side tool loops can pause; resend to let them finish.
    for (let i = 0; res.stop_reason === 'pause_turn' && i < 4; i++) {
      messages.push({ role: 'assistant', content: res.content });
      res = await client.beta.messages.create({ ...params, messages });
    }
  } catch (e) {
    const status = e?.status;
    if (status === 401) throw new Error('Your Anthropic API key was rejected. Check it in Settings.');
    if (status === 429) throw new Error('Anthropic rate limit hit. Wait a minute and try again.');
    if (status === 529 || status >= 500) throw new Error('The Claude API is busy right now. Try again shortly.');
    throw new Error(e?.error?.error?.message || e?.message || 'The AI request failed.');
  }
  if (res.stop_reason === 'refusal') throw new Error('Claude declined to assess this company.');
  if (res.stop_reason === 'max_tokens') throw new Error('The assessment was cut off. Try again, or turn off web search.');

  const raw = finalJson(res.content);
  return {
    model: res.model || model,
    createdAt: new Date().toISOString(),
    text: raw.text,
    answers: toAnswers(raw),
  };
}

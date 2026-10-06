// SVG and HTML chart builders. Each returns a markup string; colors come from
// CSS custom properties so light and dark themes swap in one place.
// Every label that can come from an API goes through esc().

import { isNum } from './analysis.js';

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function fmtMoney(v, cur = '$') {
  if (!isNum(v)) return '—';
  const a = Math.abs(v), s = v < 0 ? '-' : '';
  if (a >= 1e12) return `${s}${cur}${(a / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `${s}${cur}${(a / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${s}${cur}${(a / 1e6).toFixed(0)}M`;
  if (a >= 1e3) return `${s}${cur}${Math.round(a).toLocaleString('en-US')}`;
  return `${s}${cur}${a.toFixed(2)}`;
}
export const fmtPct = (v, d = 1) => (isNum(v) ? `${(v * 100).toFixed(d)}%` : '—');
export const fmtSigned = (v, d = 1) => (isNum(v) ? `${v >= 0 ? '+' : ''}${(v * 100).toFixed(d)}%` : '—');
export const fmtX = v => (isNum(v) ? `${v.toFixed(1)}×` : '—');
export const fmtPrice = (v, cur = '$') => (isNum(v) ? `${cur}${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—');

// Charts draw in real pixels so text stays readable on phones: the app sets
// this to the card's inner width before rendering.
let CW = 640;
export const setChartWidth = w => { CW = Math.max(280, Math.min(860, Math.round(w))); };

const niceStep = raw => {
  if (!(raw > 0)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  return [1, 2, 2.5, 5, 10].map(m => m * p).find(m => m >= raw);
};


// ---------- score widgets ----------

// Five short bars, `score` of them filled. Color tracks the score.
export function meter(score) {
  const tone = score >= 4 ? 'good' : score === 3 ? 'mid' : 'bad';
  let s = `<span class="meter ${tone}" role="img" aria-label="${score} out of 5">`;
  for (let i = 1; i <= 5; i++) s += `<i class="${i <= score ? 'on' : ''}"></i>`;
  return s + '</span>';
}

// Numbered 1-5 track with the current step highlighted and named.
export function stepper(score, labels) {
  const tone = score >= 4 ? 'good' : score === 3 ? 'mid' : 'bad';
  let s = `<ol class="stepper ${tone}" aria-label="${esc(labels[score - 1])}, ${score} of 5">`;
  labels.forEach((l, i) => {
    s += `<li class="${i + 1 === score ? 'cur' : ''}"><span class="dot">${i + 1}</span><span class="lbl">${esc(l)}</span></li>`;
  });
  return s + '</ol>';
}

// ---------- line charts ----------

// Shared line-chart frame. `series` = [{key, color, values:[...]}] aligned to
// `labels`; values may contain nulls (gaps). Returns {svg, geometry}.
function lineFrame({ labels, series, height = 240, yFmt, zones = [], refs = [], rightLabels = [], hover, yCap = null }) {
  const W = CW, H = height, mL = 48, mR = rightLabels.length ? 86 : 12, mT = 14, mB = 28;
  const pW = W - mL - mR, pH = H - mT - mB;
  const all = series.flatMap(s => s.values).concat(zones.flatMap(z => [z.from, z.to]), refs.map(r => r.value)).filter(isNum);
  let lo = Math.min(0, ...all), hi = Math.max(...all);
  if (isNum(yCap) && hi > yCap) hi = yCap;
  if (!isNum(hi) || hi === lo) hi = lo + 1;
  // Round the axis to a clean step so ticks read 0 / 10 / 20, not 13 / 25 / 38.
  const tickStep = niceStep((hi * 1.04 - lo) / 4);
  hi = Math.ceil((hi * 1.04) / tickStep) * tickStep;
  lo = Math.floor(lo / tickStep) * tickStep;
  const ticks = Math.round((hi - lo) / tickStep);
  const n = labels.length;
  const X = i => mL + (n <= 1 ? pW / 2 : (i / (n - 1)) * pW);
  const Y = v => mT + (1 - (v - lo) / (hi - lo)) * pH;

  let s = `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img">`;
  for (const z of zones) {
    const y1 = Y(Math.min(hi, z.to ?? hi)), y2 = Y(Math.max(lo, z.from ?? lo));
    if (y2 > y1) s += `<rect x="${mL}" y="${y1}" width="${pW}" height="${y2 - y1}" fill="var(${z.color})"/>`;
  }
  for (let i = 0; i <= ticks; i++) {
    const v = lo + tickStep * i, y = Y(v);
    s += `<line x1="${mL}" x2="${mL + pW}" y1="${y}" y2="${y}" class="grid"/>`;
    s += `<text x="${mL - 8}" y="${y + 4}" text-anchor="end" class="tick">${esc(yFmt(v))}</text>`;
  }
  if (lo < 0) s += `<line x1="${mL}" x2="${mL + pW}" y1="${Y(0)}" y2="${Y(0)}" class="axis"/>`;
  const step = Math.max(1, Math.ceil(n / Math.max(3, Math.floor(pW / 80))));
  labels.forEach((l, i) => {
    if (i % step === 0 || i === n - 1) {
      const anchor = i === 0 && n > 6 ? 'start' : i === n - 1 && n > 6 ? 'end' : 'middle';
      s += `<text x="${X(i)}" y="${H - 8}" text-anchor="${anchor}" class="tick">${esc(l)}</text>`;
    }
  });
  for (const r of refs) {
    s += `<line x1="${mL}" x2="${mL + pW}" y1="${Y(r.value)}" y2="${Y(r.value)}" class="ref"/>`;
  }
  const clip = 'c' + Math.random().toString(36).slice(2, 8);
  s += `<clipPath id="${clip}"><rect x="${mL - 6}" y="${mT - 6}" width="${pW + 12}" height="${pH + 12}"/></clipPath><g clip-path="url(#${clip})">`;
  for (const se of series) {
    let d = '', pen = false;
    se.values.forEach((v, i) => {
      if (!isNum(v)) { pen = false; return; }
      d += `${pen ? 'L' : 'M'}${X(i).toFixed(1)} ${Y(v).toFixed(1)}`;
      pen = true;
    });
    s += `<path d="${d}" fill="none" stroke="var(${se.color})" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    const lastI = se.values.map((v, i) => (isNum(v) ? i : -1)).filter(i => i >= 0).pop();
    if (lastI !== undefined && se.endDot !== false) {
      s += `<circle cx="${X(lastI)}" cy="${Y(se.values[lastI])}" r="4.5" fill="var(${se.color})" stroke="var(--card)" stroke-width="2"/>`;
    }
    if (se.markers) {
      se.values.forEach((v, i) => {
        if (isNum(v) && i !== lastI) s += `<circle cx="${X(i)}" cy="${Y(v)}" r="4" fill="var(${se.color})" stroke="var(--card)" stroke-width="2"/>`;
      });
    }
  }
  s += '</g>';
  for (const r of rightLabels) {
    if (!isNum(r.value)) continue;
    const y = Math.max(mT + 8, Math.min(mT + pH - 4, Y(r.value)));
    s += `<text x="${mL + pW + 8}" y="${y}" class="rl-main">${esc(r.main)}</text>`;
    s += `<text x="${mL + pW + 8}" y="${y + 13}" class="rl-sub">${esc(r.sub)}</text>`;
  }
  // Hover layer: crosshair + tooltip, wired up by attachHover().
  if (hover) {
    s += `<line class="xhair" x1="0" x2="0" y1="${mT}" y2="${mT + pH}" visibility="hidden"/>`;
    s += `<rect class="hit" x="${mL}" y="${mT}" width="${pW}" height="${pH}" fill="transparent" data-n="${n}" data-ml="${mL}" data-pw="${pW}"/>`;
  }
  s += '</svg>';
  return s;
}

// Wire crosshair tooltips onto every chart inside `root`. Each chart's rows
// live in a <script type="application/json"> sibling so the SVG stays clean.
export function attachHover(root) {
  root.querySelectorAll('.chart-wrap[data-hover]').forEach(wrap => {
    const svg = wrap.querySelector('svg');
    const hit = svg?.querySelector('.hit');
    const data = JSON.parse(wrap.querySelector('script[type="application/json"]')?.textContent || '[]');
    if (!hit || !data.length) return;
    const xh = svg.querySelector('.xhair');
    const tip = document.createElement('div');
    tip.className = 'tip';
    tip.hidden = true;
    wrap.appendChild(tip);
    const n = +hit.dataset.n, mL = +hit.dataset.ml, pW = +hit.dataset.pw, W = svg.viewBox.baseVal.width;
    const show = ev => {
      const box = svg.getBoundingClientRect();
      const sx = ((ev.clientX - box.left) / box.width) * W;
      const i = Math.max(0, Math.min(n - 1, Math.round(((sx - mL) / pW) * (n - 1))));
      const x = mL + (n <= 1 ? pW / 2 : (i / (n - 1)) * pW);
      xh.setAttribute('x1', x); xh.setAttribute('x2', x); xh.setAttribute('visibility', 'visible');
      const row = data[i];
      tip.replaceChildren();
      const head = document.createElement('div');
      head.className = 'tip-h';
      head.textContent = row.label;
      tip.appendChild(head);
      for (const [name, value, color] of row.rows) {
        const line = document.createElement('div');
        line.className = 'tip-r';
        const key = document.createElement('i');
        if (color) key.style.background = `var(${color})`;
        const v = document.createElement('b');
        v.textContent = value;
        const k = document.createElement('span');
        k.textContent = name;
        line.append(key, v, k);
        tip.appendChild(line);
      }
      tip.hidden = false;
      const px = (x / W) * box.width;
      tip.style.left = `${Math.min(Math.max(0, px - 70), box.width - 150)}px`;
    };
    hit.addEventListener('pointermove', show);
    hit.addEventListener('pointerdown', show);
    hit.addEventListener('pointerleave', () => { tip.hidden = true; xh.setAttribute('visibility', 'hidden'); });
  });
}

const wrap = (svg, rows, extra = '') =>
  `<div class="chart-wrap" data-hover>${svg}<script type="application/json">${JSON.stringify(rows).replace(/</g, '\\u003c')}</script>${extra}</div>`;

// Valuation multiple over time with cheap / fair / expensive zones.
export function multipleChart(v, years, cur = '$') {
  const hist = v.window(years).filter((_, i, a) => a.length < 400 || i % Math.ceil(a.length / 260) === 0 || i === a.length - 1);
  if (hist.length < 2 || !isNum(v.average)) return '<p class="muted">Not enough price and earnings history to chart this multiple.</p>';
  const labels = hist.map(h => fmtMonth(h.date));
  const svg = lineFrame({
    labels,
    series: [{ key: v.metric.short, color: '--ink', values: hist.map(h => h.multiple) }],
    zones: [
      { from: null, to: v.band.cheap, color: '--zone-good' },
      { from: v.band.cheap, to: v.band.expensive, color: '--zone-mid' },
      { from: v.band.expensive, to: null, color: '--zone-bad' },
    ],
    refs: [{ value: v.average }],
    yFmt: x => `${Number.isInteger(x) ? x : x.toFixed(1)}×`,
    height: 260,
    hover: true,
    // Multiples explode when earnings briefly collapse; keep the typical range readable.
    yCap: Math.max(v.average * 2.5, (v.current || 0) * 1.3, v.band.expensive * 1.4),
  });
  const rows = hist.map(h => ({ label: h.date, rows: [[v.metric.short, fmtX(h.multiple), '--ink'], ['Price', fmtPrice(h.price, cur), null]] }));
  const key = (cls, label, mult, price) => `<div class="pk ${cls}"><span>${label}</span><b>${fmtPrice(price, cur)}</b><em>${fmtX(mult)}</em></div>`;
  return wrap(svg, rows) + `<div class="pricekey">
    ${key('good', 'Cheap below', v.band.cheap, v.prices.cheap)}
    ${key('mid', `${v.avgYears}-yr median`, v.average, v.prices.fair)}
    ${key('bad', 'Expensive above', v.band.expensive, v.prices.expensive)}</div>`;
}

// Revenue and profit lines over fiscal years, with a YoY table underneath.
export function growthChart(points, cur = '$', profitField = 'netIncome', profitLabel = 'Earnings') {
  const labels = points.map(p => p.label);
  const rev = points.map(p => p.revenue), prof = points.map(p => p[profitField]);
  const svg = lineFrame({
    labels,
    series: [
      { color: '--s1', values: rev, markers: true },
      { color: '--s2', values: prof, markers: true },
    ],
    yFmt: x => fmtMoney(x, cur),
    height: 220,
    hover: true,
  });
  const yoy = arr => arr.map((v, i) => (i && isNum(v) && isNum(arr[i - 1]) && arr[i - 1] !== 0 ? (v - arr[i - 1]) / Math.abs(arr[i - 1]) : null));
  const ry = yoy(rev), py = yoy(prof);
  const rows = points.map((p, i) => ({
    label: p.label,
    rows: [['Revenue', fmtMoney(rev[i], cur), '--s1'], [profitLabel, fmtMoney(prof[i], cur), '--s2']],
  }));
  const legend = `<div class="legend"><span><i style="background:var(--s1)"></i>Revenue</span><span><i style="background:var(--s2)"></i>${esc(profitLabel)}</span></div>`;
  const cell = v => `<td class="${isNum(v) ? (v >= 0 ? 'up' : 'down') : ''}">${fmtSigned(v, 0)}</td>`;
  const table = `<div class="tscroll"><table class="yoy"><thead><tr><th></th>${labels.map(l => `<th>${esc(l)}</th>`).join('')}</tr></thead><tbody>
    <tr><th>Revenue</th>${rev.map(v => `<td>${fmtMoney(v, cur)}</td>`).join('')}</tr>
    <tr><th class="sub">YoY</th>${ry.map(cell).join('')}</tr>
    <tr><th>${esc(profitLabel)}</th>${prof.map(v => `<td>${fmtMoney(v, cur)}</td>`).join('')}</tr>
    <tr><th class="sub">YoY</th>${py.map(cell).join('')}</tr></tbody></table></div>`;
  return legend + wrap(svg, rows) + table;
}

// Actual vs consensus per quarter: filled dot = actual (beat/miss), ring = estimate.
export function beatChart(rows, actualKey, estKey, fmt) {
  const r = rows.filter(x => isNum(x[actualKey]) && isNum(x[estKey]));
  if (!r.length) return '<p class="muted">No estimate history available for this stock.</p>';
  const W = CW, H = 150, mL = 4, mR = 4, top = 34, bot = 30;
  const vals = r.flatMap(x => [x[actualKey], x[estKey]]);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const Y = v => top + (1 - (hi === lo ? 0.5 : (v - lo) / (hi - lo))) * (H - top - bot);
  const step = (W - mL - mR) / r.length;
  let s = `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Actual versus estimate by quarter">`;
  r.forEach((x, i) => {
    const cx = mL + step * (i + 0.5);
    const beat = x[actualKey] >= x[estKey];
    s += `<g class="beat-col" tabindex="0"><title>${esc(quarterLabel(x.date))}: actual ${esc(fmt(x[actualKey]))}, estimate ${esc(fmt(x[estKey]))} (${beat ? 'beat' : 'miss'})</title>`;
    s += `<rect x="${cx - step / 2}" y="0" width="${step}" height="${H}" fill="transparent"/>`;
    s += `<text x="${cx}" y="${Y(x[actualKey]) - 10}" text-anchor="middle" class="val ${beat ? 'up' : 'down'}">${esc(fmt(x[actualKey]))}</text>`;
    s += `<circle cx="${cx}" cy="${Y(x[estKey])}" r="5" fill="var(--card)" stroke="var(--muted)" stroke-width="1.5"/>`;
    s += `<circle cx="${cx}" cy="${Y(x[actualKey])}" r="5.5" fill="var(${beat ? '--good' : '--bad'})" stroke="var(--card)" stroke-width="2"/>`;
    s += `<text x="${cx}" y="${H - 8}" text-anchor="middle" class="tick">${esc(quarterLabel(x.date))}</text></g>`;
  });
  return s + '</svg>';
}

// Horizontal share bars for segments or regions.
export function shareBars(seg, cur = '$') {
  if (!seg || !seg.items?.length) return '<p class="muted">Not reported by the data provider for this stock (segment data may need a paid plan).</p>';
  const total = seg.items.reduce((s, x) => s + x.value, 0);
  const top = seg.items.slice(0, 7);
  const rest = seg.items.slice(7);
  if (rest.length) top.push({ name: 'Other', value: rest.reduce((s, x) => s + x.value, 0), prevValue: null });
  let s = '<div class="bars">';
  for (const x of top) {
    const share = x.value / total;
    const ch = isNum(x.prevValue) && x.prevValue > 0 ? x.value / x.prevValue - 1 : null;
    s += `<div class="bar-row"><div class="bar-head"><span class="bar-name">${esc(x.name)}</span>
      <span class="bar-nums"><b>${fmtPct(share)}</b><span>${fmtMoney(x.value, cur)}</span><span class="${isNum(ch) ? (ch >= 0 ? 'up' : 'down') : 'muted'}">${isNum(ch) ? fmtSigned(ch, 0) : '—'}</span></span></div>
      <div class="bar-track"><div class="bar-fill" style="width:${Math.max(1.5, share * 100).toFixed(1)}%"></div></div></div>`;
  }
  return s + '</div>';
}

// Cheap / fair / expensive strip with a marker at today's price.
export function valueStrip(prices, cur = '$') {
  const { cheap, expensive, now } = prices;
  if (!isNum(cheap) || !isNum(expensive) || !isNum(now)) return '';
  const lo = Math.min(cheap * 0.6, now * 0.9), hi = Math.max(expensive * 1.4, now * 1.1);
  const P = v => ((v - lo) / (hi - lo)) * 100;
  return `<div class="strip">
    <div class="strip-now" style="left:${P(now).toFixed(1)}%"><span class="${P(now) < 18 ? 'l' : P(now) > 82 ? 'r' : ''}">Now ${fmtPrice(now, cur)}</span></div>
    <div class="strip-bar">
      <div class="z good" style="width:${P(cheap).toFixed(1)}%">Cheap</div>
      <div class="z mid" style="width:${(P(expensive) - P(cheap)).toFixed(1)}%">Fair</div>
      <div class="z bad" style="width:${(100 - P(expensive)).toFixed(1)}%">Expensive</div>
    </div>
    <div class="strip-ticks"><span style="left:${P(cheap).toFixed(1)}%">${fmtPrice(cheap, cur)}</span><span style="left:${P(expensive).toFixed(1)}%">${fmtPrice(expensive, cur)}</span></div>
  </div>`;
}

// The five business phases, current one highlighted.
export function phaseDiagram(phase, symbol) {
  const names = [['Startup'], ['Hyper', 'Growth'], ['Operating', 'Leverage'], ['Capital', 'Return'], ['Decline']];
  const W = CW, H = 240, cw = W / 5, base = 160;
  let s = `<svg viewBox="0 0 ${W} ${H}" class="chart phase-svg" role="img" aria-label="Phase ${phase} of 5">`;
  s += `<rect x="${(phase - 1) * cw}" y="0" width="${cw}" height="${H}" class="ph-cur"/>`;
  names.forEach((words, i) => {
    s += `<line x1="${i * cw}" x2="${i * cw}" y1="0" y2="${H}" class="grid"/>`;
    s += `<text x="${i * cw + cw / 2}" y="18" text-anchor="middle" class="ph-num">${i + 1}</text>`;
    words.forEach((w, k) => { s += `<text x="${i * cw + cw / 2}" y="${33 + k * 13}" text-anchor="middle" class="ph-name">${w}</text>`; });
  });
  s += `<line x1="0" x2="${W}" y1="${base}" y2="${base}" class="axis"/>`;
  s += `<text x="4" y="${base - 4}" class="tick">$0</text>`;
  // Revenue: flat, then steep, then flattening, then falling.
  s += `<path d="M0 ${base - 4} C ${cw} ${base - 8}, ${cw * 1.6} ${base - 20}, ${cw * 2} ${base - 45} S ${cw * 3} ${base - 100}, ${cw * 3.6} ${base - 106} S ${cw * 4.4} ${base - 100}, ${W} ${base - 60}" class="ph-rev"/>`;
  // Profit: losses peak in phase 2, breakeven in 3, peak in 4, fall in 5.
  s += `<path d="M0 ${base + 4} C ${cw * 0.8} ${base + 20}, ${cw * 1.2} ${base + 40}, ${cw * 1.5} ${base + 38} S ${cw * 2.2} ${base + 10}, ${cw * 2.5} ${base - 10} S ${cw * 3.3} ${base - 55}, ${cw * 3.8} ${base - 58} S ${cw * 4.5} ${base - 40}, ${W} ${base - 5}" class="ph-prof"/>`;
  s += `<text x="${cw * 1.3}" y="${base - 26}" class="ph-tag">Revenue</text>`;
  s += `<text x="${cw * 0.12}" y="${base + 26}" class="ph-tag">Profits</text>`;
  s += `<rect x="${(phase - 1) * cw + cw / 2 - 30}" y="${H - 34}" width="60" height="24" rx="6" class="ph-badge"/>`;
  s += `<text x="${(phase - 1) * cw + cw / 2}" y="${H - 17}" text-anchor="middle" class="ph-badge-t">${esc(symbol)}</text>`;
  return s + '</svg>';
}

function fmtMonth(d) {
  const m = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${m[+d.slice(5, 7) - 1]} ’${d.slice(2, 4)}`;
}
function quarterLabel(d) {
  // Label by the quarter the report landed in.
  const q = Math.floor((+d.slice(5, 7) - 1) / 3) + 1;
  return `Q${q} ’${d.slice(2, 4)}`;
}

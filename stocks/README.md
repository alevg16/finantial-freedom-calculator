# Stock Simplifier

A plain-English stock analyzer. Type a ticker and get a report scored 1–5 on
business quality, moat, growth, management, risk and valuation, plus the
company's phase and an overall verdict (Sell / Pass / Hold / Watch / Buy).

It's a static site: no build step, no server. Open `index.html` through any
web server (GitHub Pages works) — ES modules don't load from `file://`.

```sh
python3 -m http.server 8000   # from the repo root, then open http://localhost:8000/stocks/
```

## Setup

- **Demo**: works immediately at `#/s/DEMO` (a fictional company with generated numbers).
- **Real stocks**: add a free [Financial Modeling Prep](https://site.financialmodelingprep.com/developer/docs)
  API key in Settings. One analysis uses about 11 requests and is cached for 12 hours.
  Segment data, quarterly statements and analyst estimates may need a paid FMP plan;
  the report just shows less without them.
- **AI judgement (optional)**: add an Anthropic API key in Settings. Claude then
  answers the questions numbers can't (moat sources, customer concentration,
  disruption, founder involvement) and can search the web for current facts.

Keys are stored only in your browser's localStorage.

## How the scores work

The rules live in `js/analysis.js`.

| Section | Driven by |
|---|---|
| Business | Revenue declines and volatility, gross-margin level and stability, worst-year margins, return on invested capital |
| Phase | Revenue growth, operating profit, dividends/buybacks, multi-year revenue decline |
| Moat width | Average and minimum return on invested capital, blended with the rated moat sources |
| Moat direction | Trend in return on capital and gross margin, blended with source directions |
| Growth | Revenue CAGR (3-yr weighted, plus 5-yr and 1-yr) |
| Management | Beat rate vs. estimates, return on capital, share-count trend, CEO tenure/ownership/founder |
| Risk | Revenue concentration, disruption, outside control, balance-sheet health |
| Valuation | Current multiple vs. its own 5-year median; the multiple depends on the phase (P/S early, P/FCF in phase 3, P/E when mature) |

Every qualitative card says where its answer came from — *From the numbers*,
*AI*, or *Your call* — and you can tap any option to overrule it.

Not financial advice.

## Tests

```sh
cd stocks && npm test
```

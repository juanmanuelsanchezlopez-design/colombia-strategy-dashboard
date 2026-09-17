# Colombia Strategy Dashboard

BTG Pactual Equity Research: Colombia coverage, valuation, stock performance and equity flows.

**Do not edit this repository on GitHub.** It is published from the Colombia Strategy Dashboard project with `run\4_publish_website.bat`, which replaces every file here except the price file.

| What | Where |
|---|---|
| The website (GitHub Pages) | `site/` |
| BTG Pactual inputs, published from the project's Excel workbook | `site/data/btg_data.js` |
| Prices, history, dividends and FX from Yahoo Finance, kept up to date by GitHub | `site/data/market_data.js` |
| The price updates: every 10 minutes in market hours, full history daily | `.github/workflows/update-prices.yml` |
| The price download | `scripts/fetch_market_data.py` |

To update prices now: **Actions** → **Update prices and publish the website** → **Run workflow**.

# BStock Costco Watchlist Site

Static Netlify site. Data is in `data/listings.json`; pages hide ended auctions automatically.

## Netlify
- Build command: `echo static site`
- Publish directory: `.`

## Daily refresh
GitHub Actions schedule is set for 8:30 AM MDT (`30 14 * * *`). Add repo secrets:
- `BSTOCK_EMAIL`
- `BSTOCK_PASSWORD`

BStock may require Cloudflare/browser verification; if so, refresh must run from an authenticated browser/session or a supported BStock export/API.

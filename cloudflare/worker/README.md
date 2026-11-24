# Cloudflare deployment notes

The production Worker is the existing Cloudflare script `smcprov2`. Its deployed code is managed directly in Cloudflare; this repository is not yet the Worker build/deployment source of truth.

- Latest deployed Worker version: `bc45a7af-3fa9-4d78-abfc-a64a8cc57743` (100% traffic).
- Execution venue: BingX USDT-M VST Demo only.
- `LIVE_TRADING_ENABLED=false`; demo execution remains enabled.
- Cron: `*/5 * * * *` (preserved).
- Durable Object: `EngineState` with SQLite.
- KV binding: `PAPER_STATE`.
- BingX credentials remain Cloudflare secrets and are never committed here.
- The deployed risk logic captures the first verified VST equity snapshot into Durable Object storage under `bingx-vst-risk-baseline-v1`. Fixed 1R is 2% of that initial equity and never compounds or rebases. Reduced-risk setups use 0.5R. New entries fail closed if the balance or baseline storage cannot be verified.
- Minimum R:R: 1:1. Normal target objective: 3.5R when supported by structure; extended targets require additional confirmations.
- 1m and 3m are removed from supported scan/history intervals and setup validation.

Recent deployment also repaired the Durable Object confidence-history read and added the missing closed-strategy-metadata state key to the external state bridge.

The repository contains the strategy specification and independently testable risk helpers. A reproducible Wrangler build and deployment pipeline must be established before GitHub is used to deploy this Worker.

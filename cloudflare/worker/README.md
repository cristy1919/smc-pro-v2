# Cloudflare deployment notes

The production Worker is the existing Cloudflare script `smcprov2`. Its deployed code is managed directly in Cloudflare; this repository is not yet the Worker build/deployment source of truth.

- Execution venue: BingX USDT-M VST Demo only.
- `LIVE_TRADING_ENABLED=false`.
- Cron: `*/5 * * * *` (preserved).
- Durable Object: `EngineState` with SQLite.
- KV binding: `PAPER_STATE`.
- BingX credentials remain Cloudflare secrets and are never committed here.
- The deployed risk update stores an immutable baseline in Durable Object storage under `bingx-vst-risk-baseline-v1`. It captures the first verified VST equity snapshot; 1R is 2% of that amount and does not compound or rebase. Reduced-risk setups use 0.5R. New entries fail closed if the balance or baseline storage cannot be verified.
- Normal target objective: 3.5R when supported by the structure; minimum R:R: 1:1.

The repository contains the strategy specification and independently testable risk helpers. A reproducible Wrangler build and deployment pipeline must be established before GitHub is used to deploy this Worker.

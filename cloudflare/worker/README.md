# Deployed Cloudflare Worker source mirror

This directory mirrors the TypeScript modules currently deployed to the existing Cloudflare Worker `smcprov2`.

- Execution mode: BingX USDT-M VST Demo only.
- Live trading flag remains disabled.
- Cron remains `*/5 * * * *`.
- Durable Object class: `EngineState` (SQLite).
- KV namespace: `PAPER_STATE`.
- BingX API credentials remain Cloudflare secrets and are not stored in this repository.
- The deployed version captures the first verified BingX VST equity snapshot into Durable Object storage under `bingx-vst-risk-baseline-v1`. Fixed 1R is 2% of that initial equity and is never recalculated from later equity. If the balance cannot be read or the baseline cannot be persisted, new entries are blocked while existing-position reconciliation continues.
- Reduced-risk setups use 0.5R. Normal target objective is 3.5R, with the engine's existing structural confirmation and risk filters.

This is a source mirror, not an automated deployment workflow. Production deployment remains managed through Cloudflare until the repository build/deployment pipeline is explicitly established and tested.

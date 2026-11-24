# V1 infrastructure audit boundary

Do not modify the existing Cloudflare Worker, Durable Object namespace/class, KV namespace, bindings, secrets or Cron schedule during repository scaffolding. Reuse existing Durable Object and KV architecture; do not introduce D1. Complete a read-only inventory and compatibility review before any integration/deployment. Never commit credentials. This repository commit does not deploy or change Cloudflare resources.

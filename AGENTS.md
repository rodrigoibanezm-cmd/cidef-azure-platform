# Agent rules — CIDEF Azure

Read `docs/PROJECT-CONTEXT.md` before each task. Inspect current code/state; do not assume docs are live telemetry.

- GOAL: replace Vercel + Neon with **one production stack on Azure**. Legacy runs only until cutover; never build permanent dual-stack.
- LEGACY (read/reference only): `cidef-data-loader` on Neon/Vercel. Do not modify, deploy, or disable unless explicitly authorized.
- AZURE backend: `cidef-azure-platform`. Front: `cidef-inteligencia-comercial`.
- FLOW: original files -> Azure Blob -> loaders -> Azure PostgreSQL RAW/canonical -> P1/P2 -> Azure API/MCP -> Azure front.
- Runtime DB: `AZURE_DATABASE_URL` only; no Neon fallback. Neon is for read-only parity checks, not runtime or production ingestion.
- Prefer cloning certified legacy logic; adapt I/O only. Preserve semantics, contracts, IDs, historical periods. No destructive master rebuild/truncate.
- Front `/como-vamos`: query live P1/P2 on open and period change; no hardcoded data, business math, or commentary; display source cutoff. Front is presentation only. `/cierre-mensual` immutable, out of scope.
- COMPANY KPIs: SALES VIN, FORUM QUOTATIONS, PRECURSE (distinct from APPLICATIONS), FORUM UFIS, RVM registrations, RVM share. Every KPI: Company/FOTON/DONGFENG, temporal series and certified cutoff. P1 facts; P2 derived measures. No uncertified brand merging (RVM DFM/DONGFENG/DONG FENG).
- Azure MCP deployed entrypoint is `mcp/server.js`, not necessarily `lib/mcp/server.js`; verify actual tool exposure.
- No new branch/infrastructure, repeated loads or broad tests unless needed/requested. Work on `main`. On broad tasks: diagnosis -> proposal -> implementation, separately.
- Report changes, evidence, failures, next blocker concisely. Never claim certification without validation.

# RVM P1 on Azure

The Azure MCP exposes the certified RVM P1 contract through four read-only tools:

- `rvm_data_describe`: source semantics and supported contract.
- `rvm_data_inspect`: coverage and quality without returning facts.
- `rvm_data_fetch`: filtered factual rows.
- `rvm_data_observe`: quantitative, period-series, and dimensional evidence.

RVM reads `rvm_raw` through the Azure PostgreSQL adapter and requires
`AZURE_DATABASE_URL`. It preserves the source certifier version and contracts.
When a period is requested without an explicit status, it selects consolidated
data if available; otherwise it resolves the latest preliminary snapshot for
that period.

Dimensional observations use `RVM_UNITS = SUM(cantidad)`. Brand/model identities
remain normalized raw labels: `DFM`, `DONGFENG`, and `DONG FENG` stay distinct.

`scripts/verify-rvm-p1.js` checks the September 2026 Neon baseline against Azure:
30,989 units across 77 brands, including FOTON 787, DFM 250, DONGFENG 47, and
DONG FENG 3.

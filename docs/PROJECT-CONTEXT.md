# CIDEF Azure — LLM context
Updated 2026-10-17. Observed/reported status; verify live state before action.

## Destination
SINGLE production: Azure PostgreSQL (`cidef-postgres-prod`), Blob (`cidefprodstorage/cidef`), Container Apps, API/MCP, front. GitHub CI/CD.
Legacy `cidef-data-loader` Neon/Vercel remains untouched until safe cutover; **not** permanent architecture.
Repos: backend `cidef-azure-platform`; front `cidef-inteligencia-comercial`.

## Done (reported)
- Azure MCP P1: SALES, RVM, CRM, FORUM, PRICING deployed; deployment run `39040712355` green.
- FORUM Sept: 8/8 parity. PRICING Oct 14: 64/64 price rows; 899/899 episodes; Dongfeng 007/008.
- 13 P2 units present under `lib/p2/registry.js`; **not exposed** in deployed MCP.
- Front deployed on Azure; `/como-vamos` placeholder; `/cierre-mensual` static snapshot.

## Gaps for live `/como-vamos`
1. SALES MCP deployed: monthly total only; expose P1 daily cutoff, BRAND split, temporal series from existing certified logic.
2. FORUM: QUOTATIONS/UFIS available. Define and certify PRECURSE; APPLICATIONS != PRECURSE. UFIS = financed units, not CURSES operations.
3. RVM: units, monthly series, raw labels. Certified brand mapping required; do not manually merge DFM/DONGFENG/DONG FENG. P2 share needs matching numerator/denominator universe.
4. Publish required P2 tools via **deployed** `mcp/server.js` (generic `lib/mcp/server.js` is not deployed entrypoint).
5. Backend-to-backend Entra auth from front server to Azure MCP/API; no browser secrets; no stale response cache.
6. Implement live Company view: SALES VIN, QUOTATIONS, PRECURSE, UFIS, RVM units, RVM share; each Company/FOTON/DONGFENG + series + independent certified cutoff.
7. Executive narrative last; only if grounded in P1/P2 evidence.

## Invariants
- Data source: Blob -> loader -> Azure PostgreSQL -> P1/P2; P1 never parses CSV files directly.
- Run on front open / period change. No hand-updated numbers or fixed commercial commentary.
- Preserve `/cierre-mensual`, its frozen JSON, and legacy code.
- Copy verified behavior instead of rewriting. No destructive master operations or Neon dependency.
- Reconcile historical snapshot SALES discrepancies separately (1040 P1 vs 1041/1044 frozen JSON); not a reason to alter P1.

## Immediate next step
Propose minimal way to expose existing P1 SALES, certified PRECURSE, P2 share/series in deployed Azure MCP; then implement server-side access and live front. Do not begin by redesigning the front.

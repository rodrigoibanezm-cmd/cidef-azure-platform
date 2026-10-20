# CIDEF Azure — LLM context
Updated: 2026-10-20. Read `AGENTS.md` first: **simplest viable solution**, reuse, no unnecessary architectural changes. Check live repo/state before coding.

## Goal
Single Azure production platform replacing Neon/Vercel. Legacy `cidef-data-loader` is read-only reference for parity; do not alter. Backend `cidef-azure-platform`; front `cidef-inteligencia-comercial`. Azure Blob -> loaders -> Azure PostgreSQL -> certified P1/P2/P3 -> HTTP API -> front. No Neon runtime fallback.

## Engines (reported, verify current)
- P1 SALES/RVM/CRM/FORUM/PRICING migrated; checks against Azure and historical parity. SALES daily/brand/series; FORUM PRECURSE stock of latest snapshot; other FORUM and RVM metrics available subject to contract.
- 13 P2 units exist; levels of integration validation differ by unit/use case. P3 journal/run trace functional for validated flows.
- Remote MCP publication is independent of monthly front. For front, backend may call P1/P2/P3 directly, preserving P3; never bypass certified contracts via direct commercial SQL.
- Availability of a motor ≠ certification of every P1→P2→P3 combination. Validate each combination and report unavailable without invented data.

## Cómo vamos (current design)
See **`docs/COMO-VAMOS-SNAPSHOTS.md`** for authoritative cache/signature/history contract.
- Scope ONLY SALES, FORUM, RVM; CRM/PRICING excluded for now.
- Separate blocks: SALES (including sales rankings), FORUM (QUOTATIONS / PRECURSE / UFIS), RVM (registrations / share).
- Three snapshot tables, **one per domain**, no megatable and no fourth ranking table.
- Snapshot read on open/navigation; rebuild on source/engine signature changes, selective and deduplicated. Historical daily snapshots on demand only.
- Six-month base-100 comparisons computed in P2; source cutoffs independent; PRECURSE = latest snapshot only, never fabricated historical trend.
- Front `/como-vamos` currently includes presentation scaffold, channel drilldowns and ranking UI; do not assume the certified Azure API is connected until verified. `/cierre-mensual` immutable/out of scope.
- Next step: verify reuse of existing snapshot/invalidation patterns, implement minimum P1/P2/P3 certified domain payloads and snapshot access, then wire front API. No visual redesign without user decision.

## Rules
- Source original files to Azure Blob, not Neon-to-Azure table copies.
- Never rebuild certified business formulas in front or routes; P1 facts, P2 derived, P3 trace.
- No hardcoded commercial figures; preserve identities and date cutoffs.
- Work on requested branch; no unnecessary infrastructure, rebuilds, or broad test suites.

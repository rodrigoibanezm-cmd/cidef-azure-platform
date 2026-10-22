# Forum /ventas — replacement publisher, not activated

Status: implemented and tested; **do not publish or deploy until caller handoff is complete**. The active legacy publisher and production snapshots have not been changed. No new Action, table, engine, service or infrastructure is required.

## Reuse

Copied from `cidef-data-loader@f5225db7be99d8a8e439d3a4835e94f367e1cf8c`: `scripts/refresh-forum-ventas-snapshot-azure.js` and `lib/forum-snapshot/{mcp,projection,publication}.js`. The same `public.forum_ventas_snapshot_v01`, advisory lock, source fingerprints, P1 reconciliation, transactional replacement and rollback probe are retained. The replacement requires the existing table; it never installs DDL.

The additional FORUM P1 FETCH uses `network: DEALERS`, `stage: CURSE` and the existing fields `operation_number`, `distributor`, `brand_id`, `brand`, `network`, `curse_date`, `ufi_curse`, `has_curse_evidence`. P1 defines CURSE stage from certified Curse evidence. Each operation is unique; UFI is the sum of vehicle units, not the number of operations. Date membership uses `curse_date` and the independent FORUM cutoff, never quotation date.

Dealer identity uses the actual `DEALER_IDENTITY_JOINS` and `DEALER_GROUP_SQL` exported by the existing FORUM P1 query module: validated aliases -> dealer master -> commercial group, with the same direct canonical-name fallback. Unresolved identities and brands remain explicit; there are no hardcoded dealer aliases. The monthly pivot must reconcile independently against P1 BRAND and DISTRIBUTOR margins and its total before publication. A mismatch retains the previous generation.

Each existing BUNDLE `payload.history[]` gains `dealer_ufis` for DEALERS:

```json
{"period":"2026-10","dealer_ufis":{"period":"2026-10","cutoff":"2026-10-20","measure":"FORUM_P1_UFIS","total":51,"members":[{"dealer_key":"canonical group id or explicit unresolved key","dealer_group_id":"canonical group id or null","dealer_label":"canonical label","brand_id":"P1 canonical brand id","brand_label":"P1 canonical brand label","ufis":1}]}}
```

The JSON example is schematic; members must sum to total and are never filled from acceptance figures. The existing SALES reports/facts and their financial-entity counts retain their definitions. The frontend exposes the added data separately as `dealer_forum`; it does not claim VIN identity for FORUM operations. UFI-only dealers are included even when their SALES denominator is zero.

Historical penetration keeps the existing SALES definition: monthly VIN with financial entity FORUM / monthly SALES VIN. Both counts already exist in each history member. Dealer table percentages use UFI FORUM P1 / SALES VIN for the same selection. These are explicitly different numerators; the reader performs only division and selection of published facts. Missing data and zero denominators remain unavailable. Fixed September closing JSON is outside this process.

## Validation and activation

`node scripts/refresh-forum-ventas-snapshot-azure.js --validate` (also the default) uses PostgreSQL read-only mode, does not write STATUS/BUNDLE, and does not run the write/rollback probe. Full validation is intentionally not executed against production during this delivery. Unit tests use local fixtures, and separate live read-only P1 checks reconcile October 1–20 DEALERS: 51 UFI = 44 FOTON + 7 DONGFENG.

Writing requires **both** `--publish` and `FORUM_SNAPSHOT_PUBLISHER=azure-platform`. The flag records the operator's confirmed handoff; it does not itself detect an old queued Action. The shared advisory lock serializes publishers but is not a substitute for removing old callers.

### Minimum legacy Action changes (not applied)

Replace the old publisher invocation, do not append a second invocation, in exactly these existing files:

- `.github/workflows/refresh-sales-sources.yml`, after Azure identity synchronization.
- `.github/workflows/build-forum-funnel-raw.yml`, after Azure FORUM synchronization.
- `.github/workflows/build-vehiculo-canonico-azure.yml`, its existing standalone publication step.

For each caller, check out a pinned reviewed commit of `rodrigoibanezm-cmd/cidef-azure-platform` into `azure-platform-forum`, then replace the old `node scripts/refresh-forum-ventas-snapshot-azure.js` with:

```yaml
env:
  AZURE_DATABASE_URL: ${{ secrets.AZURE_DATABASE_URL }}
  DATABASE_URL: ''
  POSTGRES_URL: ''
  FORUM_SNAPSHOT_PUBLISHER: azure-platform
run: node azure-platform-forum/scripts/refresh-forum-ventas-snapshot-azure.js --publish
```

Use the existing `actions/checkout@v4` action with `repository: rodrigoibanezm-cmd/cidef-azure-platform`, `ref: <reviewed commit SHA>`, `path: azure-platform-forum`, and `persist-credentials: false`. The private cross-repository checkout requires an existing credential with read access to Azure Platform; the legacy repo's default GITHUB_TOKEN cannot be assumed sufficient. No credential was created or inspected. The installed parent repo's `pg` dependency is reused; no extra package installation is necessary.

In the canonical maintenance caller, point its existing snapshot test command at `azure-platform-forum/test/forum-ventas-snapshot.test.js`. Replace all three call sites in a single legacy commit, after draining old runs, so there is only one active implementation. Keep all source-load and synchronization steps unchanged. Only after a successful new publication with dealer × brand data should the Forum frontend be deployed; its existing HTTP deployment validator now rejects snapshots missing that data.

## Amunátegui remains a source-classification blocker

Live SALES P1 FETCH, run `forum-recover-2026-10-22`, September cutoff 2026-09-30, `commercial_universe=OWN_STORES`, `store_id=15`, returns VIN `LVAV2MAB2TU484443`, invoice `75153`, operation `22082`, sale date `2026-09-23`, label `Amunategui`, dealer/group null. This is the same one-sale classification in the existing snapshot. The SALES contract certifies the recognized source category; the snapshot publisher cannot override it. No front filter, hardcoded VIN reclassification, source change or frozen-close edit was introduced. Removing this sale from OWN_STORES requires correcting the certified upstream source/identity, then rebuilding; that production correction is not part of this inactive delivery.

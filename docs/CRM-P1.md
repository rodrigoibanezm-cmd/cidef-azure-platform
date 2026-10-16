# CRM P1 v0.1

CRM exposes `crm_longitudinal_context_v01` using the existing `buildCrmUniverse`.
No ERP bridge, new tables or cache participates.

## Meaning

- LEADS_CREATED: one latest CRM record per ID, dated by CREATED_AT.
- LEADS_ASSIGNED: one latest CRM record per ID, dated by ASSIGNED_AT.
- SOLD: **venta declarada en CRM**, from current affirmative Vendido. Not an ERP-verified sale.
- CONVERSION_RATE: affirmative Vendido / **all leads in the selected cohort**, including unknown outcomes. Fraction; null for an empty denominator.
- MANAGED: valid parsed `Gestionado el`. EVENT is dated by MANAGED_AT; COHORT evaluates current management state within the selected cohort.
- UNMANAGED: no valid parsed management date, including null, empty and present but unparseable values. COHORT only.
- MANAGEMENT_RATE: MANAGED / (MANAGED + UNMANAGED), using the existing longitudinal MANAGEMENT_COVERAGE predicate and denominator. Fraction; null for an empty denominator. COHORT only.

This is the longitudinal definition. The context engine's SOLD / (SOLD + NOT_SOLD) definition is different and is not used here.

Commercial universe and date axis are explicit in filters. STORE/SELLER require OWN_STORES.
COMPANY and OWN_STORES totals are different universes: do not present the own-store split as a complete reconciliation of COMPANY.
BRAND is identity from Producto de interes. Unresolved, ambiguous and not-applicable identities remain buckets and coverage.
PRODUCT_INTEREST and ORIGIN use existing RAW normalization.

## Time

SOLD/conversion describe the **current outcome of dated cohorts**. They do not count dated ERP sales.
CRM loaded_at freshness is distinct from event dates.
Cutoff bounds membership dates, not historical outcome state.
August outcomes can include updates observed in September: they are not a certified August month-end close.
Comparisons have different cohort maturity. A partial September must remain labelled partial.
SNAPSHOT/as_of is rejected.
For a management partition of September-created leads, explicitly use
`mode: 'COHORT', cohort_axis: 'CREATED_AT'` for all three measures. MANAGED's
existing default EVENT/MANAGED_AT behavior is preserved; its event count must
not be combined with UNMANAGED from a different created/assigned cohort.
No time-to-management measure is published: there is no certified duration
rule for created/assigned-to-managed timestamps, timezone, or reassignment.

## Canonical seller resolution

Existing exact validated aliases, canonical names and logins take precedence,
including existing multi-persona ambiguity. Only when exact identity is absent,
the resolver compares complete name-token multisets after accent/separator
normalization and token sorting. Candidates are validated `tipo_alias=nombre`
aliases from all sources and validated canonical names. It never generates
short names, guesses initials, drops tokens, or applies fuzzy matching. A
collision remains AMBIGUOUS. VENDEDOR_CIDEF role/store interval eligibility is
still applied at the requested axis date, independently of name resolution.

SALES uses canonical login identity, while FORUM uses exact forum_raw name
aliases; neither provides this safe fallback. Both implementations and their
contracts remain unchanged. The reusable internal SQL helper is used by CRM.

CRM's previous resolver already consumed validated aliases from every source.
The actual normalization gap was `master_norm`: uppercase and whitespace only,
without accent folding or name-order equivalence. Repeated ordinary spaces
already resolved; non-breaking trailing separators could still fail.
Abbreviations without an existing validated alias continue UNRESOLVED.

This is an additive measure/identity correction within v0.1: existing measure
semantics, evidence envelopes and exported certifier facades are retained.

## September 2026 closure validation

Read-only execution of the before/after universe SQL on Neon main, with the
same latest-state deduplication, OWN_STORES and CREATED_AT September cohort:

| Check | Before | After |
| --- | ---: | ---: |
| LEADS_CREATED | 2,985 | 2,985 |
| STORE resolved | 2,985 | 2,985 |
| SELLER resolved | 1,418 (47.5042%) | 1,887 (63.2161%) |
| SELLER unresolved | 1,406 | 929 |
| SELLER ambiguous | 48 | 48 |
| SELLER not applicable | 113 | 121 |

MANAGED = 2,320; UNMANAGED = 665; MANAGEMENT_RATE =
`2320 / 2985 = 0.7772194304857621`. Present-but-unparseable management values
in this cohort = 0. The eight additionally not-applicable leads have resolved
names but fail the existing role/store/date membership authority; they are
not redistributed. Remaining 929 unresolved leads require new validated
alias authority or correction of canonical identity, not automatic guessing.

ORIGIN remains SHOWROOM 633, CHAT 810, RRSS 610, WEB SITE 656, YAPO 162,
BASE DE CLIENTES 105, RENOVACION 8 and EVENTOS 1: total 2,985.

Tests execute the production SQL in in-memory PostgreSQL (PGlite), then the MCP
callbacks: parsed/missing/empty/invalid dates, deduplication, management ratios,
empty denominators, all five breakdowns, explicit identity buckets, validated
aliases and exact ambiguity, temporal eligibility, incompatible EVENT axes,
and the three-measure batch. No Neon mutation is used by these tests.

Validation: backend syntax passed; fast regression 188 passed. Full regression
872 passed, 4 skipped, 1 failed: the unchanged pre-existing credit-note parser
test expects physical header row 4 but gets 2 because empty rows are omitted.
The same failure was reproduced using the exact test and loader from base main
`fcc99b1ae807a291e9321a4c79e1de2116b8e0be`; no credit-note code was changed.

## Natural question validation

For September 2026 versus August 2026, call data_describe(CRM), then preferably one
`crm_observe_many` request (existing individual `data_observe` remains supported):

```js
{
  run_id: "crm-sep-aug-2026-001-multi",
  period_from: "2026-08", period_to: "2026-09",
  filters: { date_axis: "CREATED_AT", cohort_axis: "CREATED_AT",
    mode: "COHORT", cutoff_mode: "FULL_PERIOD" },
  operations: ["LEADS_CREATED", "SOLD", "CONVERSION_RATE"].flatMap(measure => [
    { commercial_universe: "COMPANY", measure },
    { commercial_universe: "COMPANY", measure, dimension: "BRAND" },
    { commercial_universe: "OWN_STORES", measure, dimension: "STORE" }
  ])
}
```

The adapter validates all operations before loading. Common temporal controls and
identity filters must be compatible; commercial universe belongs to each operation.
Mixed implicit EVENT/COHORT defaults are rejected: specify COHORT for this comparison.
`buildCrmUniverses` loads RAW once and derives only the requested commercial contexts.
All observations use the existing longitudinal assembler and certifier. Freshness is
computed once per context. Nothing survives the request as a cached universe.

Each result carries individual P1 evidence, also journaled as `data_observe` for
existing P2 evidence references. A preceding `crm_observe_many` trace event records
calculation duration, `universe_loads`, `universes_built`, operation count, contexts,
and evidence IDs. Individual durations measure assembly after the shared load;
the shared cost belongs to the parent. Child journal writes are independent and
may finish in a different order; results retain input order.

Equivalent individual calls:
- For each of LEADS_CREATED, SOLD, CONVERSION_RATE: data_observe with
  evidence_shape=PERIOD_OBSERVATION_SERIES, period_from=2026-08, period_to=2026-09,
  filters={commercial_universe:COMPANY,date_axis:CREATED_AT}.
- For BRAND: the same metrics and filters with evidence_shape=DIMENSIONAL_QUANTITATIVE_DATASET, dimension=BRAND.
- For STORE: use dimension=STORE and commercial_universe=OWN_STORES, keeping that scope explicit.
- Keep the returned last_observation_date, historical_close_certified=false, warnings and identity coverage in the answer.

If the natural question means assigned leads, use LEADS_ASSIGNED and ASSIGNED_AT consistently, including the outcome cohort.
No data_fetch is required or supported by CRM P1.
Dates in this example are validation inputs, not implementation constants.

Multi-period dimensional output uses p1.crm_dimensional_cohort_series with a series per member, not a scalar dimensional total.

## Multi-observation validation (2026-10-01)

The nine distinct observations from `crm-sep-aug-2026-001` were reproduced against
Neon. Full evidence objects matched after removing only the generated evidence ID,
including dimensional members, coverage, warnings, temporal semantics and lineage.
The original run made 19 universe loads; the batch makes one RAW load (71,132
versions) and derives COMPANY and OWN_STORES once each. COMPANY August/September
leads remain 9,341/7,172 and declared SOLD 498/279.

Production run `crm-sep-aug-2026-001-multi-production-validation` took 25,634 ms
for the complete HTTP MCP call, including evidence journaling; its parent trace
records 11,186 ms for shared calculation, one load, two contexts and nine operations.
All ten trace events succeeded and all nine evidence objects match the original.
The original agent run took 161,691 ms. The new measurement excludes agent reasoning
and answer generation, so it is not a new end-to-end ChatGPT run. Standalone local
calculation against Neon took 18,785 ms. Fixture tests compare all nine individual
and batch evidence objects, validate P2 reference resolution, reject incompatible
requests before SQL, and prove separate requests each reload the universe.

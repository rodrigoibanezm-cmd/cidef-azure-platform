import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getSalesRunFactSet } from '../lib/data-floor/sales/preparation.js';
import { field } from '../lib/data-floor/sales/dataset.js';
import { observeSalesSelection } from '../lib/data-floor/sales/operations.js';

// Read-only A/B diagnostic. A selective subset is never certified by this tool.
export function registerSalesSqlFirstValidator(server) {
  server.registerTool('sales_sql_first_validate', {
    title: 'SALES SQL-first A/B validator',
    description: 'Read-only diagnostic: compare complete P1 versus selective P1, including VINs, fields, coverage, fingerprints, timing and same-run isolation. Does NOT certify partial universes.',
    inputSchema: {
      commercial_universe: z.literal('OWN_STORES'),
      brand_id: z.number().int().positive(),
      model_id: z.number().int().positive(),
      store_id: z.number().int().positive(),
      date_from: z.string().regex(/^\d{4}-\d{2}-01$/),
      date_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async (filters) => {
    if (filters.date_from.slice(0, 7) !== filters.date_to.slice(0, 7))
      throw new Error('INVALID_VALIDATION_PERIOD');
    const run_id = 'sales-sql-first-validation-' + randomUUID();
    const projection = row => ({
      source_id: row.source_id, vin: field(row, 'vin'), sale_date: field(row, 'sale_date'),
      brand_id: field(row, 'brand_id'), model_id: field(row, 'model_id'),
      version_id: field(row, 'version_id'), store_id: field(row, 'store_id'),
      dealer_id: field(row, 'dealer_id'), seller_id: field(row, 'seller_id'),
      quantity: field(row, 'quantity'), color: field(row, 'color'),
      financial_entity: field(row, 'financial_entity'),
    });
    const snapshot = result => {
      const selection = result.factSet.select(filters);
      const rows = selection.facts.map(projection).sort((a, b) =>
        JSON.stringify(a).localeCompare(JSON.stringify(b)));
      return { rows, vins: [...new Set(rows.map(row => row.vin))].sort(),
        source_n: result.factSet.base.length,
        source_scope: result.factSet.ref.source_scope??'FULL_SOURCE',
        source_filters: result.factSet.ref.source_filters??null,
        coverage: result.factSet.u.coverage,
        validation: result.factSet.u.validation,
        preparation_id: result.factSet.ref.preparation_id,
        fact_set_fingerprint: result.factSet.ref.fingerprint,
        selection_fingerprint: selection.fingerprint };
    };
    const measure = async opts => {
      const timings = {};
      const start = performance.now();
      const result = await getSalesRunFactSet(run_id, {...opts, diagnostic_timings:timings});
      return { result, elapsed_ms: Math.round(performance.now() - start), timings };
    };
    const common = { commercial_universe: 'OWN_STORES', cutoff_date: filters.date_to };
    const full = await measure(common);
    const selective = await measure({ ...common, candidate_filters: filters, diagnostic_sql_first: true });
    const repeat = await measure({ ...common, candidate_filters: filters, diagnostic_sql_first: true });
    const other = await measure({ ...common, candidate_filters: { ...filters, store_id: filters.store_id + 1 }, diagnostic_sql_first: true });
    const a = snapshot(full.result), b = snapshot(selective.result);
    const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);
    const fullEvidence=observeSalesSelection(full.result.factSet.select(filters));
    const partialEvidence=observeSalesSelection(selective.result.factSet.select(filters));
    let outOfScopeRejected=false;
    try { selective.result.factSet.select({...filters,store_id:filters.store_id+1}); }
    catch(error) { outOfScopeRejected=error.message==='SALES_PARTIAL_SOURCE_FILTER_MISMATCH'; }
    const checks = {
      records_equal: same(a.rows, b.rows),
      vins_equal: same(a.vins, b.vins),
      partial_scope_declared: a.source_scope==='FULL_SOURCE'&&b.source_scope==='PARTIAL_SOURCE',
      partial_scope_exact: same(b.source_filters,selective.result.factSet.select(filters).canonical_filters),
      out_of_scope_rejected: outOfScopeRejected,
      partial_evidence_distinct: partialEvidence.status==='PARTIAL_SOURCE'&&
        partialEvidence.authority==='P1_PARTIAL_SOURCE'&&
        partialEvidence.evidence_contract==='p1.sql_first_partial_observation'&&
        fullEvidence.status==='CERTIFIED'&&
        fullEvidence.evidence_id!==partialEvidence.evidence_id,
      observed_values_equal: fullEvidence.payload.value===partialEvidence.payload.value,
      validation_equal: same(a.validation, b.validation),
      same_scope_reused: repeat.result.preparations === 0 &&
        repeat.result.factSet.ref.preparation_id === b.preparation_id,
      different_scope_isolated: other.result.factSet.ref.preparation_id !== b.preparation_id &&
        other.result.factSet.ref.preparation_id !== a.preparation_id,
      full_scope_isolated: a.preparation_id !== b.preparation_id,
    };
    const out = {
      status: Object.values(checks).every(Boolean) ? 'PASS' : 'FAIL',
      certification: 'DIAGNOSTIC_ONLY',
      filters, checks,
      baseline: { elapsed_ms: full.elapsed_ms, timings: full.timings, count: a.rows.length, vins: a.vins,
        source_n: a.source_n, source_scope:a.source_scope, evidence: {status:fullEvidence.status,value:fullEvidence.payload.value,contract:fullEvidence.evidence_contract}, fact_set_fingerprint: a.fact_set_fingerprint,
        selection_fingerprint: a.selection_fingerprint },
      selective: { elapsed_ms: selective.elapsed_ms, timings: selective.timings, count: b.rows.length, vins: b.vins,
        source_n: b.source_n, source_scope:b.source_scope, source_filters:b.source_filters,
        evidence: {status:partialEvidence.status,value:partialEvidence.payload.value,contract:partialEvidence.evidence_contract}, fact_set_fingerprint: b.fact_set_fingerprint,
        selection_fingerprint: b.selection_fingerprint },
      isolation: { same_scope_repeat_ms: repeat.elapsed_ms, other_scope_ms: other.elapsed_ms, other_scope_timings: other.timings },
      timing_note: 'Loader *_ms metrics are elapsed-to-completion from concurrent preparation start; do not add them together.',
      differences: {
        missing_rows: a.rows.filter(row => !b.rows.some(other => same(row, other))).slice(0, 10),
        extra_rows: b.rows.filter(row => !a.rows.some(other => same(row, other))).slice(0, 10),
        coverage: same(a.coverage,b.coverage) ? null : { full: a.coverage, selective: b.coverage },
        validation: checks.validation_equal ? null : { full: a.validation, selective: b.validation },
      },
    };
    return { structuredContent: out, content: [{ type: 'text', text: JSON.stringify(out) }] };
  });
}

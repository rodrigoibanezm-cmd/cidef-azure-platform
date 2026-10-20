import assert from 'node:assert/strict';
import { closeAzurePool } from '../lib/azure-postgres.js';
import { describeForum, fetchForum, observeForumEvidence } from '../lib/data-floor/forumCertifier.js';

const markdown = [];
const add = (line = '') => markdown.push(line);
const md = (value) => String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
const normalized = (value) => String(value ?? '').trim().toUpperCase();
const sum = (members) => members.reduce((total, row) => total + Number(row.value || 0), 0);

try {
  const contract = describeForum();
  assert.equal(contract.version, '0.12');
  assert.ok(contract.measures.OPERATION_STATES);
  assert.equal(contract.measures.OPERATION_STATES.rule, 'DAILY_COTIZACION_SNAPSHOT_STATE');
  assert.equal(contract.measures.PRECURSE.rule, 'CERTIFIED_PRECURSE_STAGE_NO_CERTIFIED_CURSE');
  assert.match(contract.measures.PRECURSE.meaning, /latest available snapshot/i);
  assert.ok(contract.dimensions.includes('STORE'));
  assert.ok(contract.dimensions.includes('SELLER'));

  const company = await observeForumEvidence({ measure: 'PRECURSE' });
  assert.equal(company.authority, 'P1_CERTIFIED');
  assert.equal(company.status, 'COMPLETE');
  assert.equal(company.evidence_version, contract.version);
  assert.equal(company.payload.rule, contract.measures.PRECURSE.rule);
  const snapshotDate = company.temporal.snapshot_date;
  assert.match(snapshotDate, /^\d{4}-\d{2}-\d{2}$/);

  const dimensional = {};
  for (const dimension of ['STORE', 'SELLER']) {
    const evidence = await observeForumEvidence({
      measure: 'PRECURSE',
      evidence_shape: 'DIMENSIONAL_QUANTITATIVE_DATASET',
      dimension,
      cutoff: snapshotDate,
    });
    assert.equal(evidence.authority, 'P1_CERTIFIED');
    assert.equal(evidence.status, 'COMPLETE');
    assert.equal(evidence.evidence_version, contract.version);
    assert.equal(evidence.temporal.snapshot_date, snapshotDate);
    assert.equal(evidence.payload.rule, contract.measures.PRECURSE.rule);
    assert.equal(sum(evidence.payload.members), company.payload.value,
      'PRECURSE ' + dimension + ' does not reconcile to company');
    dimensional[dimension] = evidence;
  }

  // OPERATION_STATES certifies the COTIZACION state of the exact daily snapshot.
  // It documents snapshot coverage; it is not used to recalculate PRECURSE.
  const operationStates = await observeForumEvidence({
    measure: 'OPERATION_STATES',
    evidence_shape: 'OPERATION_STATE_SNAPSHOT',
    cutoff: snapshotDate,
  });
  assert.equal(operationStates.authority, 'P1_CERTIFIED');
  assert.equal(operationStates.status, 'COMPLETE');
  assert.equal(operationStates.temporal.snapshot_date, snapshotDate);
  assert.equal(operationStates.payload.rule, contract.measures.OPERATION_STATES.rule);

  // P1 FETCH supplies operation-level raw identity labels solely to enumerate
  // unresolved identities. The totals above remain the P1 OBSERVE outputs.
  const operations = await fetchForum({
    filters: { stage: 'PRECURSE' },
    fields: ['operation_number', 'certified_stage', 'store', 'seller', 'distributor'],
  });
  assert.equal(operations.version, contract.version);
  assert.equal(operations.rows.length, company.payload.value,
    'PRECURSE FETCH rows do not match the certified company total');

  const unresolvedLabels = {};
  for (const dimension of ['STORE', 'SELLER']) {
    unresolvedLabels[dimension] = new Set(
      dimensional[dimension].payload.members
        .filter((member) => member.member_id === 'UNRESOLVED' || member.member_id.startsWith('UNRESOLVED:'))
        .map((member) => normalized(member.member_label) || 'UNRESOLVED'),
    );
  }
  const unresolvedOperations = operations.rows.flatMap((row) => {
    const unresolved = [];
    if (unresolvedLabels.STORE.has(normalized(row.store) || 'UNRESOLVED')) unresolved.push('STORE');
    if (unresolvedLabels.SELLER.has(normalized(row.seller) || 'UNRESOLVED')) unresolved.push('SELLER');
    if (!unresolved.length) return [];
    return [{
      operation_number: row.operation_number,
      distributor: row.distributor,
      store: row.store,
      seller: row.seller,
      unresolved_dimensions: unresolved.join(', '),
    }];
  });

  add('# PRECURSE P1 en Azure — diagnóstico');
  add();
  add('- **Snapshot certificado:** ' + snapshotDate);
  add('- **PRECURSE compañía:** ' + company.payload.value + ' operaciones');
  add('- **Identidades sin resolver:** ' + unresolvedOperations.length + ' operaciones (' +
    unresolvedLabels.STORE.size + ' etiquetas de tienda y ' +
    unresolvedLabels.SELLER.size + ' de vendedor sin resolver)');
  add();
  add('## Contrato y evidencia P1');
  add();
  add('- FORUM P1 versión ' + contract.version + '; autoridad: ' + company.authority + '; estado: ' + company.status + '.');
  add('- PRECURSE: ' + contract.measures.PRECURSE.meaning + ' Regla: ' + contract.measures.PRECURSE.rule + '.');
  add('- OPERATION_STATES: ' + contract.measures.OPERATION_STATES.meaning + ' Regla: ' + contract.measures.OPERATION_STATES.rule + '.');
  add('- Evidencias PRECURSE: compañía ' + company.evidence_id + '; tienda ' +
    dimensional.STORE.evidence_id + '; vendedor ' + dimensional.SELLER.evidence_id + '.');
  add('- Evidencia de estados diarios: ' + operationStates.evidence_id + '; ' +
    operationStates.coverage.operation_count + ' operaciones únicas en snapshot COTIZACION exacto.');
  add('- Linaje: ' + company.lineage.precurse_snapshot_source + ', corte ' +
    company.lineage.precurse_snapshot_date + '; STORE usa ' +
    dimensional.STORE.payload.dimension.identity_contract + '; SELLER usa ' +
    dimensional.SELLER.payload.dimension.identity_contract + '.');
  add();
  add('PRECURSE es stock de operaciones en etapa certificada PRECURSE, sin evidencia CURSE certificada, al último snapshot disponible. No es evento mensual, no equivale a APPLICATIONS y no se deriva de OPERATION_STATES.');
  add();
  add('## Desglose por tienda');
  add();
  add('| ID canónico | Tienda | Operaciones |');
  add('|---|---|---:|');
  for (const row of dimensional.STORE.payload.members) {
    add('|' + md(row.member_id) + '|' + md(row.member_label) + '|' + row.value + '|');
  }
  add();
  add('## Desglose por vendedor');
  add();
  add('| ID canónico | Vendedor | Operaciones |');
  add('|---|---|---:|');
  for (const row of dimensional.SELLER.payload.members) {
    add('|' + md(row.member_id) + '|' + md(row.member_label) + '|' + row.value + '|');
  }
  add();
  add('## Operaciones con tienda o vendedor sin identidad resuelta');
  add();
  if (unresolvedOperations.length) {
    add('| Operación | Dimensión sin resolver | Distribuidor | Tienda raw | Vendedor raw |');
    add('|---:|---|---|---|---|');
    for (const row of unresolvedOperations) {
      add('|' + md(row.operation_number) + '|' + md(row.unresolved_dimensions) + '|' +
        md(row.distributor) + '|' + md(row.store) + '|' + md(row.seller) + '|');
    }
  } else {
    add('No se encontraron operaciones PRECURSE con tienda o vendedor sin resolver.');
  }
  add();
  add('## Integración mínima propuesta para Proyecciones Admin');
  add();
  add('En el proceso existente de Actualizar, consumir una vez las evidencias P1 PRECURSE de compañía, STORE y SELLER usando el mismo snapshot_date; validar autoridad, versión, corte común y que cada desglose reconcilie al total. Incorporar los valores en el payload JSONB de las filas ya existentes de weekly_projection_results para Empresa, tienda y vendedor y guardarlos en el reemplazo transaccional actual. La navegación debe leer el snapshot guardado; no volver a llamar P1 ni recalcular. No crear otra tabla ni escribir desde este Action.');
  add();
  add('---');
  add('Este reporte proviene de consultas de lectura a PostgreSQL Azure mediante los motores FORUM P1 existentes. No se escribió en tablas.');

  const report = markdown.join('\n') + '\n';
  console.log(report);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const fs = await import('node:fs/promises');
    await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, report, 'utf8');
  }
} finally {
  await closeAzurePool();
}

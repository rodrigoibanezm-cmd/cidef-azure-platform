import { executePricingWindowSales } from './units/pricing-window-sales.js';
import { executeClosedPeriodStorePerformance } from './units/closed-period-store-performance.js';
import { executeClosedPeriodSalesPerformance } from './units/closed-period-sales-performance.js';
import { executeForumSnapshotTransitions } from './units/forum-snapshot-transitions.js';
import { executeForumFunnelPerformance } from './units/forum-funnel-performance.js';
import { executeObservedPairDelta } from './units/observed-pair-delta.js';
import { executeOpenPeriodDeteriorationRisk } from './units/open-period-deterioration-risk.js';
import { executeObservedSequence } from './units/observed-sequence.js';
import { executeReconciledDimensionDelta } from './units/reconciled-dimension-delta.js';
import { executePeriodCloseEstimate } from './units/period-close-estimate.js';
import { executePartToUniverseRatio } from './units/part-to-universe-ratio.js';
import { executeProportionAcrossPeriods } from './units/proportion-across-periods.js';
import { executeReferenceDeviation } from './units/reference-deviation.js';
import { executeTargetAttainmentProbability } from './units/target-attainment-probability.js';
import { executeReconciledSellerTargetContribution } from './units/reconciled-seller-target-contribution.js';

const units = [
  {
    unit_id: 'p2.closed_period_sales_performance', contract_version: '0.1.0', status: 'ACTIVE',
    semantic_contract: {
      analyzes: 'Desempeño SALES de vendedores y modelos canónicos en meses cerrados, mediante el mismo núcleo aprobado de Tiendas.',
      requires_evidence: ['Datasets P1 mensuales originales SELLER/OWN_STORES o MODEL/COMPANY desde 2021-01 hasta cutoff_month.'],
      produces_knowledge: ['IMPROVING, STABLE, DETERIORATING o UNKNOWN con evidencia, cobertura y continuidad de identidad.'],
      supports_claims: ['Clasificación bajo la política estadística fija de c3ee707 y la evidencia certificada indicada.'],
      does_not_support: ['DEALER_GROUP sin contrato P1 de identidad dimensional.', 'STORE se conserva en su unidad existente.', 'FORUM, RVM, meses abiertos, inferencia de actividad o significancia inferencial.', 'Considerar ausencia igual a cero, unir IDs por nombre o reconstruir una identidad histórica no certificada.'],
      assumptions: ['P1 conserva identidad/versión y reconocimiento en cada cierre.', 'Las etiquetas no sustituyen a los IDs canónicos.'],
    },
    deterministic_contract: {
      evidence_slots: [{ slot_pattern: 'history_YYYY_MM', cardinality: 'ONE_PER_MONTH', authority: 'P1_CERTIFIED', shape: 'DIMENSIONAL_QUANTITATIVE_DATASET' }],
      parameters: { cutoff_month: { type: 'CLOSED_MONTH', required: true }, dimension: { allowed: ['SELLER','MODEL'], required: true }, member_id: { type: 'CANONICAL_MEMBER_ID', required: true } },
      invariants: ['same existing statistical core/policy', 'SELLER OWN_STORES personas_master@0.1', 'MODEL COMPANY modelos_master_v01@0.1', 'full monthly P1 history from 2021-01', 'fixed canonical identity contract/version', 'unresolved or missing P1 coverage yields UNKNOWN', 'explicit zero retained separately from missing observation without inventing activity'],
      output: ['state','reason','dimension','member_id','member_label','observed_sales','observation_state','period','cutoff','policy','original_deterioration','improvement_episode','coverage','statistical_evidence','evidence'],
    },
    executor: { executor_id: 'p2.closed_period_sales_performance', executor_version: '0.1.0', execute: executeClosedPeriodSalesPerformance },
  },
  {
    unit_id: 'p2.closed_period_store_performance', contract_version: '0.1.0', status: 'ACTIVE',
    semantic_contract: {
      analyzes: 'Desempeño de una tienda SALES en un mes calendario cerrado, conservando el deterioro original y aplicando la mejora espejo aprobada.',
      requires_evidence: ['Un dataset P1 STORE mensual completo por mes desde 2021-01 hasta cutoff_month; referencias history_YYYY_MM compartidas entre tiendas.'],
      produces_knowledge: ['IMPROVING, STABLE, DETERIORATING o UNKNOWN, motivo y evidencia estadística.', 'Estado original, episodios, cobertura y trazabilidad de cada mes.'],
      supports_claims: ['Clasificación operativa bajo la política fija y la evidencia P1 suministrada.'],
      does_not_support: ['Significancia inferencial.', 'Riesgo de meses abiertos.', 'Vendedores, dealers, modelos, FORUM o RVM.', 'Actividad de tiendas con ventas cero sin evidencia independiente.', 'Paridad de adquisición RAW/identidades con el runtime legacy.'],
      assumptions: ['P1 certifica ventas reconocidas e identidades canónicas al cierre de cada mes.', 'La mejora usa simetría operativa aprobada, no un contraste de hipótesis.'],
    },
    deterministic_contract: {
      evidence_slots: [{ slot_pattern: 'history_YYYY_MM', cardinality: 'ONE_PER_MONTH', authority: 'P1_CERTIFIED', shape: 'DIMENSIONAL_QUANTITATIVE_DATASET', dimension: 'STORE' }],
      parameters: { cutoff_month: { type: 'CLOSED_MONTH', required: true }, store_id: { type: 'CANONICAL_STORE_ID', required: true } },
      invariants: ['SALES VIN_SALES OWN_STORES only', 'canonical sucursales_master', 'full calendar-month cutoffs', 'history starts 2021-01', 'no missing P1 months for evaluation', 'no zero fill', 'original deterioration unchanged and has precedence', 'two adjacent evaluable months for STABLE or IMPROVING'],
      output: ['state','reason','period','cutoff','store_id','observed_sales','policy','original_deterioration','improvement_episode','statistical_evidence','evidence','coverage'],
    },
    executor: { executor_id: 'p2.closed_period_store_performance', executor_version: '0.1.0', execute: executeClosedPeriodStorePerformance },
  },
  {
    unit_id:'p2.pricing_window_sales',contract_version:'0.2.0',status:'ACTIVE',
    semantic_contract:{analyzes:'VIN vendidos certificados dentro de ventanas de condición comercial publicada, por versión canónica.',
      requires_evidence:['PRICING P1 COMMERCIAL_CONDITION_WINDOWS.','SALES P1 SALES_WINDOW_OBSERVATIONS producido por sales_observe_windows con la misma evidencia PRICING.'],
      produces_knowledge:['Ventanas, VIN vendidos, días de vigencia y VIN/día.','Duración y tasa observadas explícitas para ventanas abiertas o parciales.','Comparación determinista con la ventana cronológicamente anterior de la misma versión dentro de la evidencia y el mismo scope, con aceleración/desaceleración de VIN/día.'],
      supports_claims:['Cuántas ventas reconocidas con versión resuelta coinciden temporalmente con cada ventana.'],
      does_not_support:['Atribución de ventas a una condición comercial coexistente.','Sumar ventas de ventanas superpuestas.','Precio efectivamente pagado.','Elasticidad, causalidad o predicción.','Asignar ventas con versión no resuelta.','Reconstruir o comparar una ventana anterior fuera de la evidencia/período observado.','Elegir arbitrariamente entre predecesores coexistentes o superpuestos.'],
      assumptions:['PRICING conserva precios y vigencia publicados.','SALES conserva fecha_factura, LAST, corte y clasificación comercial certificados.']},
    deterministic_contract:{evidence_slots:[
      {slot:'pricing',cardinality:'ONE',authority:'P1_CERTIFIED',shape:'COMMERCIAL_CONDITION_WINDOWS'},
      {slot:'sales',cardinality:'ONE',authority:'P1_CERTIFIED',shape:'SALES_WINDOW_OBSERVATIONS'}],parameters:{metrics_scope:{allowed:['INTERSECTION','FULL_EPISODE'],required:false,default:'sales.temporal.metrics_scope',constraint:'must match certified SALES evidence'}},
      invariants:['same canonical version_id','sales references exact pricing evidence','inclusive observed bounds','scope parameter must match SALES evidence','INTERSECTION days/VIN/rate use observed intersection; FULL_EPISODE rate requires full closed episode','previous same-version window must be unambiguous and non-overlapping'],
      output:['windows','metrics_scope','cutoff','commercial_universe','method','comparison_coverage']},
    executor:{executor_id:'p2.pricing_window_sales',executor_version:'0.2.0',execute:executePricingWindowSales},
  },

  {
    unit_id:'p2.forum_snapshot_transitions',contract_version:'0.1.0',status:'ACTIVE',
    semantic_contract:{analyzes:'Transiciones de estado realmente observadas entre dos snapshots diarios certificados de operaciones Forum.',requires_evidence:['Dos snapshots P1 OPERATION_STATES del mismo universo, con comparison posterior a baseline.'],produces_knowledge:['Matriz observada estado origen -> estado destino.','Operaciones que permanecen o cambian de estado.','Entrantes y operaciones ausentes entre snapshots como cobertura, no como transiciones.'],supports_claims:['Qué transiciones de estado fueron observadas para las mismas numero_operacion presentes en ambos snapshots.','Cuántas operaciones cambiaron o permanecieron en el mismo estado.'],does_not_support:['Estados intermedios entre snapshots.','Transiciones en días sin snapshot.','Que una operación ausente haya cambiado de estado.','Causalidad.','Reconstrucción retrospectiva anterior al primer snapshot.'],assumptions:['numero_operacion identifica establemente la operación Forum.','Cada snapshot P1 contiene como máximo un estado COTIZACION por operación.']},
    deterministic_contract:{evidence_slots:[{slot:'baseline',cardinality:'ONE',authority:'P1_CERTIFIED',shape:'OPERATION_STATE_SNAPSHOT',compatibility_group:'FORUM_SNAPSHOT_TRANSITION'},{slot:'comparison',cardinality:'ONE',authority:'P1_CERTIFIED',shape:'OPERATION_STATE_SNAPSHOT',compatibility_group:'FORUM_SNAPSHOT_TRANSITION'}],parameters:{},invariants:['same certified universe filters','comparison snapshot later than baseline','exact operation identity join','missing operations reported, never inferred'],output:['baseline_snapshot','comparison_snapshot','elapsed_days','totals','transitions','coverage','method']},
    executor:{executor_id:'p2.forum_snapshot_transitions',executor_version:'0.1.0',execute:executeForumSnapshotTransitions},
  },
  {
    unit_id:'p2.open_period_deterioration_risk',contract_version:'0.1.0',status:'ACTIVE',
    semantic_contract:{analyzes:'El riesgo empírico de que una tienda termine el mes abierto en estado DETERIORATING bajo la regla certificada histórica.',requires_evidence:['Ventas P1 acumuladas de la tienda al cutoff.','Historia P1 cerrada de la misma tienda con observaciones intrames.'],produces_knowledge:['Probabilidad empírica de terminar DETERIORATING.','Estado del último mes cerrado.','Distribución de cierres implícitos.','Señal ADVERSE del mes abierto y umbral exacto de cierre para dejar de ser adverso.','Rango de cierres que activan o mantienen deterioro.'],supports_claims:['Qué proporción de escenarios históricos de completion al mismo día terminaría el mes bajo la regla moving_average_12 + historical_percentile + deepening_2.'],does_not_support:['Que la tienda esté actualmente DETERIORATING antes del cierre.','Causalidad.','Garantía de deterioro.','Una definición distinta de la regla certificada.'],assumptions:['La completion histórica de la misma tienda al mismo día es informativa para el cierre del mes abierto.','La regla certificada de deterioro para meses cerrados se mantiene fija al evaluar cada escenario de cierre.']},
    deterministic_contract:{evidence_slots:[{slot:'observed_to_cutoff',cardinality:'ONE',authority:'P1_CERTIFIED',shape:'CUMULATIVE_PERIOD_OBSERVATION',compatibility_group:'OPEN_PERIOD_DETERIORATION'},{slot:'model_history',cardinality:'ONE',authority:'P1_CERTIFIED',shape:'HISTORICAL_PERIOD_SERIES',compatibility_group:'OPEN_PERIOD_DETERIORATION'}],parameters:{cutoff:{type:'DATE',required:false,default:'observed_to_cutoff.temporal.cutoff'}},invariants:['same store','same target period','OWN_STORES VIN evidence','closed historical periods','fixed certified rule moving_average_12 + historical_percentile + deepening_2'],output:['prior_closed_state','open_period_adverse_signal','deterioration_risk_probability','deterioration_risk_percent','scenario_count','implied_close_distribution','deterioration_close_range','method','coverage']},
    executor:{executor_id:'p2.open_period_deterioration_risk',executor_version:'0.1.0',execute:executeOpenPeriodDeteriorationRisk},
  },
  {
    unit_id:'p2.forum_funnel_performance',contract_version:'0.1.0',status:'ACTIVE',
    semantic_contract:{analyzes:'Conversión comercial observada de una cohorte de cotizaciones Forum por una dimensión fuente.',requires_evidence:['Cuatro datasets P1 de la misma cohorte y dimensión: CURSADA certificada, APROBADA sin Curse, SOLICITUD CADUCADA sin Curse y RECHAZADA sin Curse.'],produces_knowledge:['Conversión observada por miembro.','Volumen convertido y no convertido.','Mix de APROBADA, CADUCADA y RECHAZADA.'],supports_claims:['Dónde difiere la conversión observada dentro de una misma cohorte de cotizaciones y definición de outcome.','Qué proporción del outcome evaluable de una misma cohorte ya tiene Curse certificado.'],does_not_support:['Causalidad.','Que SOLICITUD CADUCADA haya sido previamente APROBADA sin snapshots históricos.','Motivo de rechazo.','Comparabilidad automática entre cohortes con distinta madurez.','Reconstruir cómo estaba una cohorte en un día histórico sin un snapshot OPERATION_STATES exacto para ese día.','Usar esta conversión de cohorte como sustituto de CURSES del mes, UFIS del mes o penetración UFI.','Comparar COHORT_CONVERTED directamente con UFIS como si compartieran el mismo universo temporal.'],assumptions:['La cohorte comparada comparte la misma ventana de fecha_cotizacion.','CURSADA es éxito observado; APROBADA, SOLICITUD CADUCADA y RECHAZADA sin Curse son no conversión comercial bajo la definición CIDEF.','Para un mes cerrado, el análisis de cierre usa el mes calendario completo; un corte al mismo día entre meses es sólo benchmark intrames explícito.','CURSES y UFIS pertenecen al período de fecha_curse y pueden incluir operaciones cotizadas en meses anteriores.']},
    deterministic_contract:{evidence_slots:[{slot:'converted',cardinality:'ONE',authority:'P1_CERTIFIED',shape:'DIMENSIONAL_QUANTITATIVE_DATASET',compatibility_group:'FORUM_FUNNEL_COHORT'},{slot:'approved',cardinality:'ONE',authority:'P1_CERTIFIED',shape:'DIMENSIONAL_QUANTITATIVE_DATASET',compatibility_group:'FORUM_FUNNEL_COHORT'},{slot:'expired',cardinality:'ONE',authority:'P1_CERTIFIED',shape:'DIMENSIONAL_QUANTITATIVE_DATASET',compatibility_group:'FORUM_FUNNEL_COHORT'},{slot:'rejected',cardinality:'ONE',authority:'P1_CERTIFIED',shape:'DIMENSIONAL_QUANTITATIVE_DATASET',compatibility_group:'FORUM_FUNNEL_COHORT'}],parameters:{},invariants:['same quotation cohort','same dimension','same universe','same grain','four mutually exclusive declared outcome buckets'],output:['totals','members','conversion_rate','non_conversion_mix','coverage']},
    executor:{executor_id:'p2.forum_funnel_performance',executor_version:'0.1.0',execute:executeForumFunnelPerformance},
  },
  {
    unit_id:'p2.target_attainment_probability',contract_version:'0.1.0',status:'ACTIVE',
    semantic_contract:{analyzes:'La probabilidad empírica de que una tienda alcance su meta mensual dado su avance al cutoff.',requires_evidence:['Ventas P1 acumuladas de la tienda al cutoff.','Meta oficial P1 de la misma tienda y mes.','Historia P1 cerrada de la misma tienda.'],produces_knowledge:['Probabilidad empírica de alcanzar la meta.','Distribución de cierres implícitos por escenarios históricos.'],supports_claims:['Qué proporción de escenarios históricos de completion al mismo día implica un cierre igual o superior a la meta oficial.'],does_not_support:['Causalidad.','Garantía de cumplimiento.','Probabilidad paramétrica fuera de la distribución histórica observada.'],assumptions:['La distribución histórica de completion de la misma tienda al mismo día es informativa para el mes objetivo.']},
    deterministic_contract:{evidence_slots:[{slot:'observed_to_cutoff',cardinality:'ONE',authority:'P1_CERTIFIED',shape:'CUMULATIVE_PERIOD_OBSERVATION',compatibility_group:'STORE_TARGET_ATTAINMENT'},{slot:'target',cardinality:'ONE',authority:'P1_CERTIFIED',shape:'REFERENCE_OBSERVATION',compatibility_group:'STORE_TARGET_ATTAINMENT'},{slot:'model_history',cardinality:'ONE',authority:'P1_CERTIFIED',shape:'HISTORICAL_PERIOD_SERIES',compatibility_group:'STORE_TARGET_ATTAINMENT'}],parameters:{cutoff:{type:'DATE',required:false,default:'observed_to_cutoff.temporal.cutoff'}},invariants:['same store','same target period','OWN_STORES VIN evidence','closed historical periods'],output:['attainment_probability','attainment_probability_percent','implied_close_distribution','scenario_count','method','coverage']},
    executor:{executor_id:'p2.target_attainment_probability',executor_version:'0.1.0',execute:executeTargetAttainmentProbability},
  },
  {
    unit_id:'p2.reconciled_seller_target_contribution',contract_version:'0.1.0',status:'ACTIVE',
    semantic_contract:{analyzes:'El aporte requerido y observado de vendedores activos/evaluables para que la tienda siga una trayectoria reconciliada con su meta oficial.',requires_evidence:['Ventas P1 por vendedor al cutoff.','Historia P1 de contribución de cinco meses cerrados para vendedores activos.','Meta oficial P1 de tienda.','Historia P1 de completion de la tienda.'],produces_knowledge:['Peso esperado normalizado por vendedor.','Aporte objetivo mensual.','Aporte esperado al cutoff.','Cumplimiento y brecha al cutoff.','Reconciliación con la meta de tienda.'],supports_claims:['Qué vendedores están por encima o debajo de su aporte esperado al cutoff bajo el modelo declarado.'],does_not_support:['Que un vendedor cause el incumplimiento de la tienda.','Evaluación de calidad personal.','Que el peso histórico sea una cuota comercial oficial.'],assumptions:['El promedio de share de tienda de los cinco meses cerrados previos es informativo para distribuir la meta.','Los pesos se normalizan sólo entre vendedores activos y evaluables.','La completion histórica de tienda al mismo día es informativa para el avance requerido al cutoff.']},
    deterministic_contract:{evidence_slots:[{slot:'seller_observed_to_cutoff',cardinality:'ONE',authority:'P1_CERTIFIED',shape:'DIMENSIONAL_QUANTITATIVE_DATASET',compatibility_group:'SELLER_TARGET_CONTRIBUTION'},{slot:'seller_history',cardinality:'ONE',authority:'P1_CERTIFIED',shape:'SELLER_CONTRIBUTION_HISTORY',compatibility_group:'SELLER_TARGET_CONTRIBUTION'},{slot:'store_target',cardinality:'ONE',authority:'P1_CERTIFIED',shape:'REFERENCE_OBSERVATION',compatibility_group:'SELLER_TARGET_CONTRIBUTION'},{slot:'store_completion_history',cardinality:'ONE',authority:'P1_CERTIFIED',shape:'HISTORICAL_PERIOD_SERIES',compatibility_group:'SELLER_TARGET_CONTRIBUTION'}],parameters:{},invariants:['same store','same target period','five closed comparable months per evaluable seller','normalized weights sum to one','seller targets reconcile to store target','cutoff expectations reconcile to target times learned completion'],output:['sellers','reconciliation','learned_completion','expected_store_progress_to_cutoff','method']},
    executor:{executor_id:'p2.reconciled_seller_target_contribution',executor_version:'0.1.0',execute:executeReconciledSellerTargetContribution},
  },
  {
    unit_id: 'p2.reference_deviation',
    contract_version: '0.1.0',
    status: 'ACTIVE',
    semantic_contract: {
      analyzes: 'La desviación cuantitativa de un valor observado respecto de una referencia explícita certificada.',
      requires_evidence: ['Una observación P1 certificada.', 'Una referencia explícita P1 certificada para el mismo período, universo, dimensión y unidad.'],
      produces_knowledge: ['Valor observado.', 'Valor de referencia.', 'Desviación absoluta.', 'Desviación relativa cuando la referencia es distinta de cero.'],
      supports_claims: ['Cuánto está el observado por encima, por debajo o exactamente en la referencia explícita.'],
      does_not_support: ['Si la referencia es adecuada.', 'Causalidad.', 'Pronóstico futuro.', 'Evaluación de desempeño sin una regla normativa adicional.'],
      assumptions: ['La referencia representa un objetivo explícito y no una expectativa estadística.'],
    },
    deterministic_contract: {
      evidence_slots: [
        { slot: 'observed', cardinality: 'ONE', authority: 'P1_CERTIFIED', shape: 'CUMULATIVE_PERIOD_OBSERVATION', compatibility_group: 'REFERENCE_DEVIATION' },
        { slot: 'reference', cardinality: 'ONE', authority: 'P1_CERTIFIED', shape: 'REFERENCE_OBSERVATION', compatibility_group: 'REFERENCE_DEVIATION' },
      ],
      parameters: {},
      invariants: ['same unit','same universe','same dimensions','same period'],
      output: ['observed_value','reference_value','absolute_deviation','relative_deviation','relative_deviation_status','direction','reference_type','reference_source'],
    },
    executor: { executor_id: 'p2.reference_deviation', executor_version: '0.1.0', execute: executeReferenceDeviation },
  },

  {
    unit_id:'p2.proportion_across_periods',contract_version:'0.1.0',status:'ACTIVE',
    semantic_contract:{analyzes:'Evolución temporal de una proporción observada entre una parte certificada y su universo certificado.',requires_evidence:['Dos series P1 certificadas y temporalmente alineadas de la misma medida y universo base.'],produces_knowledge:['Parte, universo, proporción y porcentaje por período.','Cobertura temporal y gaps.'],supports_claims:['Cómo evolucionó una proporción observada a través de períodos comparables.'],does_not_support:['Causalidad.','Evaluación bueno/malo.','Proyección futura.'],assumptions:['Mismos períodos y universo contenedor.']},
    deterministic_contract:{evidence_slots:[{slot:'part_series',cardinality:'ONE',authority:'P1_CERTIFIED',shape:'PERIOD_OBSERVATION_SERIES',compatibility_group:'PROPORTION_SERIES'},{slot:'universe_series',cardinality:'ONE',authority:'P1_CERTIFIED',shape:'PERIOD_OBSERVATION_SERIES',compatibility_group:'PROPORTION_SERIES'}],parameters:{},invariants:['same measure','same grain','same temporal scope','same certified universe','universe dimensions subset of part dimensions','same periods','non-negative values','part <= universe','report gaps'],output:['observations','coverage']},
    executor:{executor_id:'p2.proportion_across_periods',executor_version:'0.1.0',execute:executeProportionAcrossPeriods},
  },
  {
    unit_id: 'p2.observed_pair_delta',
    contract_version: '0.1.0',
    status: 'ACTIVE',
    semantic_contract: {
      analyzes: 'La diferencia cuantitativa entre dos estados observados y comparables de una misma medida.',
      requires_evidence: ['Dos observaciones P1 certificadas de la misma medida, unidad, grain lógico y universo comparable, con roles baseline y comparison ya resueltos.'],
      produces_knowledge: ['Valor baseline.', 'Valor comparison.', 'Diferencia absoluta.', 'Diferencia relativa cuando baseline es distinto de cero.'],
      supports_claims: ['La medida aumentó, disminuyó o permaneció igual entre los dos estados.', 'La magnitud absoluta del cambio.', 'La magnitud relativa del cambio cuando el denominador es válido.'],
      does_not_support: ['La causa del cambio.', 'Qué componentes explican el cambio.', 'Una proyección futura.', 'Si el cambio es bueno o malo.'],
      assumptions: ['Baseline y comparison son comparables bajo la misma definición de medida y universo.', 'La diferencia entre estados ya está expresada en la evidencia; P2 no decide qué estados comparar.'],
    },
    deterministic_contract: {
      evidence_slots: [
        { slot: 'baseline', cardinality: 'ONE', authority: 'P1_CERTIFIED', shape: 'QUANTITATIVE_OBSERVATION', compatibility_group: 'PAIR' },
        { slot: 'comparison', cardinality: 'ONE', authority: 'P1_CERTIFIED', shape: 'QUANTITATIVE_OBSERVATION', compatibility_group: 'PAIR' },
      ],
      parameters: {},
      output: ['baseline_value','comparison_value','absolute_delta','relative_delta','relative_delta_status','direction'],
    },
    executor: { executor_id: 'p2.observed_pair_delta', executor_version: '0.1.0', execute: executeObservedPairDelta },
  },
  {
    unit_id: 'p2.part_to_universe_ratio',
    contract_version: '0.1.0',
    status: 'ACTIVE',
    semantic_contract: {
      analyzes: 'La proporción cuantitativa observada de una parte certificada respecto de su universo certificado.',
      requires_evidence: ['Dos observaciones P1 certificadas de la misma medida, grain, período y universo base: una parte y su universo contenedor.'],
      produces_knowledge: ['Valor de la parte.', 'Valor del universo.', 'Proporción parte/universo.', 'Porcentaje equivalente.'],
      supports_claims: ['Qué proporción observada representa la parte dentro del universo certificado.'],
      does_not_support: ['La causa de la proporción.', 'Si la proporción es buena o mala.', 'Una evolución temporal.', 'Una proyección futura.', 'Que dos universos incompatibles sean comparables.'],
      assumptions: ['La evidencia universe representa un conjunto contenedor de part bajo la misma autoridad factual.', 'Las dimensiones del universo son iguales o menos restrictivas que las de la parte.'],
    },
    deterministic_contract: {
      evidence_slots: [
        { slot: 'part', cardinality: 'ONE', authority: 'P1_CERTIFIED', shape: 'QUANTITATIVE_OBSERVATION', compatibility_group: 'PART_UNIVERSE' },
        { slot: 'universe', cardinality: 'ONE', authority: 'P1_CERTIFIED', shape: 'QUANTITATIVE_OBSERVATION', compatibility_group: 'PART_UNIVERSE' },
      ],
      parameters: {},
      invariants: ['same measure','same grain','same temporal scope','same certified universe','universe dimensions are a subset of part dimensions','non-negative values','part does not exceed universe'],
      output: ['part_value','universe_value','ratio','percentage','ratio_status'],
    },
    executor: { executor_id: 'p2.part_to_universe_ratio', executor_version: '0.1.0', execute: executePartToUniverseRatio },
  },
  {
    unit_id: 'p2.observed_sequence',
    contract_version: '0.1.0',
    status: 'ACTIVE',
    semantic_contract: {
      analyzes: 'El comportamiento cuantitativo observado de una misma medida a través de una secuencia temporal comparable.',
      requires_evidence: ['Una serie P1 certificada de al menos dos observaciones comparables, con identidad temporal explícita.'],
      produces_knowledge: ['Secuencia observada ordenada.', 'Movimientos absolutos y relativos entre observaciones adyacentes.', 'Cobertura temporal y gaps observables.'],
      supports_claims: ['Cómo se movió la medida entre períodos observados.', 'La magnitud y dirección de cada movimiento adyacente.', 'Si existen discontinuidades en la cobertura temporal.'],
      does_not_support: ['Una predicción futura.', 'La causa de los movimientos.', 'Un diagnóstico comercial.', 'Que el patrón observado continuará.', 'Si el resultado es bueno o malo.'],
      assumptions: ['Las observaciones pertenecen a la misma medida, universo, grain lógico y dimensiones salvo el período temporal.'],
    },
    deterministic_contract: {
      evidence_slots: [
        { slot: 'sequence', cardinality: 'ONE', authority: 'P1_CERTIFIED', shape: 'PERIOD_OBSERVATION_SERIES', compatibility_group: 'OBSERVED_SEQUENCE' },
      ],
      parameters: {},
      invariants: ['at least two observations','period identities are unique and orderable','values are finite','gaps are reported rather than silently filled'],
      output: ['observations','movements','coverage'],
    },
    executor: { executor_id: 'p2.observed_sequence', executor_version: '0.1.0', execute: executeObservedSequence },
  },
  {
    unit_id: 'p2.period_close_estimate',
    contract_version: '0.1.0',
    status: 'ACTIVE',
    semantic_contract: {
      analyzes: 'Una condición aún no observada al cierre de un período a partir de evidencia parcial y un modelo explícito.',
      requires_evidence: ['Observación P1 certificada acumulada al cutoff.', 'Calendario P1 certificado del período.', 'Historia P1 certificada de períodos cerrados exigida por el modelo.'],
      produces_knowledge: ['Estimación de cierre producida por el modelo.', 'Completion histórica aprendida al mismo día del período y cobertura de entrenamiento.'],
      supports_claims: ['El modelo estima un valor de cierre bajo el cutoff, evidencia y versión declarados.'],
      does_not_support: ['Que el valor estimado ocurrirá efectivamente.', 'Causalidad.', 'Aplicabilidad a grains o universos no soportados por el modelo.'],
      assumptions: ['La evidencia satisface los requisitos del modelo y el cutoff pertenece al período estimado.', 'La mediana de completion histórica al mismo día es informativa para el período objetivo.'],
    },
    deterministic_contract: {
      evidence_slots: [
        { slot: 'observed_to_cutoff', cardinality: 'ONE', authority: 'P1_CERTIFIED', shape: 'CUMULATIVE_PERIOD_OBSERVATION', compatibility_group: 'PERIOD_CLOSE' },
        { slot: 'period_calendar', cardinality: 'ONE', authority: 'P1_CERTIFIED', shape: 'PERIOD_CALENDAR', compatibility_group: 'PERIOD_CLOSE' },
        { slot: 'model_history', cardinality: 'ONE', authority: 'P1_CERTIFIED', shape: 'HISTORICAL_PERIOD_SERIES', compatibility_group: 'PERIOD_CLOSE', history_policy: 'E06_V0_1_HISTORY', history_start_month: '2021-01' },
      ],
      parameters: { cutoff: { type: 'DATE', required: false, default: 'observed_to_cutoff.temporal.cutoff' } },
      invariants: ['cutoff belongs to certified period calendar','OWN_STORES universe only','VIN_SALES measure only','history contains closed periods only','history policy is E06_V0_1_HISTORY starting 2021-01','historical completion at cutoff day is evaluable'],
      output: ['observed_value','cutoff','estimated_close','model_components','model_assumptions','coverage'],
    },
    executor: { executor_id: 'p2.period_close_estimate', executor_version: '0.1.0', execute: executePeriodCloseEstimate },
  },
  {
    unit_id: 'p2.reconciled_dimension_delta',
    contract_version: '0.1.0',
    status: 'ACTIVE',
    semantic_contract: {
      analyzes: 'Cómo se distribuye aritméticamente el cambio total de una medida entre miembros de una dimensión canónica.',
      requires_evidence: ['Dos estados P1 certificados y comparables de la misma medida, desagregados por la misma dimensión canónica y con cobertura explícita.'],
      produces_knowledge: ['Cambio total.', 'Cambio por miembro.', 'Participación aritmética de cada miembro en el cambio total cuando el denominador es válido.', 'Reconciliación entre suma de componentes y cambio total.'],
      supports_claims: ['Cuánto aportó aritméticamente cada miembro al cambio total observado.', 'Si la descomposición reconcilia con el cambio total bajo la cobertura certificada.'],
      does_not_support: ['Que un miembro causó el cambio.', 'Por qué cambió un miembro.', 'Responsabilidad o mérito.', 'Qué acción debería tomarse.'],
      assumptions: ['La dimensión tiene identidad canónica compatible en ambos estados.', 'La cobertura permite comparar y reconciliar ambos estados.'],
    },
    deterministic_contract: {
      evidence_slots: [
        { slot: 'baseline_by_member', cardinality: 'ONE', authority: 'P1_CERTIFIED', shape: 'DIMENSIONAL_QUANTITATIVE_DATASET', compatibility_group: 'DIMENSION_DELTA' },
        { slot: 'comparison_by_member', cardinality: 'ONE', authority: 'P1_CERTIFIED', shape: 'DIMENSIONAL_QUANTITATIVE_DATASET', compatibility_group: 'DIMENSION_DELTA' },
      ],
      parameters: { missing_member_policy: { allowed: ['ZERO_FILL'], default: 'ZERO_FILL' } },
      output: ['baseline_total','comparison_total','total_delta','members','reconciliation','coverage'],
    },
    executor: { executor_id: 'p2.reconciled_dimension_delta', executor_version: '0.1.0', execute: executeReconciledDimensionDelta },
  },
];

function publicUnit(unit, full=false) {
  const base={unit_id:unit.unit_id,contract_version:unit.contract_version,status:unit.status,semantic_contract:unit.semantic_contract};
  if(!full) return base;
  return {...base,deterministic_contract:unit.deterministic_contract,executor:{executor_id:unit.executor.executor_id,executor_version:unit.executor.executor_version}};
}
export function discoverP2Units(){return {protocol:'P2_DISCOVERY_V0.1',units:units.filter(x=>x.status==='ACTIVE').map(x=>publicUnit(x))};}
export function describeP2Unit(unitId, version=null){
  const unit=units.find(x=>x.unit_id===unitId && (!version||x.contract_version===version));
  if(!unit){const e=new Error(version?'VERSION_NOT_FOUND':'UNKNOWN_UNIT');e.code=version?'VERSION_NOT_FOUND':'UNKNOWN_UNIT';throw e;}
  if(unit.status!=='ACTIVE'){const e=new Error('UNIT_DISABLED');e.code='UNIT_DISABLED';throw e;}
  return publicUnit(unit,true);
}
export function resolveP2Unit(unitId,version=null){describeP2Unit(unitId,version);return units.find(x=>x.unit_id===unitId&&(!version||x.contract_version===version));}

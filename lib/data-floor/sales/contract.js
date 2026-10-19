export const DATA_SOURCE = 'SALES';
export const CERTIFIER_VERSION = '0.13';
export const PERIOD_CLOSE_HISTORY_POLICY_V01 = Object.freeze({ policy_id:'E06_V0_1_HISTORY', start_month:'2021-01' });

export const FILTERS = Object.freeze([
  'commercial_universe','date_from','date_to','brand_id','model_id','version_id',
  'store_id','dealer_id','dealer_group_id','seller_id','color'
]);
export const FIELDS = Object.freeze([
  'vin','sale_date','invoice','operation','brand_id','model_id','version_id',
  'store_id','store_label','dealer_id','dealer_group_id','seller_id','color','financial_entity'
]);
export const MEASURES = Object.freeze({
  VIN_SALES: Object.freeze({
    id:'VIN_SALES',unit:'VIN',aggregation:'COUNT_RECOGNIZED_SALE',
    meaning:'Count of certified recognized sales in the filtered SALES universe.'
  })
});

export const DIMENSIONS = Object.freeze({
  MODEL:Object.freeze({field:'model_id',identity_contract:'modelos_master_v01',identity_version:'0.1'}),
  STORE:Object.freeze({field:'store_id',label_field:'store_label',identity_contract:'sucursales_master',identity_version:'0.1'}),
  SELLER:Object.freeze({field:'seller_id',label_field:'seller_label',identity_contract:'personas_master',identity_version:'0.1'}),
  FINANCIAL_ENTITY:Object.freeze({field:'financial_entity',identity_contract:'ventas_raw.entidad_financiera',identity_version:'0.1'}),
  NETWORK:Object.freeze({identity_contract:'ventas_raw.categoria_cliente',identity_version:'0.1'}),
});

export function describeSales(){
  return {
    source:DATA_SOURCE,version:CERTIFIER_VERSION,meaning:'Certified recognized CIDEF sales facts.',
    grain:'one recognized sale; non-null VIN uses LAST fecha_factura inside cutoff',
    date_semantics:{sale_date:'fecha_factura',cutoff:'applied before VIN recognition'},
    filters:FILTERS,fields:FIELDS,measures:Object.values(MEASURES),
    dimensions:Object.keys(DIMENSIONS),
    semantic_constraints:[
      'Use data_observe for one certified SALES observation. When the same question needs multiple compatible SALES observations sharing the same explicit period, cutoff and commercial_universe, use sales_observe_many instead of repeated data_observe calls so they share one Certified Fact Set.',
      'For a network split use evidence_shape DIMENSIONAL_QUANTITATIVE_DATASET and dimension NETWORK. Set period YYYY-MM at the top level, or date_from/date_to in filters; do not combine both date forms.',
      'NETWORK reads ventas_raw.categoria_cliente of the certified recognized source row: Cliente General -> TIENDA_PROPIA; Concesionaria -> DEALER. Missing or unknown categories remain UNRESOLVED.',
      'FINANCIAL_ENTITY preserves ventas_raw.entidad_financiera from the same source row as each SALES-recognized VIN; it does not change recognition. Blank or missing values remain UNRESOLVED. For the financing split, exact FORUM (case/space-insensitive) is UFI executed; other resolved source entities are Otros créditos. Use sales_observe_many STORE_FINANCIAL_ENTITY to reconcile this split by store against STORE and TOTAL at one explicit cutoff.',
      'NETWORK is an observation dimension, not a fetch field or a filter. For one network-by-brand or network-by-model observation, use data_observe with NETWORK plus the corresponding brand_id or model_id filter. For several compatible SALES observations in one question, use sales_observe_many when its supported operation set covers them. BRAND is not a standalone data_observe SALES dimension.',
      'version_id filters the canonical versiones_master_v01 identity shared with PRICING. Model-only or conflicting aliases leave version unresolved; they are never allocated to a version.',
      'For certified PRICING windows use sales_observe_windows with pricing_evidence_id, explicit cutoff and metrics_scope. It loads SALES once and recognizes once per distinct effective end; selection follows recognition.',
      'Resolve brand names with data_resolve BRAND; MODEL observations return canonical member ids and labels for models with sales. An absent model does not resolve its identity. Do not infer NETWORK from store_id, dealer_id or commercial_universe.',
    ],
    operations:['DESCRIBE','INSPECT','FETCH','OBSERVE','OBSERVE_MANY'],
    evidence_shapes:['QUANTITATIVE_OBSERVATION','CUMULATIVE_PERIOD_OBSERVATION','PERIOD_CALENDAR','HISTORICAL_PERIOD_SERIES','PERIOD_OBSERVATION_SERIES','DIMENSIONAL_QUANTITATIVE_DATASET','SELLER_CONTRIBUTION_HISTORY'],
    boolean_logic:'AND between filters; OR within array values',
    lineage:{universe:'ventas_universe_v01',raw_source:'ventas_raw',financial_entity:{source:'ventas_raw.entidad_financiera',join_key:'recognized source row'},vehicle_attributes:{color:'vehiculo_canonico.color_raw',source:'vehiculos_raw.color',join_key:'VIN'},organizational_labels:{store_label:'sucursales_master.nombre_canonico',join_key:'sucursal_id'}},
  };
}

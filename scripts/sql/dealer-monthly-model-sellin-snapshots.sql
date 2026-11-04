-- Histórico mensual por dealer, marca y modelo, sin modificar el snapshot agregado existente.
CREATE TABLE IF NOT EXISTS dealer_monthly_model_sellin_snapshots (
  period text NOT NULL CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  dealer_group_id bigint NOT NULL,
  brand_id bigint NOT NULL,
  model_id bigint NOT NULL,
  vin_sales integer NOT NULL CHECK (vin_sales >= 0),
  cutoff_date date NOT NULL,
  sales_evidence_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (period, dealer_group_id, brand_id, model_id)
);

-- dealer_stock_available_v01: almacenamiento de stock estimado por VIN.
-- NO poblar desde RAW directamente: alimentar solo desde SALES P1 + RVM P1
-- con corte y evidencia; el procedimiento de recarga se implementa tras
-- validar cobertura de VIN RVM, notas de credito y traspasos entre dealers.
CREATE TABLE IF NOT EXISTS dealer_stock_available_v01 (
  vin text PRIMARY KEY,
  dealer_id bigint NOT NULL REFERENCES dealers_master(dealer_id),
  dealer_group_id bigint,
  brand_id text,
  model_id bigint,
  version_id bigint,
  sell_in_date date NOT NULL,
  sell_in_invoice text,
  rvm_registration_date date,
  stock_status text NOT NULL CHECK (stock_status IN ('AVAILABLE','REVIEW')),
  sales_cutoff date NOT NULL,
  rvm_cutoff date NOT NULL,
  p3_run_id text,
  refreshed_at timestamptz NOT NULL DEFAULT now(),
  CHECK (length(vin) = 17)
);
CREATE INDEX IF NOT EXISTS dealer_stock_available_v01_dealer_idx
  ON dealer_stock_available_v01 (dealer_id, stock_status);
COMMENT ON TABLE dealer_stock_available_v01 IS
  'Stock dealer estimado, una fila por VIN, derivado exclusivamente de sell-in SALES P1 y ANAC RVM P1. No equivale a inventario fisico confirmado.';

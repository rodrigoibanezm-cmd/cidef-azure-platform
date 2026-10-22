-- Snapshot mensual sell-in DEALERS, generado desde SALES P1 certificado.
-- Una fila por dealer canónico y mes; el frontend solo consulta esta tabla.
CREATE TABLE IF NOT EXISTS dealer_monthly_sellin_snapshots (
  period text NOT NULL CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  dealer_group_id bigint NOT NULL,
  foton_units integer NOT NULL CHECK (foton_units >= 0),
  dongfeng_units integer NOT NULL CHECK (dongfeng_units >= 0),
  total_units integer GENERATED ALWAYS AS (foton_units + dongfeng_units) STORED,
  cutoff_date date NOT NULL,
  sales_evidence_id text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (period, dealer_group_id)
);

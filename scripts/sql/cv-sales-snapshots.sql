-- First domain only. Shared by production and staging; historical cutoffs are retained.
CREATE TABLE IF NOT EXISTS cv_sales_snapshots (
  period text NOT NULL CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  cutoff_date date NOT NULL,
  scope text NOT NULL DEFAULT 'COMPANY' CHECK (scope = 'COMPANY'),
  source_signature text NOT NULL,
  engine_signature text NOT NULL,
  payload jsonb NOT NULL,
  p3_run_id text NOT NULL,
  generated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (period, cutoff_date, scope)
);

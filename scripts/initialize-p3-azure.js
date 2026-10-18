import { closeAzurePool, getAzurePool } from '../lib/azure-postgres.js';

if (!process.env.AZURE_DATABASE_URL) {
  throw new Error('Missing required secret: AZURE_DATABASE_URL in GitHub Environment Production.');
}

const statements = [
  `CREATE TABLE IF NOT EXISTS p3_runs (
    run_id text PRIMARY KEY,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  'ALTER TABLE p3_runs ADD COLUMN IF NOT EXISTS parent_run_id text REFERENCES p3_runs(run_id)',
  'ALTER TABLE p3_runs ADD COLUMN IF NOT EXISTS floor text',
  `CREATE TABLE IF NOT EXISTS p3_events (
    event_id uuid PRIMARY KEY,
    run_id text NOT NULL REFERENCES p3_runs(run_id),
    sequence_no bigserial,
    tool_name text NOT NULL,
    status text NOT NULL,
    input_fingerprint text NOT NULL,
    output_fingerprint text,
    input_json jsonb NOT NULL,
    output_json jsonb,
    error_code text,
    duration_ms integer,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  'ALTER TABLE p3_events ADD COLUMN IF NOT EXISTS floor text',
  'CREATE INDEX IF NOT EXISTS p3_events_run_idx ON p3_events(run_id,sequence_no)',
  'CREATE INDEX IF NOT EXISTS p3_runs_parent_idx ON p3_runs(parent_run_id,created_at)',
];

let client;
try {
  client = await getAzurePool().connect();
  for (const statement of statements) {
    await client.query(statement);
  }
  console.log(JSON.stringify({
    initialization: 'PASS',
    procedure: 'copied from cidef-data-loader/lib/p3/executionJournal.js',
    statements: statements.length,
  }));
} finally {
  client?.release();
  await closeAzurePool();
}

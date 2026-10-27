-- Read-only metadata audit. Does NOT certify historical business validity.
-- Execute only against the existing Azure database; never against Neon as a
-- substitute for Azure evidence. No DDL, data updates, loads or new tables.
BEGIN READ ONLY;

SELECT table_schema, table_name, ordinal_position, column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN ('dealer_groups', 'dealers_master', 'dealer_aliases',
                     'dealer_supervisor', 'sucursales_master', 'vehiculo_canonico')
ORDER BY table_name, ordinal_position;

-- Discover an existing effective-date/history authority, if present.
-- Column names alone are NOT proof of coverage, nonoverlap or business validity.
SELECT table_schema, table_name, column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name ~* '(dealer|grupo|membership|organization)'
  AND column_name ~* '(valid_from|valid_to|effective|vigencia|vigente|period|history|version|created_at|updated_at)'
ORDER BY table_name, ordinal_position;

SELECT rel.relname AS table_name, con.conname, con.contype,
       pg_get_constraintdef(con.oid) AS constraint_definition
FROM pg_catalog.pg_constraint con
JOIN pg_catalog.pg_class rel ON rel.oid = con.conrelid
JOIN pg_catalog.pg_namespace ns ON ns.oid = rel.relnamespace
WHERE ns.nspname = 'public'
  AND rel.relname IN ('dealer_groups', 'dealers_master', 'dealer_aliases',
                      'dealer_supervisor', 'sucursales_master', 'vehiculo_canonico')
ORDER BY rel.relname, con.conname;

-- created_at/updated_at are technical timestamps. dealer_supervisor dates concern
-- supervisor assignments. Neither is a dealer-to-group validity certificate.
ROLLBACK;

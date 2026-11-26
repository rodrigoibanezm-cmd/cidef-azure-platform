-- Explicit commercial succession; preserves physical vehicle identity and historical prices.
-- Decision CIDEF 2026-11-26, first successor-only list dated 2026-04-02.
BEGIN;
CREATE TABLE IF NOT EXISTS public.price_version_successors_v01 (
  version_id bigint PRIMARY KEY REFERENCES public.versiones_master_v01(version_id),
  successor_version_id bigint NOT NULL REFERENCES public.versiones_master_v01(version_id),
  effective_from date NOT NULL,
  reason text NOT NULL,
  CHECK (version_id <> successor_version_id)
);
INSERT INTO public.price_version_successors_v01
  (version_id, successor_version_id, effective_from, reason)
VALUES
  (12052,12053,DATE '2026-04-02','CIDEF: TM3 S/C descontinuado; lista 02-04-2026'),
  (12054,12055,DATE '2026-04-02','CIDEF: TM3 D/C descontinuado; lista 02-04-2026')
ON CONFLICT (version_id) DO NOTHING;
DO $verify$
BEGIN
  IF (SELECT count(*) FROM public.price_version_successors_v01
      WHERE (version_id,successor_version_id,effective_from) IN
      ((12052,12053,DATE '2026-04-02'),(12054,12055,DATE '2026-04-02'))) <> 2
  THEN RAISE EXCEPTION 'Conflicting commercial succession'; END IF;
END $verify$;
COMMIT;

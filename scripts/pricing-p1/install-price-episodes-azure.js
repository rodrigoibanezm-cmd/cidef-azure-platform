import { closeAzurePool, getAzurePool } from '../../lib/azure-postgres.js';
import { priceEpisodeCanonicalizerV01 } from '../pricing/price-episode-canonicalizer-v01.js';

const pool = getAzurePool();
const exists = (await pool.query(`
  SELECT to_regclass('public.price_episode_canonico_v01') AS episodes,
         to_regclass('public.price_episode_vin_v01') AS vins
`)).rows[0];
const hasEpisodes = Boolean(exists.episodes);
const hasVins = Boolean(exists.vins);
if (hasEpisodes !== hasVins) {
  throw new Error('PRICING_P1_PARTIAL_SCHEMA: expected both price episode tables to exist or neither');
}

let installed = false;
if (!hasEpisodes) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      CREATE TABLE public.price_episode_canonico_v01 (
        price_episode_id bigserial CONSTRAINT price_episode_canonico_v01_pkey PRIMARY KEY,
        version_id bigint NOT NULL CONSTRAINT price_episode_canonico_v01_version_id_fkey REFERENCES public.versiones_master_v01(version_id),
        price_version_id bigint NOT NULL CONSTRAINT price_episode_canonico_v01_price_version_id_fkey REFERENCES public.price_versions(price_version_id),
        vigencia_desde date NOT NULL,
        vigencia_hasta date,
        precio_neto bigint,
        precio_lista bigint,
        precio_con_iva bigint,
        bono_cidef bigint,
        bono_forum bigint,
        bono_mes bigint,
        delta_precio_neto bigint,
        delta_precio_lista bigint,
        delta_precio_con_iva bigint,
        delta_bono_cidef bigint,
        delta_bono_forum bigint,
        delta_bono_mes bigint,
        tipo_cambio text NOT NULL DEFAULT 'INITIAL' CONSTRAINT price_episode_canonico_v01_change_ck CHECK (tipo_cambio = ANY (ARRAY['INITIAL','NO_CHANGE','PRECIO','BONO','PRECIO_Y_BONO','SOURCE_CONFLICT']::text[])),
        source_status text NOT NULL CONSTRAINT price_episode_canonico_v01_status_ck CHECK (source_status = ANY (ARRAY['OK','SOURCE_CONFLICT']::text[])),
        source_rows integer NOT NULL DEFAULT 0,
        source_variant_count integer NOT NULL DEFAULT 1,
        source_files text[] NOT NULL DEFAULT '{}'::text[],
        vin_facturados_en_vigencia integer NOT NULL DEFAULT 0,
        primer_vin_fecha date,
        ultimo_vin_fecha date,
        canonicalized_at timestamptz NOT NULL DEFAULT now(),
        precio_efectivo_pre_mes_sin_iva bigint,
        precio_efectivo_pre_mes_con_iva bigint,
        precio_efectivo_final_sin_iva bigint,
        precio_efectivo_final_con_iva bigint,
        delta_precio_efectivo_pre_mes_sin_iva bigint,
        delta_precio_efectivo_pre_mes_con_iva bigint,
        delta_precio_efectivo_final_sin_iva bigint,
        delta_precio_efectivo_final_con_iva bigint,
        commercial_condition_id text NOT NULL,
        quality_flags text[] NOT NULL DEFAULT '{}'::text[],
        CONSTRAINT price_episode_canonico_v01_dates_ck CHECK (vigencia_hasta IS NULL OR vigencia_hasta >= vigencia_desde),
        CONSTRAINT price_episode_canonico_v01_grain_uk UNIQUE (price_version_id, vigencia_desde, commercial_condition_id)
      );
      CREATE INDEX price_episode_canonico_v01_condition_dates_idx ON public.price_episode_canonico_v01 USING btree (version_id, commercial_condition_id, vigencia_desde, vigencia_hasta);
      CREATE INDEX price_episode_canonico_v01_price_version_dates_idx ON public.price_episode_canonico_v01 USING btree (price_version_id, vigencia_desde, vigencia_hasta);
      CREATE INDEX price_episode_canonico_v01_version_dates_idx ON public.price_episode_canonico_v01 USING btree (version_id, vigencia_desde, vigencia_hasta);

      CREATE TABLE public.price_episode_vin_v01 (
        price_episode_id bigint NOT NULL CONSTRAINT price_episode_vin_v01_price_episode_id_fkey REFERENCES public.price_episode_canonico_v01(price_episode_id) ON DELETE CASCADE,
        vehiculo_id bigint NOT NULL CONSTRAINT price_episode_vin_v01_vehiculo_id_fkey REFERENCES public.vehiculo_canonico(vehiculo_id),
        vin text NOT NULL,
        version_id bigint NOT NULL CONSTRAINT price_episode_vin_v01_version_id_fkey REFERENCES public.versiones_master_v01(version_id),
        fecha_factura date NOT NULL,
        numero_factura text,
        canonicalized_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT price_episode_vin_v01_pkey PRIMARY KEY (price_episode_id, vehiculo_id),
        CONSTRAINT price_episode_vin_v01_vehicle_uk UNIQUE (vehiculo_id)
      );
      CREATE INDEX price_episode_vin_v01_version_date_idx ON public.price_episode_vin_v01 USING btree (version_id, fecha_factura);
    `);
    await client.query('COMMIT');
    installed = true;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

try {
  const canonicalization = installed
    ? await priceEpisodeCanonicalizerV01({ dry_run: false })
    : { skipped: 'tables_already_exist' };
  console.log(JSON.stringify({
    engine: 'PRICING P1 Azure schema installer',
    tables: ['price_episode_canonico_v01', 'price_episode_vin_v01'],
    installed,
    canonicalization,
  }, null, 2));
} finally {
  await closeAzurePool();
}

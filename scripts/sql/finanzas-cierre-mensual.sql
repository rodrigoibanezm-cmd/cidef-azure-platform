-- Fuente contable original; independiente de SALES/P1/P2/P3.
CREATE TABLE IF NOT EXISTS finanzas_cierre_archivos (
  periodo text PRIMARY KEY CHECK (periodo ~ '^20[0-9]{2}-(0[1-9]|1[0-2])$'),
  blob_path text NOT NULL,
  blob_etag text NOT NULL,
  sha256 text NOT NULL,
  archivo_bytes bigint NOT NULL,
  hojas integer NOT NULL,
  actualizado_en timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS finanzas_cierre_hojas (
  periodo text NOT NULL REFERENCES finanzas_cierre_archivos(periodo),
  orden_hoja integer NOT NULL,
  nombre_hoja text NOT NULL,
  rango text,
  celdas jsonb NOT NULL,
  PRIMARY KEY (periodo, orden_hoja)
);

-- Movimientos contables normalizados; el RAW anterior permanece intacto.
CREATE TABLE IF NOT EXISTS finanzas_ventas (
  periodo text NOT NULL REFERENCES finanzas_cierre_archivos(periodo),
  fila_excel integer NOT NULL,
  empresa text NOT NULL,
  tipo_documento text NOT NULL CHECK (tipo_documento IN ('FAC-EL', 'N/C-EL')),
  numero_documento text NOT NULL,
  fecha_documento date NOT NULL,
  rut text,
  vin text NOT NULL,
  marca text NOT NULL CHECK (marca IN ('DFM', 'DFLM', 'FOTON')),
  cantidad integer NOT NULL CHECK (cantidad IN (-1, 1)),
  factura text,
  modelo text,
  sucursal text,
  neto numeric,
  iva numeric,
  total numeric,
  PRIMARY KEY (periodo, fila_excel)
);

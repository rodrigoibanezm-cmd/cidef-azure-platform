# Azure pricing update

- Commit: 3941f30f439893d1ae14c76954a422426a90da0e
- Azure login: success
- Blob source step: success
- Runtime dependencies: success
- Source file: LISTA DE PRECIOS OCTUBRE 14-10-2026.xlsb
- Blob selection error: none
- Import exit code: 0
- Neon parity exit code: 1

## Import summary
~~~json
(node:2258) Warning: SECURITY WARNING: The SSL modes 'prefer', 'require', and 'verify-ca' are treated as aliases for 'verify-full'.
In the next major version (pg-connection-string v3.0.0 and pg v9.0.0), these modes will adopt standard libpq semantics, which have weaker security guarantees.

To prepare for this change:
- If you want the current behavior, explicitly use 'sslmode=verify-full'
- If you want libpq compatibility now, use 'uselibpqcompat=true&sslmode=require'

See https://www.postgresql.org/docs/current/libpq-ssl.html for libpq SSL mode definitions.
(Use `node --trace-warnings ...` to show where the warning was created)
{
  "stage": "price_history_import_committed",
  "source_file": "LISTA DE PRECIOS OCTUBRE 14-10-2026.xlsb",
  "vigencia": "2026-10-14",
  "pricing_present_before": {
    "history_rows": 64,
    "versions": 64,
    "source_rows": 64,
    "dongfeng_007_008": [
      {
        "modelo": "007",
        "version": "007 Automática",
        "precio_lista": "27890000",
        "bono_forum": "900000",
        "precio_efectivo_final_sin_iva": "23990000",
        "source_sheet": "DONGFENG ELÉCTRICOS",
        "source_row": 7
      },
      {
        "modelo": "008",
        "version": "008 Automática",
        "precio_lista": "32590000",
        "bono_forum": "1000000",
        "precio_efectivo_final_sin_iva": "28990000",
        "source_sheet": "DONGFENG ELÉCTRICOS",
        "source_row": 8
      }
    ]
  },
  "pricing_after_import": {
    "history_rows": 64,
    "versions": 64,
    "source_rows": 64,
    "dongfeng_007_008": [
      {
        "modelo": "007",
        "version": "007 Automática",
        "precio_lista": "27890000",
        "bono_forum": "900000",
        "precio_efectivo_final_sin_iva": "23990000",
        "source_sheet": "DONGFENG ELÉCTRICOS",
        "source_row": 7
      },
      {
        "modelo": "008",
        "version": "008 Automática",
        "precio_lista": "32590000",
        "bono_forum": "1000000",
        "precio_efectivo_final_sin_iva": "28990000",
        "source_sheet": "DONGFENG ELÉCTRICOS",
        "source_row": 8
      }
    ]
  },
  "rows_staged": 117,
  "rows_normalized": 64,
  "price_versions_touched": 64,
  "price_history_inserted": 0
}
{
  "engine": "Azure append-only pricing import",
  "source_file": "LISTA DE PRECIOS OCTUBRE 14-10-2026.xlsb",
  "operational_vigencia": "2026-10-14",
  "pricing_present_before": {
    "history_rows": 64,
    "versions": 64,
    "source_rows": 64,
    "dongfeng_007_008": [
      {
        "modelo": "007",
        "version": "007 Automática",
        "precio_lista": "27890000",
        "bono_forum": "900000",
        "precio_efectivo_final_sin_iva": "23990000",
        "source_sheet": "DONGFENG ELÉCTRICOS",
        "source_row": 7
      },
      {
        "modelo": "008",
        "version": "008 Automática",
        "precio_lista": "32590000",
        "bono_forum": "1000000",
        "precio_efectivo_final_sin_iva": "28990000",
        "source_sheet": "DONGFENG ELÉCTRICOS",
        "source_row": 8
      }
    ]
  },
  "rows_staged": 117,
  "rows_normalized": 64,
  "price_versions_touched": 64,
  "price_history_inserted": 0,
  "masters_added": {
    "brands": 0,
    "models": 0,
    "versions": 0,
    "aliases": 0
  },
  "canonical_version_reuses": [
    {
      "marca": "FOTON",
      "modelo": "MIDI",
      "received": "CABINA SIMPLE 1.2 Euro VI",
      "canonical": "CABINA SIMPLE 1.2 EURO VI",
      "version_id": "12048"
    },
    {
      "marca": "FOTON",
      "modelo": "MIDI",
      "received": "CABINA DOBLE 1.2 Euro VI",
      "canonical": "CABINA DOBLE 1.2 EURO VI",
      "version_id": "12049"
    },
    {
      "marca": "FOTON",
      "modelo": "MIDI",
      "received": "MIDI CARGO BOX REF 1.2 Euro VI",
      "canonical": "MIDI CARGO BOX REF 1.2 EURO VI",
      "version_id": "3028"
    },
    {
      "marca": "FOTON",
      "modelo": "TM3",
      "received": "CABINA SIMPLE 1.6 Euro VI 2 AirBag",
      "canonical": "CABINA SIMPLE 1.6 EURO VI 2 AIRBAG",
      "version_id": "12053"
    },
    {
      "marca": "FOTON",
      "modelo": "TM3",
      "received": "CABINA DOBLE 1.6 Euro VI 2 AirBag",
      "canonical": "CABINA DOBLE 1.6 EURO VI 2 AIRBAG",
      "version_id": "12055"
    },
    {
      "marca": "FOTON",
      "modelo": "TM5",
      "received": "CABINA SIMPLE 1.6 Euro VI",
      "canonical": "CABINA SIMPLE 1.6 EURO VI",
      "version_id": "12109"
    },
    {
      "marca": "FOTON",
      "modelo": "TM5",
      "received": "CABINA DOBLE 1.6 Euro VI",
      "canonical": "CABINA DOBLE 1.6 EURO VI",
      "version_id": "12110"
    },
    {
      "marca": "FOTON",
      "modelo": "FT",
      "received": "FT CREW PASAJEROS Euro",
      "canonical": "FT CREW PASAJEROS EURO",
      "version_id": "12065"
    },
    {
      "marca": "FOTON",
      "modelo": "G7 LITE",
      "received": "4X2 EURO VI",
      "canonical": "LITE 4X2 EURO VI",
      "version_id": "12066"
    },
    {
      "marca": "FOTON",
      "modelo": "G7 LITE",
      "received": "4X4 EURO VI",
      "canonical": "LITE 4X4 EURO VI",
      "version_id": "12067"
    },
    {
      "marca": "FOTON",
      "modelo": "G7 ULTIMATE",
      "received": "4X2 EURO VI",
      "canonical": "ULTIMATE 4X2 EURO VI",
      "version_id": "12068"
    },
    {
      "marca": "FOTON",
      "modelo": "G7 ULTIMATE",
      "received": "4X4 EURO VI",
      "canonical": "ULTIMATE 4X4 EURO VI",
      "version_id": "12069"
    },
    {
      "marca": "FOTON",
      "modelo": "G7 ULTIMATE AT",
      "received": "4X4 EURO VI AT",
      "canonical": "ULTIMATE AT 4X4 EURO VI",
      "version_id": "12070"
    },
    {
      "marca": "FOTON",
      "modelo": "VIEW GRAND",
      "received": "VIEW GRAND CARGO L2H1 (Techo bajo) MT",
      "canonical": "VIEW GRAND CARGO L2H1 (TECHO BAJO) MT",
      "version_id": "12079"
    },
    {
      "marca": "FOTON",
      "modelo": "VIEW GRAND",
      "received": "VIEW GRAND CARGO L2H2 (Techo alto) MT",
      "canonical": "VIEW GRAND CARGO L2H2 (TECHO ALTO) MT",
      "version_id": "12080"
    },
    {
      "marca": "FOTON",
      "modelo": "VIEW GRAND",
      "received": "VIEW GRAND CARGO L2H2 (Techo alto) AT",
      "canonical": "VIEW GRAND CARGO L2H2 (TECHO ALTO) AT",
      "version_id": "12081"
    },
    {
      "marca": "DONGFENG",
      "modelo": "T5",
      "received": "T5 1.6 Euro VI",
      "canonical": "T5 1.6 EURO VI",
      "version_id": "12090"
    },
    {
      "marca": "DONGFENG",
      "modelo": "T5L",
      "received": "T5 L 1.5 TURBO Euro VI",
      "canonical": "T5 L 1.5 TURBO EURO VI",
      "version_id": "12093"
    },
    {
      "marca": "DONGFENG",
      "modelo": "T5L",
      "received": "T5 L 1.8 TURBO Euro VI",
      "canonical": "T5 L 1.8 TURBO EURO VI",
      "version_id": "12091"
    },
    {
      "marca": "DONGFENG",
      "modelo": "T5L",
      "received": "T5 L 1.5 AT Euro VI",
      "canonical": "T5 L 1.5 AT EURO VI",
      "version_id": "12092"
    },
    {
      "marca": "DONGFENG",
      "modelo": "T5 EVO",
      "received": "T5 EVO 1.5 TURBO MT LUXURY Euro VI",
      "canonical": "T5 EVO 1.5 TURBO MT LUXURY EURO VI",
      "version_id": "12097"
    },
    {
      "marca": "DONGFENG",
      "modelo": "T5 EVO",
      "received": "T5 EVO 1.5 TURBO LUXURY Euro VI",
      "canonical": "T5 EVO 1.5 TURBO LUXURY EURO VI",
      "version_id": "12094"
    },
    {
      "marca": "DONGFENG",
      "modelo": "T5 EVO",
      "received": "T5 EVO 1.5 TURBO NOBLE Euro VI",
      "canonical": "T5 EVO 1.5 TURBO NOBLE EURO VI",
      "version_id": "12095"
    },
    {
      "marca": "DONGFENG",
      "modelo": "RICH 6 MT",
      "received": "RICH 6 MT 4X2 Euro VI",
      "canonical": "RICH 6 MT 4X2 EURO VI",
      "version_id": "12104"
    },
    {
      "marca": "DONGFENG",
      "modelo": "RICH 6 MT",
      "received": "RICH 6 MT 4X4 Euro VI",
      "canonical": "RICH 6 MT 4X4 EURO VI",
      "version_id": "12105"
    },
    {
      "marca": "DONGFENG",
      "modelo": "RICH 6 MT",
      "received": "RICH 6 AT 4X4 Euro VI",
      "canonical": "RICH 6 AT 4X4 EURO VI",
      "version_id": "12106"
    },
    {
      "marca": "DONGFENG",
      "modelo": "MAGE EV",
      "received": "MAGE EV Automática",
      "canonical": "MAGE EV",
      "version_id": "406"
    },
    {
      "marca": "DONGFENG",
      "modelo": "S50EVE",
      "received": "S50EVE Automática",
      "canonical": "S50 EV",
      "version_id": "9906"
    },
    {
      "marca": "FOTON",
      "modelo": "G7 EV",
      "received": "G7 EV Automática",
      "canonical": "G7 EV 4X2",
      "version_id": "12078"
    }
  ],
  "alias_corrections": [],
  "dongfeng_products": [
    {
      "marca": "DONGFENG",
      "modelo": "007",
      "version": "007 Automática",
      "marca_id": "71",
      "modelo_id": "859",
      "version_id": "12164"
    },
    {
      "marca": "DONGFENG",
      "modelo": "008",
      "version": "008 Automática",
      "marca_id": "71",
      "modelo_id": "860",
      "version_id": "12165"
    }
  ],
  "audit": {
    "blockingRejectedRows": 0,
    "rowsWithoutDeclaredVigencia": 0
  }
}
{
  "engine": "Neon-compatible price episode canonicalizer",
  "phase": "price_episode_canonicalizer_v01",
  "version": "0.3",
  "dry_run": true,
  "price_versions": {
    "total": 83,
    "resolved": 82,
    "excluded": 1,
    "unresolved": 0
  },
  "state_points": {
    "total": 3282,
    "clean": 3282,
    "coexisting_conditions": 24
  },
  "episodes": {
    "total": 899,
    "clean": 899,
    "coexisting_conditions": 24
  },
  "vin_assignment": {
    "eligible": 0,
    "assigned": 0,
    "unassigned": 0,
    "ambiguous": 0
  },
  "provenance": {
    "price_version_id_semantics": "REPRESENTATIVE_TECHNICAL_ORIGIN_OF_EPISODE",
    "multi_price_version_episodes": 12,
    "quality_exception_episodes": 7,
    "sample": [
      {
        "version_id": 3028,
        "vigencia_desde": "2024-08-01",
        "price_version_id": 4,
        "price_version_ids": [
          4,
          61
        ]
      },
      {
        "version_id": 9906,
        "vigencia_desde": "2025-11-04",
        "price_version_id": 76,
        "price_version_ids": [
          56,
          76
        ]
      },
      {
        "version_id": 11744,
        "vigencia_desde": "2025-02-05",
        "price_version_id": 9,
        "price_version_ids": [
          9,
          62
        ]
      },
      {
        "version_id": 11781,
        "vigencia_desde": "2024-10-04",
        "price_version_id": 10,
        "price_version_ids": [
          10,
          63
        ]
      },
      {
        "version_id": 12048,
        "vigencia_desde": "2025-06-05",
        "price_version_id": 1,
        "price_version_ids": [
          1,
          58
        ]
      },
      {
        "version_id": 12049,
        "vigencia_desde": "2026-04-02",
        "price_version_id": 59,
        "price_version_ids": [
          2,
          59
        ]
      },
      {
        "version_id": 12050,
        "vigencia_desde": "2024-11-06",
        "price_version_id": 3,
        "price_version_ids": [
          3,
          60
        ]
      },
      {
        "version_id": 12058,
        "vigencia_desde": "2026-04-02",
        "price_version_id": 66,
        "price_version_ids": [
          13,
          66
        ]
      },
      {
        "version_id": 12083,
        "vigencia_desde": "2026-07-02",
        "price_version_id": 70,
        "price_version_ids": [
          70,
          72
        ]
      },
      {
        "version_id": 12085,
        "vigencia_desde": "2026-07-02",
        "price_version_id": 71,
        "price_version_ids": [
          71,
          73
        ]
      }
    ]
  },
  "unresolved_price_version_ids": [],
  "ambiguous_vehicle_sample": [],
  "materialization": {
    "status": "blocked_missing_tables",
    "missing": [
      "public.price_episode_vin_v01",
      "public.price_episode_canonico_v01"
    ]
  }
}
~~~

# Tasks

- [x] `MachineRun` + colección `machine_runs` + índice único (`company_id`, `source`, `external_id`).
- [x] `POST /api/admin/machine_runs/ingest` (admin, validación de tiempos y tamaños, upsert; `updated` sólo si cambió).
- [x] Liga por número de parte / código de proyecto al leer (`PartIndex`), pruebas unitarias.
- [x] `GET /api/admin/projects/{id}/machine_time` y `GET /api/admin/machine_runs` (`view_projects`).
- [x] Rutas en `src/main.rs`, `tests/common/harness.rs` y `src/openapi.rs`.
- [x] Prueba HTTP: staff no escribe, upsert idempotente, ambigua/no encontrada, otra empresa no ve nada.
- [x] Solid: resumen y columna "Máquina (real)" en el detalle del proyecto.
- [ ] Conector `tools/sp-mcp` y spcli: agregar las dos rutas de lectura al catálogo.
- [ ] Página de corridas sin parte en el ERP (`status=not_found|ambiguous`).
- [ ] Revisión con Daniel; merge a `main` (despliega solo).

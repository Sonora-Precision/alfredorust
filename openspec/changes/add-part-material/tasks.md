# Tareas

## Corte 1 — Material por número de parte

- [ ] `PartMaterial` en `ProjectConcept` (serde default) + `material_status` derivado en el DTO de partes.
- [ ] `POST /api/admin/project_concepts/{id}/material` (sólo `manage_production_board` / admin).
- [ ] Seguimiento: material, tocho y estado por parte; edición para el admin.
- [ ] (ops) Importar las 43 partes de `Cantidades_Vulcan_Doublemint_v2.xlsx` con vista previa y confirmación de Daniel.

## Corte 2 — Recepción de factura

- [ ] `MaterialReceipt` + colección `material_receipts` + índice por empresa.
- [ ] Lector de conceptos (fracciones, decimales, material, forma, piezas) con pruebas unitarias.
- [ ] `POST /api/production/material_receipts` desde CFDI (UUID) o renglones; `GET` lista y detalle con sugerencias y resumen por parte.
- [ ] `POST …/{id}/lines/{line}/assign`.
- [ ] SPA "Material recibido": crear desde CFDI, ver cruce ✅🟡🔴⚪ y asignar barras.
- [ ] (ops) Cargar la factura F86241 de HG Aceros con confirmación de Daniel.
- [ ] Pruebas HTTP de los escenarios.

## Corte 3 — Lista de cortes (Daniel, 2026-11-03: "procede")

- [x] `GET /api/production/cut_list` (barras asignadas, cortes y sobrante; barra compartida por orden de asignación) y `POST …/{id}/done` ("Material habilitado").
- [x] Página "Lista de cortes" con filtros por material, plano y "Corte terminado".
- [ ] Mandar cada corte a la fila de la Sierra cinta.

## Corte 4 (propuesto)
- [ ] Retazos.

# Tareas

## Corte 1 — Material por número de parte

- [x] `PartMaterial` en `ProjectConcept` (serde default) + `material_status` derivado en el DTO de partes.
- [x] `POST /api/admin/project_concepts/{id}/material` (sólo `manage_production_board` / admin).
- [x] Seguimiento: material, tocho y estado por parte; edición para el admin.
- [x] (ops) Importar las 43 partes de `Cantidades_Vulcan_Doublemint_v2.xlsx` con vista previa y confirmación de Daniel.

## Corte 2 — Recepción de factura

- [x] `MaterialReceipt` + colección `material_receipts` + índice por empresa.
- [x] Lector de conceptos (fracciones, decimales, material, forma, piezas) con pruebas unitarias.
- [x] `POST /api/production/material_receipts` desde CFDI (UUID) o renglones; `GET` lista y detalle con sugerencias y resumen por parte.
- [x] `POST …/{id}/lines/{line}/assign`.
- [x] SPA "Material recibido": crear desde CFDI, ver cruce ✅🟡🔴⚪ y asignar barras.
- [x] (ops) Cargar la factura F86241 de HG Aceros con confirmación de Daniel.
- [x] Pruebas HTTP de los escenarios.

## Corte 3 — Lista de cortes (Daniel, 2026-11-03: "procede")

- [x] `GET /api/production/cut_list` (barras asignadas, cortes y sobrante; barra compartida por orden de asignación) y `POST …/{id}/done` ("Material habilitado").
- [x] Página "Lista de cortes" con filtros por material, plano y "Corte terminado".
- [x] "Pasar a corte" en Seguimiento y Lista de cortes → fila de la Sierra cinta ("Corte N pz @ L""); "Corte terminado" o "Terminar trabajo" en la sierra palomean "Material habilitado" y la sacan de la fila.
- [x] Asignar una barra recibida palomea "Material"; ese ✔ cuenta como Recibido.

## Corte 4 (propuesto)
- [ ] Retazos.

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

## Corte 3 y 4 (propuestos)

- [ ] Lista de cortes → fila de la Sierra cinta; "Material habilitado" al terminar.
- [ ] Retazos.

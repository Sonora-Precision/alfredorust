# Tasks

Requiere `add-shop-floor-tracking` fase 1 (ruta de proceso, piezas terminadas,
fecha de entrega, máquina planeada) y fase 2 (perfiles). Toda ruta nueva se
registra en `src/main.rs` **y** en `tests/common/harness.rs::build_app`.

## 1. Modelo

- [ ] `work_order_number` + contador atómico por empresa; asignar al crear; migración idempotente por `created_at`.
- [ ] `WorkQueue` y `ProcessOperation.queue`; sembrar colas de `sp` (Programa → Programación CNC, Setup 1–4 → Setup, Machueleado/Rebabeado → Acabado).
- [ ] `ProjectStage.on_board` (default según inicial/terminal/cancelada).
- [ ] `ProjectConcept.sequence_rank`, `priority_override`.
- [ ] `PartStep.assignee_user_id`, `assigned_at`.
- [ ] `WorkOrderEvent` + colección `work_order_events` + índices; escribir eventos en asignar/tomar/soltar/fijar y en `…/progress` (StepDone/StepReopened con `credited_user_id`).

## 2. API

- [ ] `GET /api/production/board` (paso actual, filtro de etapas, orden de secuencia, cola de máquina por recurso, `mine`).
- [ ] `sequence` (punto medio + renumerado), `priority`.
- [ ] `assign`, `take` (atómico, 409 si ya tiene responsable), `release`.
- [ ] `GET /api/production/workload`.
- [ ] `GET /api/production/reports/weekly` (semana ISO en `America/Hermosillo`, neto de reaperturas, 4 semanas previas, CSV).
- [ ] Evento `PiecesRecorded` (delta + precio congelado) en cada cambio de `completed_quantity`.
- [ ] Valor producido = Σ delta × precio en la semana, acreditado a la persona de cada paso; sólo en sesión admin; "sin precio" no suma; sin crédito → "sin asignar".
- [ ] Permisos `view_production_board`, `take_work_orders`, `manage_production_board`, `view_production_reports`; agregarlos a perfiles sembrados.
- [ ] DTO de OT sin campos de dinero para cualquier rol.

## 3. SPA

- [ ] Página Tablero de Producción con pestañas por cola, "Mis asignaciones", arrastrar para fijar, Tomar/Soltar/Marcar terminado.
- [ ] Vista de piso (pantalla completa, consulta cada 30 s, última actualización).
- [ ] Carga por programador.
- [ ] Precio unitario obligatorio al crear/editar número de parte; aviso "OT sin precio" (admin) en Tablero y reporte.
- [ ] Reporte semanal con detalle por persona y CSV.
- [ ] Entrada en el menú y en la paleta de comandos.

## 4. Herramientas

- [ ] spcli: `production board`, `production take`, `production report --week`.
- [ ] Conector `tools/sp-mcp`: rutas nuevas en el catálogo.

## 5. Pruebas

- [ ] Paso actual: salta Done y N/A, ignora operaciones sin cola, OT lista sale del tablero.
- [ ] Orden: fijadas primero, luego Urgente > … > Baja, luego fecha, sin fecha al final.
- [ ] Arrastrar entre dos OT calcula rango intermedio; quitar fijado regresa al orden automático.
- [ ] Dos programadores toman la misma OT a la vez → uno gana, el otro 409.
- [ ] Programador sin `upload_cnc_files` no puede tomar de Programación CNC.
- [ ] Reporte: crédito al responsable; sin responsable, al que marcó; reapertura descuenta; semana en hora de Hermosillo (marca del domingo 23:30 cuenta en esa semana).
- [ ] DTO de OT no trae precio, costo, OC ni facturas para staff.
- [ ] Reporte: admin ve valor producido; staff con `view_production_reports` no lo recibe; parte sin precio no suma.
- [ ] Valor: OT terminada en dos semanas se reparte; corrección negativa resta; cambio de precio posterior no altera semanas pasadas.
- [ ] Aislamiento entre empresas en tablero, carga y reporte.

## Cierre

- [ ] `cargo test`, lint y build de `solid/`.
- [ ] Actualizar `openspec/specs/projects` y `auth`.
- [ ] `openspec validate --all`.

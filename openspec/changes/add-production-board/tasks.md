# Tasks

Requiere `add-shop-floor-tracking` fase 1 (ruta de proceso, piezas terminadas,
fecha de entrega, máquina planeada) y fase 2 (perfiles). Toda ruta nueva se
registra en `src/main.rs` **y** en `tests/common/harness.rs::build_app`.

**Entrega A (primero):** sólo Cola de Programación CNC y el perfil
Programador (José Márquez, Carlos Dávila). Las tareas de Setup, Máquina y
Acabado en la UI, y los perfiles Supervisor/Setupista, se marcan **(B)** y se
dejan para después; el modelo y la API se construyen genéricos desde A.

**Corte 1 de la entrega A (rama `feat/production-board`, 2026-11-02).** Hecho lo
marcado con [x]. Diferencias con el diseño, a propósito, mientras no existan
las piezas de `add-shop-floor-tracking`:

- Las etapas configurables (G1.4) no existen: entran al tablero los proyectos
  que no estén Entregado ni Cancelado, en lugar de `ProjectStage.on_board`.
- No hay fecha de entrega: la secuencia automática usa `scheduled_at` del
  proyecto como fecha.
- No hay perfiles: los permisos nuevos se dan uno por uno en Usuarios. Tomar
  pide `take_work_orders` (no `upload_cnc_files`, que no existe).
- Los usuarios sólo tienen correo: el tablero muestra la parte antes de la @.
- Subir/bajar con botones (↑ ↓) en vez de arrastrar; el drag llega con la
  Vista de planta.
- `workload` se llama `GET /api/production/members`; "marcar terminado" es
  `POST …/complete` (el responsable o quien gestiona el tablero).

- [ ] (A) Alta de José Márquez, Carlos Dávila y Jesús Sigala como staff de `sp` con perfil Programador (ops, con sus correos). José hecho (2026-11-02).
- [x] (A) Admins elegibles como responsables y acreditados en carga y reporte (Daniel Rivera programa).

## 1. Modelo

- [x] `work_order_number` + contador atómico por empresa; asignar al crear; migración idempotente por `created_at` (perezosa, en la primera lectura del tablero).
- [x] `WorkQueue` y `ProcessOperation.queue`. [ ] Sembrar colas de `sp` (ops, por API tras el deploy).
- [ ] `ProjectStage.on_board` (default según inicial/terminal/cancelada).
- [x] `ProjectConcept.sequence_rank`, `priority_override` (sin endpoint para el override todavía).
- [x] `PartStep.assignee_user_id`, `assigned_at`.
- [x] `WorkOrderEvent` + colección `work_order_events` + índices; escribir eventos en asignar/tomar/soltar/fijar y en `…/progress` (StepDone/StepReopened, con crédito en `subject_user_id`).

## 2. API

- [x] `GET /api/production/board` (paso actual, orden de secuencia, `mine`). [ ] Cola de máquina por recurso (B).
- [x] `sequence` (renumerado desde arriba hasta la OT movida). [ ] `priority`.
- [x] `assign`, `take` (atómico, 409 si ya tiene responsable; sólo la primera libre salvo `related_to`), `release`, `complete`.
- [x] `GET /api/production/members` (carga por persona).
- [ ] `GET /api/production/reports/weekly` (semana ISO en `America/Hermosillo`, neto de reaperturas, 4 semanas previas, CSV).
- [ ] Evento `PiecesRecorded` (delta + precio congelado) en cada cambio de `completed_quantity`.
- [ ] Valor producido = Σ delta × precio en la semana, acreditado a la persona de cada paso; sólo en sesión admin; "sin precio" no suma; sin crédito → "sin asignar".
- [x] Permisos `view_production_board`, `take_work_orders`, `manage_production_board`. [ ] `view_production_reports`; perfiles sembrados.
- [x] DTO de OT sin campos de dinero ni descripción para cualquier rol.

## 3. SPA

- [ ] (B) Pestañas de Setup, Máquina (por recurso) y Acabado.
- [x] Página Tablero de Producción (Cola de Programación): secuencia con ↑ ↓ y quitar fijado, asignar con selector, "Tu siguiente programa" con Marcar terminado/Soltar, Tomar la siguiente libre, Agrupar partes parecidas (mismo proyecto o familia de parte). Se actualiza cada 30 s. Inicio de staff con `view_production_board` = el tablero.
- [ ] Vista de piso (pantalla completa, consulta cada 30 s, última actualización).
- [x] Carga por programador (tira con color de carga, límite 5).
- [ ] Precio unitario obligatorio al crear/editar número de parte; aviso "OT sin precio" (admin) en Tablero y reporte.
- [ ] Reporte semanal con detalle por persona y CSV.
- [ ] Entrada en el menú y en la paleta de comandos.

## 3b. Vista de planta

- [x] (ops) Alta de Sierra cinta, SL-30, Mori SL-15 y Shizuoka en `sp`; borrar la "ZZD" (2026-11-02).
**Corte 2 (rama `feat/plant-view`, 2026-11-02).** El área va en cada máquina del
layout (`PlacedMachine.area`), no en `Resource`. El ámbar sale sólo del estado
manual: sin máquina planeada por OT todavía no se puede deducir de la ruta.
Una máquina sin corridas ni estado manual se ve gris, "Sin datos".

- [x] Layout de planta por empresa (`plant_layouts`: paredes, cuartos, etiquetas, máquinas con área) + `POST /api/production/plant_layout` (admin).
- [x] Semáforo: verde por corrida DNC viva (≤ 15 min), rojo desde el fin de la última corrida, estado manual si es más reciente; leyenda visible. [ ] Ámbar automático por paso de Setup.
- [x] Estado manual de máquina (`POST /api/production/machines/{id}/state`, con OT y nota opcionales).
- [x] Máquina → proyecto/OT que corre (número de parte de la corrida) → quién la programó (crédito de "Programa").
- [x] Ruta `/produccion/planta`: plano SVG, detalle de máquina, programadores con carga y "corre en…", órdenes pendientes. [ ] Metas del equipo.
- [x] Asignar arrastrando la OT sobre un programador, o con dos toques; sólo quien gestiona el tablero.
- [x] Programadores con número de programas asignados y color de carga (límite 5 fijo en la UI).
- [x] Nombre para mostrar de cada usuario (`display_name`), editable en Usuarios.
- [ ] Fila de cada programador (secuencia filtrada por sus asignaciones), con "Siguiente" arriba; el admin arrastra para subir una OT prioritaria.
- [x] Inicio del programador: tarjeta "Tu siguiente programa" (uno por uno), Marcar terminado → aparece la siguiente; sin fila → Tomar (corte 1).
- [ ] Reportar bloqueo con motivo: OT "Bloqueada" para el admin, se libera del programador (eventos `Blocked`/`Unblocked`); `POST …/block` y `…/unblock`.
- [x] Agrupar partes parecidas (corte 1: mismo proyecto o familia de parte). [ ] Por material y máquina.
- [ ] Metas semanales del equipo capturadas por el admin; sin ranking por persona.
- [x] Pruebas: semáforo con y sin corrida, estado manual más nuevo que la corrida, sin datos, programador no puede fijar estado ni layout.

**En producción y fila por máquina (§9c, entrega B, Daniel 2026-11-03).**

- [x] "En producción" manual en todas las máquinas con buscador por número de parte y etiqueta de setup; la misma OT puede correr en varias máquinas a la vez (corte 1).
- [x] El programador elige su máquina ("Correr ahora" / "Pasar a producción") y cierra con "Terminar trabajo" (`…/finish`, nota de qué terminó y quién) (corte 1).
- [ ] Aviso de desfase cuando la corrida DNC trae otra parte que la manual (se muestran las dos).
- [x] (corte 1, sin `operation_id` ni `…/urgent` todavía) `machine_queue_entries` (`operation_id?`, `label`) + API de fila (`GET/POST …/machines/{id}/queue`, `…/{entry_id}/remove`, `…/{entry_id}/urgent`, `…/advance`); sin unicidad: varias entradas de una OT en la misma máquina (Setup 1/2/3) y en varias máquinas.
- [x] (corte 1: panel de máquina con lo que corre, la fila y sus planos; "+N en fila" en el plano) Tarjeta: "Sigue en VF-3: OT-xxxx (Setup 2)" y "+N en fila"; al terminar la que corre, ofrecer "Pasar a producción" (nunca automático).
- [ ] Sugerencia suave (nunca bloquea) si el paso anterior no está ✔/N/A.
- [ ] Piezas por máquina/setup opcionales al registrar producidas (`pieces_recorded` con `resource_id`, `label`); el total, la liberación y el crédito no cambian.
- [ ] Urgente con motivo obligatorio, primero en la fila, evento `MachineQueueUrgent`, rojo en tarjeta/tablero/buscador; "Detener y correr urgente" regresa la actual a la fila.
- [ ] Tarjeta y buscador muestran todas: "corriendo en VF-3 (Setup 1) y VF-6 (Setup 1)", "En fila de VF-3: Setup 2, pos. 3".
- [ ] Permisos: `take_work_orders` o `manage_production_board` ponen en producción, agregan, ordenan, quitan y avanzan (con evento quién/cuándo); urgente y "Detener y correr urgente" sólo `manage_production_board`; Calidad sólo ve; sin dinero.
- [ ] Pruebas: los escenarios de las tres requirements nuevas.

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

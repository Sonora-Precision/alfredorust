# Diseño

Referencias de código al 2026-11-02 (commit `7109bb0` + cambios sin commitear
de `add-shop-floor-tracking`: `completed_quantity`, `PartStep`,
`ProcessOperation`).

## 0. Vocabulario

| Taller (UI) | Modelo | Colección |
|---|---|---|
| Orden de Trabajo (OT) | `ProjectConcept` + `work_order_number` | `project_concepts` |
| Cola (Programación CNC, Setup, Máquina, Acabado) | `WorkQueue` (enum) en `ProcessOperation.queue` | `process_operations` |
| Paso actual de la OT | primer `PartStep` pendiente con cola | derivado |
| Responsable del paso | `PartStep.assignee_user_id` | `project_concepts` |
| Secuencia de producción | `ProjectConcept.sequence_rank` + orden automático | `project_concepts` |
| Bitácora de la OT | `WorkOrderEvent` | **`work_order_events`** (nueva) |

## 1. Folio de OT

- `ProjectConcept.work_order_number: Option<i64>`, consecutivo por empresa con
  un contador atómico (`company_counters`, `findOneAndUpdate` + `$inc`), igual
  de seguro con altas simultáneas. Se muestra `OT-{:04}`.
- Se asigna al crear el concepto. Migración idempotente: conceptos sin folio,
  por `created_at` ascendente, por empresa.
- El folio no se reutiliza al borrar una OT.

## 2. Colas

```rust
pub enum WorkQueue { Programming, Setup, Machining, Finishing }
// ProcessOperation gana: queue: Option<WorkQueue>
```

Asignación sembrada para `sp` (editable en el catálogo):

| Operación | Cola |
|---|---|
| Material, Material habilitado | — (no generan OT; se ven en "Material pendiente") |
| Programa | Programación CNC |
| Setup 1–4 | Setup |
| Machueleado / Rimado, Rebabeado / Limpieza | Acabado |

La Cola de Máquina se arma por máquina planeada (`planned_resource_ids`,
fase 1 de `add-shop-floor-tracking`) con las OT cuyo paso actual es de Setup,
agrupadas por máquina. Así el setupista de la VF-3 ve sólo lo de la VF-3.

**Paso actual** de una OT = primera operación activa del catálogo, en orden de
posición, con `queue` definida y estado `Pending` (no `Done` ni
`NotApplicable`). Si no hay ninguna, la OT está **lista** y sale del tablero.

**Qué OT entran al tablero**: conceptos de proyectos cuya etapa tiene
`on_board = true` (nuevo campo de `ProjectStage`; por defecto `true` salvo
etapas inicial, terminal y cancelada; para `sp`: Preparación, Producción e
Inspección), con piezas pendientes (`completed_quantity < quantity`) y concepto
en un estado no cancelado.

## 3. Secuencia de producción

Orden de cada cola:

1. OT **fijadas** (`sequence_rank` presente), por `sequence_rank` ascendente.
2. El resto, automático: prioridad efectiva (Urgente > Alta > Media > Baja),
   luego fecha de entrega ascendente (sin fecha al final), luego folio.

- Prioridad efectiva = `ProjectConcept.priority_override` o, si no hay, la
  prioridad del proyecto (`ProjectPriority` ya existe).
- Arrastrar una OT en la UI manda `{ before_id | after_id }`; el servidor
  calcula un `sequence_rank` (f64, punto medio entre vecinos; renumera la cola
  cuando la diferencia baja de 1e-6). Arrastrar una OT automática la fija.
- "Quitar fijado" borra `sequence_rank` y la OT regresa a su lugar
  automático.
- La secuencia es **global por OT**, no por cola: si Daniel fija una OT
  arriba, sigue arriba en la cola siguiente. Es lo que espera el taller ("esta
  pieza va primero").

Indicadores de la tarjeta: días a la entrega (rojo vencida, ámbar ≤ 3 días),
prioridad, fijada (📌).

## 4. Asignación

```rust
// PartStep gana:
assignee_user_id: Option<ObjectId>,
assigned_at: Option<DateTime>,
```

El responsable es **por paso**: el programador queda en "Programa" y el
setupista en "Setup 1", sin pisarse. La tarjeta muestra el responsable del
paso actual.

| Acción | Quién |
|---|---|
| Asignar / reasignar / quitar | admin, o staff con `manage_production_board` |
| Tomar **cualquier** OT libre, sólo para sí | staff con `take_work_orders` |
| Soltar una OT propia | quien la tiene asignada |
| Palomear pasos y piezas terminadas | staff con `take_work_orders` (o admin) |

**Auto-asignación libre** (Daniel, 2026-11-02, reemplaza "sólo la primera
libre"): "José ya puede elegir qué números de parte va a hacer él; no va a poder
asignarle números a otro programador, sólo a él". Tomar no exige orden ni
motivo; sólo que la OT siga libre (409 si no). Cada toma queda en la bitácora
(`Taken`, quién y cuándo) para que Daniel vea quién eligió qué.

**Palomear avances** (Daniel, 2026-11-02, "Pasos y piezas"): quien tiene
`take_work_orders` marca cualquier paso de la ruta y las piezas terminadas
(`POST /project_concepts/{id}/progress`). Cada paso guarda quién y cuándo
(`updated_by`, `updated_at`), y cada cambio de piezas escribe `PiecesRecorded`
con el actor, el delta y el precio unitario congelado. El crédito en dinero de
esas piezas es para la persona de cada paso, no para quien palomea (§5). La
respuesta no trae dinero. Configurar el catálogo de pasos sigue siendo del
admin.

- **Sólo sus partes** (Daniel, 2026-11-02): el programador palomea únicamente
  los números de parte donde tiene algún paso asignado; quien gestiona el
  tablero, cualquiera.
- **Pieza terminada = pasó por todo** (Daniel, 2026-11-02): las piezas
  terminadas sólo pueden subir cuando todos los pasos activos de la parte
  están ✔ o N/A (contando el que se marque en la misma petición); bajar para
  corregir siempre se puede. Así sólo cuentan en la semana piezas que pasaron
  por todo el proceso.
- **Captura de piezas**: se escribe el total ("10,000") o un cambio ("+250",
  "−5") en vez de dar clics; se limita entre 0 y lo pedido.

**Piezas de la semana para todos** (Daniel, 2026-11-02: "cantidad de piezas, no
cantidad de dinero"; luego eligió "las de todos"): `GET
/api/production/weekly_pieces` (con `view_production_board`) da, para la semana
lunes–domingo de Hermosillo y la anterior, las piezas terminadas del equipo,
las de **cada persona** (quien programó cada parte, mismo crédito que el
reporte) y el desglose por parte de quien consulta. Nunca dinero. Esto
reemplaza "sin ranking por persona" sólo para piezas; el valor producido por
persona sigue siendo sólo del admin. En el Tablero se ve la tarjeta completa; en
la Vista de planta, el total del equipo.

**Buscador de números de parte** (Daniel, 2026-11-02): en cada pantalla donde se
asigna o se toma una OT (Tablero, órdenes pendientes de la Vista de planta,
asignaciones por programador) hay una caja que busca mientras se escribe,
parcial y sin importar mayúsculas, por número de parte o folio ("4471" →
"CH-4471-A"). `GET /api/production/search?q=` busca en **todas** las partes de la
empresa, también las que salieron del tablero, y por cada una dice quién la
trae (o "Libre"), su paso actual o "Terminada" / "Sin pasos pendientes" /
"Proyecto cerrado", la cola y su lugar en la secuencia y las piezas
terminadas/pedidas. La misma caja filtra la lista de la pantalla. Sin dinero.

**El admin ve todo lo asignado** (Daniel, 2026-11-02): el Tablero muestra a quien
gestiona la sección "Asignaciones por programador": cada persona con todas sus
OT en todas las colas (folio, parte, proyecto, paso, piezas).
`GET /api/production/members` trae esas OT completas en `orders`.

**Quién aparece como responsable posible** de una cola: los admins de la
empresa y el staff con el permiso de esa cola. En `sp` la Cola de
Programación tiene hoy a Daniel Rivera (admin), Jesús Sigala, José Márquez y
Carlos Dávila. Un admin que se asigna, toma o marca un paso recibe el crédito
igual que un programador.

Permiso por cola (cuando existan los perfiles de la fase 2): Programación CNC
requerirá `upload_cnc_files`; Setup y Máquina, `view_technical_files`. Hoy basta
`take_work_orders`. Tomar es atómico: sólo se escribe si el paso
sigue sin responsable (`assignee_user_id: null` en el filtro); si otro la tomó
primero → 409.

**Crédito del paso.** Cuando un paso pasa a `Done`, el crédito es del
responsable en ese momento; si no tenía, de quien lo marcó. Se guarda en el
evento (§5), no se recalcula después.

## 5. Bitácora y reportes

```rust
pub struct WorkOrderEvent {           // colección work_order_events, append-only
    id, company_id, concept_id, project_id,
    operation_id: Option<ObjectId>, operation_name: Option<String>,
    queue: Option<WorkQueue>,
    kind: WorkOrderEventKind,         // Assigned | Unassigned | Taken | Released |
                                      // StepDone | StepReopened | Pinned | Unpinned |
                                      // PiecesRecorded | Blocked | Unblocked
    actor_user_id: ObjectId,          // quien hizo la acción
    credited_user_id: Option<ObjectId>, // en StepDone: responsable o, si no, el actor
    pieces_delta: Option<f64>,        // en PiecesRecorded
    unit_price: Option<f64>,          // en PiecesRecorded; nunca sale a no-admin
    at: DateTime,
}
// índices: (company_id, kind, at), (company_id, concept_id, at)
```

Se escribe junto con cada cambio de asignación, fijado y estado de paso
(incluido `POST /project_concepts/{id}/progress`). Reabrir un paso (`Done` →
`Pending`) escribe `StepReopened`; el reporte descuenta el `StepDone` previo
del mismo paso, así una marca por error no infla el conteo.

**Carga por programador** — para cada usuario: OT con un paso pendiente
asignado a él, agrupadas por cola, en orden de secuencia, con días a la
entrega. También muestra las OT sin asignar de cada cola.

**Reporte semanal de producción** — semana lunes–domingo en hora de
`America/Hermosillo` (zona de la empresa). Por usuario acreditado:

- número de OT con `StepDone` neto en la semana, por cola (p. ej. "Juan: 7
  programas"),
- detalle: folio, número de parte, proyecto, cliente, piezas, fecha en que se
  terminó, y si se entregó antes o después de la fecha del proyecto,
- comparación con las 4 semanas anteriores (mini tendencia).

Filtros: semana, cola, usuario. Exportable a CSV. Visible para admin y para
staff con `view_production_reports` (por defecto, nadie más que el admin).

**Valor producido (sólo admin).** Columna extra del reporte, que se calcula y
se envía sólo cuando la sesión es admin (con `view_production_reports` sin ser
admin no aparece; regla "sólo el admin ve dinero"):

- **Por pieza, no por proyecto** (decisión de Daniel, 2026-11-02): la única
  fuente es `unit_price` del número de parte; `total_budget` y montos de OC o
  factura del proyecto nunca entran al cálculo.
- **Se cuenta al terminar piezas** (decisión de Daniel, 2026-11-02), no al
  liberar el paso. Cada cambio de `completed_quantity` escribe un evento
  `PiecesRecorded` con el delta (positivo o negativo) y el precio unitario de
  ese momento (`unit_price`, fase 1 de `add-shop-floor-tracking`).
- Valor de la semana de una OT = `Σ delta × unit_price` de sus eventos
  `PiecesRecorded` en la semana. Una OT de 100 piezas terminada en dos semanas
  reparte su valor entre ambas; corregir piezas hacia abajo resta.
- Ese valor se acredita a la persona acreditada en el paso de cada cola (el
  `credited_user_id` de su último `StepDone` neto): el programador de
  "Programa", el setupista de "Setup 1", etc. Si el paso aún no tiene crédito
  (piezas terminadas sin paso marcado), el valor queda en "sin asignar".
- Es el valor de venta del trabajo terminado en el que participó la persona,
  no su aportación exclusiva: la misma pieza suma para el programador y para el
  setupista. Por eso el reporte nunca suma colas entre sí y lo dice en la UI.
- **Cada pieza debe tener su valor** (Daniel, 2026-11-02): cada número de
  parte tiene su propio precio unitario, distinto de las demás partes del
  mismo proyecto. En la SPA el precio es **obligatorio** al crear o editar un
  número de parte (la API lo deja opcional para otros giros). Para las partes
  que ya existen sin precio, el admin ve el aviso "OT sin precio" en el
  Tablero y en el reporte, con enlace para capturarlo.
- Parte sin precio → "sin precio" y no suma. El precio se congela en el evento,
  así que cambiar el precio después no altera semanas pasadas.
- Se muestra junto a las piezas terminadas, el promedio por OT y la tendencia
  de 4 semanas.

## 6. API

Todas con aislamiento por `company_id` de la sesión.

| Método y ruta | Uso |
|---|---|
| `GET /api/production/board?queue=&resource_id=&mine=` | OT de una cola en orden de secuencia |
| `POST /api/production/work_orders/{concept_id}/sequence` | `{ before_id }`, `{ after_id }` o `{ unpin: true }` |
| `POST /api/production/work_orders/{concept_id}/priority` | `priority_override` o `null` |
| `POST /api/production/work_orders/{concept_id}/assign` | `{ operation_id, user_id \| null }` |
| `POST /api/production/work_orders/{concept_id}/take` | `{ operation_id }` |
| `POST /api/production/work_orders/{concept_id}/release` | `{ operation_id }` |
| `GET /api/production/workload` | carga por usuario |
| `GET /api/production/reports/weekly?week=2026-W45&queue=&user_id=` | reporte semanal (`format=csv`); `value` sólo para admin |

DTO de la OT (sin campos de dinero, para cualquier rol):

```json
{ "id": "…", "folio": "OT-0142", "part": "ZBL149-17", "project": "EST 17-22 USW",
  "client": "Braba Tech", "quantity": 4, "completed_quantity": 0,
  "due_date": "2026-11-08", "days_left": 6, "priority": "urgent", "pinned": true,
  "current_step": { "operation": "Programa", "queue": "programming",
                    "assignee": { "id": "…", "name": "Juan" } },
  "machines": ["VF-3"], "material": "received",
  "files": { "drawing": true, "cad": true, "cnc_program": false } }
```

`files` aparece cuando exista la fase 3 de `add-shop-floor-tracking`; antes se
omite.

## 7. Permisos nuevos

| Permiso | Habilita | Perfiles sembrados |
|---|---|---|
| `view_production_board` | ver tablero, carga y Vista de piso | Supervisor, Programador, Setupista |
| `take_work_orders` | tomar/soltar OT | Programador, Setupista |
| `manage_production_board` | secuencia, prioridad, asignar a otros | (sólo admin por defecto) |
| `view_production_reports` | reporte semanal | (sólo admin por defecto) |

Se agregan en los mismos lugares que los de la fase 2 de
`add-shop-floor-tracking` (enum, parsers, `/api/me`, `Users.tsx`).

## 8. SPA (Solid)

- Página **Tablero de Producción** (`/produccion`): pestañas por cola,
  selector de máquina en Cola de Máquina, filtro "Mis asignaciones", tarjetas
  en columna con arrastrar para quien tenga `manage_production_board`. Botones
  **Tomar** / **Soltar** / **Marcar terminado** en la tarjeta.
- **Vista de piso** (`/produccion/piso?queue=…`): pantalla completa, tema
  oscuro, letra grande, sin controles; consulta cada 30 s y muestra la hora de
  la última actualización. Para la TV se usa un usuario de taller con sólo
  `view_production_board` (no hay enlace público).
- **Carga por programador** (`/produccion/carga`) y **Reporte semanal**
  (`/produccion/reportes`) con tabla por persona, detalle desplegable y CSV.
- Listas cortas (decenas de OT): DOM normal, sin virtualizar.

## 9. Vista de planta

Daniel aprobó la maqueta el 2026-11-02. Es una ruta de la SPA
(`/produccion/planta`) que lee los mismos datos del tablero, la carga y las
corridas de máquina; no tiene modelo propio salvo el estado manual de máquina
(abajo).

**Parque de máquinas de `sp`** (todas propias; dadas de alta como `Resource`
el 2026-11-02; la "ZZD" importada de Notion se borró porque no existe):

| Área | Máquinas | Estado |
|---|---|---|
| Corte | Sierra cinta | manual |
| Tornos CNC | SL-30, Mori SL-15 | SL-30 automático; Mori SL-15 manual |
| Centros de maquinado | VF-3, VF-6, Shizuoka | automático |

El área se guarda en el recurso (`Resource.area: Option<String>`, texto libre
por empresa) para agrupar las tarjetas. La Shizuoka es un centro de maquinado
vertical, igual que las VF-3 y VF-6 (Daniel, 2026-11-02).

**Semáforo por máquina:**

| Color | Significa | Regla |
|---|---|---|
| Verde | Trabajando | hay una corrida activa en `machine_runs` (última muestra ≤ 15 min; ver `add-dnc-machine-time`), o estado manual "Trabajando" |
| Ámbar | En setup | sin corrida activa y la OT actual de esa máquina tiene un paso de Setup en curso (pendiente, con otros pasos previos hechos), o estado manual "Setup" |
| Rojo | Parada / sin trabajo | ninguna de las anteriores; la tarjeta muestra el motivo (esperando programa, material o sin OT en fila) y desde cuándo |

- Automático para las máquinas que lee taller-vision (VF-3, VF-6, SL-30,
  Shizuoka). El DNC no distingue setup de paro; el ámbar sale de la ruta de
  proceso.
- Manual para las que no tienen DNC (Mori SL-15, Sierra cinta): botón de
  estado en la tarjeta (`POST /api/production/machines/{id}/state`), guardado
  como evento con quién y cuándo. Si después se conectan a taller-vision,
  cambian a automático sin tocar la UI.
- La leyenda de colores siempre está visible en la vista.

**Tarjeta de máquina:** nombre, semáforo, OT actual (folio, parte, cliente),
barra de piezas terminadas/pedidas, OT en fila para esa máquina y tiempo de
hoy. Al hacer clic se abre la Cola de Máquina filtrada por ese recurso.

**Máquina → proyecto → persona** (Daniel, 2026-11-02): cada máquina muestra
el proyecto/cliente que corre y una etiqueta con las iniciales de **quien hizo
ese programa**; cada programador muestra "corre en VF-3, Shizuoka".

- La OT que corre sale de la corrida DNC activa (`machine_runs`: número de
  parte de la cabecera → `ProjectConcept`, ver `add-dnc-machine-time`). Para
  las máquinas sin DNC (Mori SL-15, Sierra cinta), del estado manual, que
  incluye la OT.
- El programador es el `credited_user_id` del paso "Programa" de esa OT (§4).
- Si la máquina está parada esperando el programa de su siguiente OT, la
  etiqueta va punteada con las iniciales del responsable de ese paso ("Debe:
  SL-15") y se resalta si hay otro programador libre.
- El **operador** en la máquina queda fuera hasta que existan usuarios de
  setupista/operador (entrega B); entonces se agrega con la misma etiqueta.
- **Layout real:** el plano se dibuja con la planta de `sp` (polígono de
  paredes y posición/rotación de cada máquina, guardados como datos de la
  empresa, `plant_layout`), girado para que la fila SL-15 · SL-30 · VF-3 quede
  horizontal. Lo edita el admin; primera versión tomada del modelo de
  SolidWorks que compartió Daniel.

**Órdenes pendientes y asignación:**

- La fila muestra las OT de la Cola de Programación **sin responsable**, en el
  orden de la secuencia (fijadas primero), con prioridad, máquina planeada y
  días a la entrega.
- Quien tiene `manage_production_board` asigna **arrastrando** una OT sobre un
  programador, o tocando la OT y luego a la persona (sirve en celular). Llama
  al mismo `POST …/assign` de §4 y deja el evento `Assigned`.
- Los programadores ven la misma vista, pero sólo pueden **tomar** una OT para
  sí mismos (`…/take`); no pueden soltarla sobre otra persona.
- Cada programador muestra, grande, el **número de programas asignados**
  pendientes y su OT en curso, con un **color de carga** (Daniel,
  2026-11-02):

  | Color | Carga | Regla |
  |---|---|---|
  | Ámbar | Libre | 0 asignadas: hay que darle trabajo |
  | Verde | Con trabajo | de 1 al límite − 1 |
  | Rojo | Saturado | ≥ límite (por defecto 5, lo configura el admin por empresa) |

  El color es por carga, no por actividad: no se mide si la persona está
  trabajando en este momento (no hay monitoreo de su equipo).

**Fila de cada programador** (Daniel, 2026-11-02): lo que se le asigna a
cada persona se forma en su propia fila, y la persona trabaja siempre la de
arriba ("Siguiente"). Al desplegar a un programador se ve su fila en orden.

- La fila personal es la **secuencia de producción (§3) filtrada** por sus
  asignaciones; no hay un orden aparte por persona. Una OT nueva asignada cae
  en su lugar según prioridad y fecha, o hasta abajo si las demás están
  fijadas.
- **Subir una prioridad:** el admin arrastra la OT hacia arriba dentro de la
  fila del programador (o la marca Urgente). Usa el mismo `…/sequence` con el
  vecino de esa fila, así que la OT queda fijada antes que las que rebasó y
  es igual de prioritaria en todas las vistas.
- El programador ve su fila igual, pero no la reordena; sólo el admin (o
  quien tenga `manage_production_board`).

**Uno por uno** (Daniel, 2026-11-02): la pantalla de inicio del programador
es una sola tarjeta grande, **"Tu siguiente programa"**: la primera OT de su
fila, con parte, cliente, piezas, máquina, entrega y accesos al plano y al
CAD (cuando exista la fase 3 de archivos). Abajo, en pequeño, cuántas siguen.

- **Marcar terminado** (paso "Programa" → `Done`, o subir el `.nc`) la saca de
  su fila y muestra la siguiente.
- Su fila se trabaja de arriba hacia abajo, pero puede **Tomar** cualquier OT
  libre de la cola para sí (botón en cada OT). Si está atorado, **Reportar bloqueo** con un
  motivo (falta plano, información del cliente, material…): la OT queda
  marcada "Bloqueada" para el admin, se le quita al programador (evento
  `Blocked` con el motivo) y él continúa con la siguiente. El admin la
  resuelve y la vuelve a asignar.
- Si su fila está vacía, la tarjeta dice "Sin programas asignados" y le
  ofrece **Tomar** la primera OT libre de la Cola de Programación (o cualquier
  otra con su botón).

**Agrupar partes parecidas** (Daniel, 2026-11-02): con la auto-asignación libre
ya no es una excepción; sólo cambia dónde queda la OT (justo después de la
relacionada). Mientras trabaja una OT, el programador puede
auto-asignarse otras OT **libres** que se le parezcan (mismas herramientas,
mismo material…) para programarlas juntas.

- **Sugerencias:** bajo "Tu siguiente programa" aparece "Partes parecidas
  libres", ordenadas por coincidencias: mismo material y medidas
  (`MaterialRequirement`), mismo prefijo de número de parte (texto antes del
  último `-`, p. ej. `ZBL149-`), mismo proyecto o cliente, misma máquina
  planeada. Comparar listas de herramientas queda para cuando sean datos y no
  archivos; mientras tanto lo decide el programador.
- **Agrupar:** `POST …/take` con `{ operation_id, related_to: <concept_id>,
  reason }`, donde el motivo sale de una lista corta (mismo material, mismas
  herramientas, misma familia de parte, mismo setup) o es texto libre. También
  puede agrupar una OT libre que no esté en las sugerencias.
- **Reglas:** sólo OT sin responsable (nunca quitarle una a otro); la OT
  `related_to` debe ser suya y estar pendiente. El evento es `Taken` con
  `related_to` y `reason`, y la OT muestra "Agrupada con OT-0147 · mismas
  herramientas" para el admin, que puede quitársela.
- **Orden:** las OT agrupadas se fijan justo después de la OT con la que se
  agruparon (`sequence_rank` entre esa y la siguiente), para que salgan
  juntas. Una alerta resalta cuando una máquina está en rojo
  esperando un programa que nadie tiene asignado.

**Metas de la semana (equipo):** programas liberados, piezas terminadas y
% de OT entregadas a tiempo contra una meta semanal que captura el admin. Sin
ranking por persona en esta vista ni en la TV; las cifras por persona y el
dinero se quedan en el reporte semanal (admin).

**Render:** decenas de tarjetas, por eso DOM normal con Solid, sin Canvas ni
WebGPU (guía de renderizado de `CLAUDE.md`). Arrastrar con eventos nativos
(pointer events para táctil) y animación de entrada/salida con
`solid-transition-group`. Se actualiza cada 30 s, igual que la Vista de piso.

## 10. Preguntas abiertas

1. ¿El supervisor también puede mover la secuencia o sólo Daniel? (Propuesta:
   sólo admin; se le da `manage_production_board` si se quiere.)
2. ¿El reporte cuenta OT (números de parte) o también piezas? Propuesta: OT
   como métrica principal y piezas como columna informativa.
3. ¿Las OT sin fecha de entrega deben marcarse en rojo para obligar a
   capturarla?
4. ¿Comparar contra el costo de cada persona (sueldo semanal) para ver su
   margen? Requiere capturar sueldos; queda fuera de esta propuesta.

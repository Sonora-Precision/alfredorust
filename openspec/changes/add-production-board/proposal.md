# Tablero de Producción: órdenes de trabajo, colas y secuencia

> Estado: **propuesta — pendiente de revisión** (Daniel Rivera + Luis Alfredo).
> Sin código todavía. Redactada 2026-11-02. Depende de `add-shop-floor-tracking`
> (ruta de proceso, piezas terminadas, perfiles y, para los indicadores de
> archivos, la fase 3).

## Por qué

Hoy el programador no tiene un lugar donde ver **qué sigue**. Daniel reparte el
trabajo de palabra y la prioridad vive en su cabeza o en Notion. Se necesita
una vista tipo "hilo de órdenes" de cocina, con lenguaje de taller: cada número
de parte pendiente es una **Orden de Trabajo (OT)** que aparece en la cola del
área que la tiene que atender (Programación CNC, Setup, Máquina), ordenada por
la **secuencia de producción** que decide Daniel.

Además Daniel quiere medir la carga y la productividad de cada programador:
qué tiene asignado hoy y cuántas OT sacó cada uno por semana, y cuáles fueron.

## Qué cambia

1. **Orden de Trabajo (OT).** Cada `ProjectConcept` recibe un folio
   consecutivo por empresa (`OT-0142`). No es una entidad nueva: la OT es el
   número de parte visto desde el piso.
2. **Colas por área.** Cada operación del catálogo de proceso pertenece a una
   cola (Programación CNC, Setup, Máquina, Acabado). Una OT aparece en la cola
   de su **primer paso pendiente** y avanza sola cuando se marca ese paso.
3. **Secuencia de producción.** Orden automático por prioridad y fecha de
   entrega, con **fijado manual**: Daniel arrastra una OT para forzar su lugar.
4. **Asignación.** Cada paso de una OT puede tener un responsable. Todos ven la
   cola completa, con el filtro **"Mis asignaciones"**. Un programador puede
   **tomar** una OT libre de su cola.
5. **Tablero de Producción** (SPA) con una pestaña por cola y la **Vista de
   piso**: pantalla completa, solo lectura, que se actualiza sola, para una TV
   en el taller.
6. **Carga por programador** (lo asignado y pendiente de cada uno) y **Reporte
   semanal de producción** (OT terminadas por persona y semana, con su
   detalle y, sólo para el admin, el valor producido), sostenidos por una
   bitácora de eventos de la OT.

## Decisiones de producto (confirmadas por Daniel, 2026-11-02)

- Nombres: módulo **Tablero de Producción**; tarjeta **Orden de Trabajo
  (OT)**; filas **Cola de Programación CNC / Cola de Setup / Cola de Máquina**;
  orden **Secuencia de producción**; filtro **Mis asignaciones**; modo TV
  **Vista de piso**. Nada de "comandas" en la UI.
- Secuencia automática (prioridad → fecha de entrega) con ajuste manual.
- Todos ven la cola completa; las OT pueden tener asignado y hay filtro propio.
- Se ve con usuario propio (PC o celular) y en la Vista de piso.
- Una OT sale de la Cola de Programación cuando se marca el paso "Programa"
  como hecho (o, con la fase 3, al subir el primer `.nc`) y pasa a la Cola de
  Setup.
- Daniel ve qué tiene asignado cada programador y cuántas y cuáles OT sacó
  cada uno por semana.
- Daniel ve además el **valor producido** por cada persona en la semana:
  `precio unitario × piezas terminadas en la semana` de las OT en las que la
  persona hizo su paso. Se cuenta al terminar piezas, no al liberar el
  programa. Sólo el admin lo ve.
- **El dinero es por pieza, nunca por proyecto.** No se usa el presupuesto ni
  el total del proyecto u OC; sólo el precio unitario de cada número de parte
  por cada pieza terminada.
- El tablero, la carga y la OT nunca muestran dinero (precio, OC, cotización,
  factura); el único dinero es esa columna del reporte, sólo para admin.

## Alcance inicial (Daniel, 2026-11-02)

Por ahora el único perfil de taller con usuario nuevo es **Programador**:
**José Márquez**, **Carlos Dávila** y **Jesús Sigala**. Además programa
**Daniel Rivera** (admin), así que los admins también se pueden asignar,
tomar OT y aparecen en la carga y en el reporte semanal como cualquier
programador. No habrá todavía usuarios de Supervisor ni Setupista. Por eso la
entrega se parte en dos:

- **Entrega A — Programación.** Folio de OT, Cola de Programación CNC,
  secuencia, asignación y "Tomar" entre los dos programadores, Vista de piso
  de esa cola, carga por programador y reporte semanal (con valor producido
  para el admin). Las piezas terminadas las sigue capturando el admin.
- **Entrega B — resto del piso.** Colas de Setup, Máquina y Acabado, y sus
  perfiles, cuando haya usuarios para ellas. El modelo (colas en el catálogo,
  asignación por paso) ya queda listo desde la entrega A, así que B no
  necesita migración.

## Efectos secundarios

- Migración idempotente que asigna folio a los conceptos existentes, en orden
  de creación, por empresa.
- El catálogo `process_operations` gana el campo `queue`; las operaciones sin
  cola no generan OT en el tablero (siguen en la matriz de seguimiento).
- Nueva colección `work_order_events` (append-only). No toca dinero, CFDI ni
  planned entries.

## Fuera de alcance

- Programación por capacidad (horas disponibles por máquina, Gantt,
  replanificación automática).
- Notificaciones push o WhatsApp al asignar.
- Tiempo real por WebSocket: la Vista de piso consulta cada 30 s.
- Métricas de tiempo de ciclo por OT (se pueden derivar después de la
  bitácora).

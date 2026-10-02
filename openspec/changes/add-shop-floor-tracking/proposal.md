# Seguimiento de taller: números de parte, avance, perfiles y archivos

> Estado: **propuesta — pendiente de revisión** (Daniel Rivera + Luis Alfredo).
> Sin código todavía. Redactada 2026-10-01 a partir del flujo real de Sonora
> Precision en Notion (bases `📋 Projects` y `🔧 Items`).

## Por qué

Sonora Precision (`sp`) lleva sus proyectos en Notion y sólo usa la plataforma
para CFDI y pagos. Para mover la operación del taller aquí faltan piezas que hoy
obligan a seguir en Notion:

- **Avance por piezas.** Un concepto avanza completo de estado en estado; no
  puede decir "1 de 2 piezas terminadas", y no existe % de avance del proyecto.
- **Pipeline de proyecto fijo.** `ProjectStatus` es un enum CNC de 10 etapas
  compartido por todos los tenants; `sp` usa otras etapas
  (Entrada → Cotización → PO Aprobada → Preparación → Producción → Inspección →
  Entrega → Cierre). Ya está planeado como G1.4 en
  `docs/generalization/G1-design.md`.
- **Datos de la OC.** No hay fecha de entrega, responsable, número de OC /
  cotización, precio unitario por parte, ni liga con la factura (hoy el folio se
  escribe en el título: "TY2157 … / F-96").
- **Archivos.** El taller vive de planos, CAD/STEP, programas `.nc` y listas de
  herramientas por número de parte, más la OC y la cotización por proyecto. La
  plataforma no guarda archivos de proyecto.
- **Perfiles de taller.** Supervisor, Programador y Setupista necesitan ver
  archivos técnicos y avance **sin ver dinero** (OC, cotizaciones, precios,
  facturas). Hoy el staff con `view_projects` ni siquiera puede abrir el detalle
  de un proyecto en la SPA (los endpoints de conceptos son sólo admin).

## Qué cambia

Cinco fases, cada una desplegable y útil por sí sola.

1. **Proyecto y números de parte** — G1.4 (`project_stages` configurable +
   migración), y en el proyecto: fecha de entrega, asignados, número de OC y de
   cotización, facturas CFDI ligadas, % de avance calculado. En el concepto
   (= número de parte): piezas terminadas, precio unitario, máquina planeada,
   estado de material. Lectura de proyecto completo para staff con
   `view_projects`, con dinero redactado.
2. **Perfiles y permisos** — perfiles por empresa (plantillas de permisos):
   Supervisor, Programador, Setupista sembrados por defecto; nuevos permisos
   `update_part_progress`, `view_technical_files`, `upload_cnc_files`.
3. **Archivos con versiones** — almacenamiento de objetos (Cloudflare R2 vía URLs
   firmadas; disco local para desarrollo), tipos de archivo con permisos por
   tipo, versiones con nota y fecha, la más reciente marcada.
4. **Horas de máquina** — máquinas como recursos con costo/hora, captura en la
   rejilla existente, costo real por número de parte y proyecto (sólo admin).
5. **Migración desde Notion** — los proyectos e items existentes con sus
   archivos, y alta de clientes faltantes.

## Decisiones de producto (confirmadas por Daniel, 2026-10-01)

- `% avance = Σ piezas terminadas ÷ Σ piezas pedidas` de los números de parte
  del proyecto (no ponderado por precio).
- **Sólo el administrador ve dinero**: OC, cotización, facturas, precios,
  presupuestos, costos. Ningún perfil lo ve.
- Supervisor: da seguimiento (piezas terminadas, estados, notas); no crea
  proyectos ni números de parte.
- Programador: ve todo lo técnico y **sube** programas `.nc` y listas de
  herramientas (baja → edita en su equipo → sube; sin editor en el navegador).
- Setupista: ve y descarga planos, CAD/STEP, programas y listas de
  herramientas; **no** marca piezas terminadas.
- Programas disponibles en cuanto se suben (sin paso de liberación). Se guardan
  todas las versiones con fecha y nota; se marca la más reciente.
- Todos los perfiles ven todos los proyectos y a quién está asignado cada uno.
- El "F-96" del título es la factura folio 96 → se liga al CFDI real.
- Estados de proyecto configurables por empresa. Se registran horas de máquina.
  Se migran los proyectos de Notion.

## Efectos secundarios

- Fase 1 migra el campo `projects.status` (enum) a `projects.stage_id` para
  **todas** las empresas; cada empresa recibe las 10 etapas actuales como datos,
  así que nadie ve cambio de comportamiento (ver design §1).
- Ligar una factura a un proyecto **no** crea transacciones ni pagos; sólo
  lectura del CFDI. La sincronización CFDI → transacción existente no cambia.
- Fase 3 agrega un servicio externo (R2) y secretos nuevos en `.env`.
- Ninguna fase toca SAT, descarga de CFDI ni planned entries.

## Fuera de alcance

- Editor de programas en el navegador, comparación de versiones línea a línea.
- Flujo de aprobación/liberación de programas.
- Estado de pago a partir de complementos de pago (tipo P): hoy `cfdi.rs` no
  parsea `DoctoRelacionado`; se propone como cambio aparte.
- Capa de etiquetas, módulos encendibles y plantillas por giro (G1.1–G1.3).

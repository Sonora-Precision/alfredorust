# Tasks

Cada fase se despliega sola. Toda ruta nueva se registra en `src/main.rs` **y**
en `tests/common/harness.rs::build_app` (copia manual del router).

## Fase 1 — Proyecto y números de parte

- [ ] `ProjectStage` + colección `project_stages` + CRUD (patrón `concept_statuses`) + JSON API.
- [ ] Migración idempotente enum → `stage_id` para todas las empresas; `status`/`status_label` en DTO derivados de la etapa.
- [ ] `advance` por posición saltando `is_cancelled`; `POST /projects/{id}/stage`; mismo salto en avance de conceptos.
- [ ] Rejilla de recursos: excluir proyectos en etapa `is_cancelled` (antes `ProjectStatus::Cancelado`).
- [ ] Proyecto: `due_date`, `assigned_user_ids`, `po_number`, `quote_number`; redacción para no-admin.
- [ ] Facturas ligadas: link/unlink con validación (empresa, tipo I, emitido); detalle admin.
- [ ] Concepto: `quantity_completed`, `unit_price`, `planned_resource_ids`, `material_status`; validación de rango.
- [ ] `progress` calculado en proyecto y concepto.
- [ ] `POST /project_concepts/{id}/progress` con `update_part_progress` (permiso se agrega aquí, perfiles en fase 2).
- [ ] Abrir lectura de conceptos/estados/etapas a `view_projects` con redacción de dinero.
- [ ] Solid: etapas configurables (página + badge por color), columnas de avance/entrega/asignados, captura de piezas terminadas, facturas (admin); corregir `ProjectDetail.tsx:90` (borra notas).
- [ ] spcli: `projects stages …`, `projects set-stage`, `projects concepts progress`; actualizar `docs/spcli.md` y skill.
- [ ] Conector `tools/sp-mcp`: agregar rutas nuevas al catálogo.
- [ ] Pruebas: migración (2 empresas, idempotencia), salto de cancelado, etapa ajena → 404, avance 0.375, rango de piezas, staff lee sin dinero, factura ajena/recibida rechazada, aislamiento entre tenants.

## Fase 2 — Perfiles y permisos

- [ ] Permisos `view_technical_files`, `upload_cnc_files` en enum, parsers, `/api/me`, `Users.tsx`.
- [ ] `PermissionProfile` + `UserCompany.profile_id`; permisos efectivos = perfil ∪ individuales al cargar sesión.
- [ ] CRUD de perfiles (admin), 409 si está en uso; siembra Supervisor/Programador/Setupista para empresas sin perfiles.
- [ ] Solid: pantalla de perfiles; selector de perfil en usuarios + extras individuales.
- [ ] Pruebas: editar perfil propaga, extra individual, perfil ajeno rechazado, perfiles sembrados sin dinero.

## Fase 3 — Archivos con versiones

- [ ] Trait `FileStore` + `LocalStore` + `R2Store` (URLs firmadas, multipart > 100 MB); variables `.env`.
- [ ] `ProjectFile`, `ProjectFileVersion`, registro de descargas; índices por `company_id`.
- [ ] Endpoints: listar, pedir URL de subida, confirmar versión, URL de descarga, historial, borrado suave.
- [ ] Permisos por tipo (tabla design §3.3); tipos comerciales ocultos a no-admin; extensiones y tamaño máximo.
- [ ] Limpieza de versiones `Pending` > 24 h.
- [ ] Solid: panel de archivos en proyecto y en número de parte (arrastrar y soltar, progreso, historial de versiones).
- [ ] Pruebas con `LocalStore`: programador sube `.nc`, setupista no puede, OC invisible para staff, confirmación sin objeto falla, archivo de otra empresa → 404.
- [ ] Crear bucket R2 privado y credenciales con permiso sólo a ese bucket (ops).

## Fase 4 — Horas de máquina

- [ ] Corregir `allowed_status_ids` vacío = todos (grid HTML/JSON y `resource_usages.rs`).
- [ ] Costo real por concepto y proyecto (admin) vs presupuesto/precio.
- [ ] Solid: resumen de horas y costo en detalle de proyecto (admin); horas sin costo para supervisor.
- [ ] Pruebas: máquina sin restricciones aparece, supervisor guarda horas sin ver costo.

## Fase 5 — Migración desde Notion

- [ ] Descargar del SAT las facturas emitidas de dic-2025 (F-94…F-99) en `sp`.
- [ ] Script idempotente Notion → plataforma (clientes, proyectos, items, archivos).
- [ ] Ensayo completo en `bodad`; luego `sp`; verificación con Daniel.

## Cierre

- [ ] `cargo test`, lint y build de `solid/`, e2e mocked afectados (`orders-projects`, `permissions`).
- [ ] Actualizar `openspec/specs/projects`, `auth`, `resources` y marcar G1.4 en `docs/generalization/G1-design.md`.
- [ ] `openspec validate --all`.

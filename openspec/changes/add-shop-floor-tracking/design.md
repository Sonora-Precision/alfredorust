# Diseño

Referencias de código al 2026-10-01 (commit `ecd7b52`).

## 0. Vocabulario

| Taller (`sp`) | Modelo actual | Colección |
|---|---|---|
| Proyecto (= una OC del cliente) | `Project` | `projects` |
| Número de parte (item) | `ProjectConcept` | `project_concepts` |
| Estado del número de parte | `ConceptStatus` (ya configurable) | `concept_statuses` |
| Estado del proyecto | `ProjectStatus` enum → **`ProjectStage`** | **`project_stages`** (nueva) |
| Máquina (VF-3, VF-6, ZZD) | `Resource` | `resources` |
| Horas de máquina | `ResourceUsage` + `ResourceUsageAllocation` | `resource_usages`, `resource_usage_allocations` |
| Archivo (plano, CAD, .nc, …) | **`ProjectFile`** | **`project_files`** (nueva) |
| Perfil (Supervisor, …) | **`PermissionProfile`** | **`permission_profiles`** (nueva) |

No se renombran entidades: "número de parte" es la etiqueta en UI para
`ProjectConcept` (compatible con la capa de etiquetas de G1.2 cuando llegue).

---

## 1. Fase 1 — Proyecto y números de parte

### 1.1 Etapas de proyecto configurables (= G1.4)

Se implementa tal como lo define `docs/generalization/G1-design.md §1/§4`:

```rust
pub struct ProjectStage {            // colección project_stages
    id, company_id, name, position: i32, color: Option<String>,
    is_initial: bool, is_terminal: bool, is_cancelled: bool, is_active: bool,
    created_at, updated_at,
}
```

- CRUD idéntico a `concept_statuses` (`src/state/project_concepts.rs:20-203`):
  un solo marcador por etapa (`ensure_single_status_marker`), `is_initial`
  exclusivo por empresa, borrado suave si hay proyectos que la usan.
- `Project` gana `stage_id: Option<ObjectId>`; `status: ProjectStatus` queda
  **sólo para leer datos viejos** durante la migración y se elimina en una
  versión posterior.
- `advance`: siguiente etapa activa por `position`, **saltando** etapas
  `is_cancelled` (hoy el avance de conceptos cae en "Cancelado" al pasar de
  "Terminado": `project_concepts.rs:343-377`; se corrige igual ahí). Al llegar a
  una etapa `is_terminal` o `is_cancelled` se fija `completed_at`.
- Nuevo `POST /api/admin/projects/{id}/stage {stage_id}`: fija una etapa
  arbitraria (hoy "Cancelado" es inalcanzable vía `next()`).
- `resource_usages.rs:336` (excluye proyectos `Cancelado` de la rejilla) pasa a
  "etapa con `is_cancelled`".

**Migración** (idempotente, al arrancar, igual que los índices de
`state/mod.rs`): por cada empresa con proyectos y sin `project_stages`, sembrar
las 10 etapas del enum (`Pedidos`…`Entregado` con `is_terminal`, `Cancelado` con
`is_cancelled`, posiciones 0–9, mismos labels de `ProjectStatus::label()`), y
`$set stage_id` en cada proyecto según su `status`. Empresas sin proyectos
reciben las mismas 10 al crear su primer proyecto (o una plantilla en G1.3).
Resultado: ningún tenant ve cambio. Para `sp` se reemplazan por sus 8 etapas
como **dato** (vía UI/API), no en código.

DTO `ProjectData` conserva `status`/`status_label` (= nombre de la etapa) para
no romper spcli ni e2e; agrega `stage_id`, `stage_color`, `stage_is_terminal`.
`solid/src/lib/api/types.ts:15-25` deja de tener la unión fija; `Badge` usa el
color de la etapa en vez de adivinar por substring.

### 1.2 Campos nuevos del proyecto

| Campo | Tipo | Quién ve | Quién edita |
|---|---|---|---|
| `due_date` | `Option<DateTime>` | `view_projects` | admin |
| `assigned_user_ids` | `Vec<ObjectId>` (miembros de la empresa) | `view_projects` | admin |
| `po_number` | `Option<String>` | admin | admin |
| `quote_number` | `Option<String>` | admin | admin |
| `cfdi_uuids` | `Vec<String>` | admin | admin |

`scheduled_at` existente = fecha de inicio. `total_budget` existente = subtotal
de la OC (ya se redacta sin `view_project_money`).

**Facturas ligadas.** `POST /api/admin/projects/{id}/invoices {uuid}` y
`…/invoices/{uuid}/delete`. Validaciones (fallan con 400/404, nunca en
silencio): el CFDI existe, pertenece a la empresa activa (`cfdis.company_id`,
hoy string), es tipo `I`, y fue **emitido** por la empresa (emisor RFC ∈ RFCs de
`sat_configs`, misma regla que `cfdis.rs:811-822`). Un CFDI puede ligarse a
varios proyectos (anticipo/OC parcial) — se avisa en UI, no se bloquea. El
detalle del proyecto (admin) muestra folio, fecha, total, estatus SAT y si tiene
transacción. **Sin efectos financieros.**

### 1.3 Campos nuevos del número de parte (`ProjectConcept`)

| Campo | Tipo | Notas |
|---|---|---|
| `quantity_completed` | `f64`, default 0 | `0 ≤ completed ≤ quantity`, si no 400 |
| `unit_price` | `Option<f64>` | **dinero**: sólo admin |
| `planned_resource_ids` | `Vec<ObjectId>` | máquinas planeadas ("Machine" en Notion) |
| `material_status` | `Option<MaterialStatus>` | enum abajo |

`name` sigue siendo el número de parte. `estimated_cost` también es dinero.

```rust
enum MaterialStatus { Pending, Missing, Purchased, Ready, CustomerSupplied }
// En espera · Faltante · Comprado · Habilitado · Lo proporciona el cliente
```
(Notion también tiene "Maquinado" en material; se pregunta en *Preguntas
abiertas* antes de fijar el enum.)

**Avance** (calculado al leer, no se guarda):

```
avance_parte    = quantity_completed / quantity
avance_proyecto = Σ quantity_completed / Σ quantity   (excluye conceptos en estado is_cancelled)
```
Se expone en `ProjectData.progress` (0–1, `null` si no hay partes) y en cada
concepto. `status_summary` (`project_concepts.rs:399`) se mantiene.

**Endpoint de seguimiento** (el supervisor no puede editar el concepto completo):

```
POST /api/admin/project_concepts/{id}/progress
{ quantity_completed?, status_id?, material_status?, notes? }
permiso: update_part_progress (admin implícito)
```
`update` completo y `create/delete` siguen sólo admin.

### 1.4 Lectura para staff (arregla hueco actual)

Hoy `ProjectDetail.tsx` llama `/api/admin/projects/{id}/concepts` y
`/api/admin/concept_statuses`, ambos `require_admin_active` → 403 para staff.
Se abren a `view_projects` **en lectura**, redactando `unit_price`,
`estimated_cost` y campos comerciales del proyecto para no-admin (mismo patrón
que `total_budget`, `projects.rs:794-798`). Lo mismo para `project_stages` GET.

### 1.5 Corrección incluida

`ProjectDetail.tsx:90` manda `notes: ''` al editar → borra las notas existentes
del concepto. Se corrige cargando las notas reales.

---

## 2. Fase 2 — Perfiles y permisos

**Modelo.** `UserRole { Admin, Staff }` no cambia; admin sigue teniendo todo
(`session.rs:228`). Se agregan permisos:

| Permiso | Habilita |
|---|---|
| `update_part_progress` | `POST …/progress` |
| `view_technical_files` | listar/descargar archivos técnicos (fase 3) |
| `upload_cnc_files` | subir versiones de `cnc_program` y `tool_list` (fase 3) |

Hay que agregarlos en `UserPermission` (`models.rs:17`), `permission_from_str`
(`users_api.rs:96-105`), `permissions_from_values` (`users.rs:599`), el arreglo
`PERMISSIONS` de `solid/src/pages/Users.tsx:33` y el DTO de `/api/me`.

**Perfiles** = plantillas de permisos por empresa:

```rust
pub struct PermissionProfile {       // colección permission_profiles
    id, company_id, name, permissions: Vec<UserPermission>, is_active, …
}
// UserCompany gana: profile_id: Option<ObjectId>
```

Permisos efectivos de un staff = `perfil.permissions ∪ membership.permissions`
(los de la membresía son "extras" individuales). Se resuelven al cargar la
sesión (`users.rs:316-402`), así que **editar un perfil actualiza a todos sus
usuarios** sin reescribir membresías. CRUD admin-only; borrar un perfil en uso
→ 409.

Perfiles sembrados (editables) al crear la empresa / por migración sólo para
empresas que no tengan ninguno:

| Perfil | Permisos |
|---|---|
| Supervisor | `view_projects`, `update_part_progress`, `view_technical_files`, `edit_resource_usage_today`, `view_resource_usage_history`, `view_timeline` |
| Programador | `view_projects`, `view_technical_files`, `upload_cnc_files` |
| Setupista | `view_projects`, `view_technical_files` |

Ninguno incluye `view_project_money`: **sólo admin ve dinero** (decisión de
Daniel). El permiso sigue existiendo para otros tenants.

---

## 3. Fase 3 — Archivos con versiones

### 3.1 Almacenamiento

Hoy los archivos van a disco local (`data/cfdi_store`, `uploads/sat`) y el
límite de body es 2 MB salvo CFDI (30 MB, `main.rs:124`). Los STEP pueden pesar
cientos de MB, y **Cloudflare (proxy naranja) corta requests > 100 MB** en el
plan gratuito, así que subir a través de `*.alfredorivera.dev` no sirve.

Propuesta: trait `FileStore` con dos implementaciones:

- **`R2Store` (producción)**: Cloudflare R2 (API S3). El backend valida permisos
  y genera **URLs firmadas de 15 min**; el navegador sube (PUT, multipart para
  > 100 MB) y descarga **directo** a R2. El tráfico grande no pasa por nginx ni
  por el proxy. Crate ligero de firma S3 (p. ej. `rusty-s3`) en vez del SDK
  completo de AWS.
- **`LocalStore` (desarrollo/pruebas)**: disco en `FILE_STORE_DIR`, subida por
  el backend con `DefaultBodyLimit` propio de la ruta.

Variables nuevas: `FILE_STORE=r2|local`, `R2_ACCOUNT_ID`, `R2_BUCKET`,
`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `FILE_STORE_DIR`. El bucket es
privado; nunca se exponen URLs permanentes.

Llave de objeto: `{company_id}/{project_id}/{file_id}/{version}` — **no** se usa
el nombre original en la llave (evita path traversal y colisiones).

### 3.2 Modelo

```rust
pub struct ProjectFile {             // colección project_files — un "archivo lógico"
    id, company_id, project_id, concept_id: Option<ObjectId>,
    kind: FileKind, name: String,    // "OP10.nc", "2519146.step"
    latest_version: i32, is_deleted: bool, created_at, updated_at,
}
pub struct ProjectFileVersion {      // colección project_file_versions
    id, company_id, file_id, version: i32,
    storage_key, original_filename, content_type, size_bytes, sha256,
    note: Option<String>, uploaded_by: ObjectId, uploaded_at,
    status: Pending | Ready,         // Ready al confirmar la subida
}
enum FileKind { Drawing, Cad, CncProgram, ToolList, PurchaseOrder, Quote, Other }
```

Flujo de subida: `POST …/files/upload-url` (valida permiso + tipo + tamaño,
crea versión `Pending`, regresa URL firmada) → navegador sube a R2 →
`POST …/files/{id}/versions/{v}/confirm` (HEAD al objeto, verifica tamaño,
marca `Ready`, `latest_version = v`). Versiones `Pending` > 24 h se limpian.

### 3.3 Permisos por tipo

| Tipo | Nivel | Ver/descargar | Subir nueva versión |
|---|---|---|---|
| Plano (`drawing`) | proyecto o parte | `view_technical_files` | admin |
| CAD/STEP (`cad`) | parte | `view_technical_files` | admin |
| Programa `.nc` (`cnc_program`) | parte | `view_technical_files` | admin, `upload_cnc_files` |
| Lista de herramientas (`tool_list`) | parte | `view_technical_files` | admin, `upload_cnc_files` |
| OC (`purchase_order`), cotización (`quote`) | proyecto | **admin** | admin |
| Otro (`other`) | ambos | admin | admin |

Los tipos comerciales **no aparecen** en listados de no-admin (ni conteos).
Borrar (suave) sólo admin. Cada descarga se registra (`file_id`, versión,
usuario, fecha) para trazabilidad.

Versiones: todas se conservan; la UI muestra la más reciente con su fecha,
autor y nota, y un historial descargable. No hay aprobación: la nueva versión
está disponible al confirmarse.

Extensiones permitidas por tipo (configurables en código): `drawing` pdf/png/jpg/
dwg/dxf; `cad` step/stp/iges/igs/sldprt/sldasm/x_t/stl/f3d/ipt; `cnc_program`
nc/tap/txt/gcode/mpf/h/eia/min; `tool_list` pdf/xlsx/csv/txt; comerciales pdf/
xlsx/docx/png/jpg. Tamaño máximo por archivo: 2 GB (configurable).

---

## 4. Fase 4 — Horas de máquina

Se reutiliza lo existente: `Resource` con `hourly_cost`, rejilla horaria
(`resource_usages.rs:347-484`) que reparte horas entre conceptos.

- Alta de máquinas de `sp` (VF-3, VF-6, ZZD) como **datos**.
- **Bug a corregir**: `allowed_status_ids` vacío debería significar "todas" (doc
  en `models.rs:966`) pero la rejilla filtra con `contains`
  (`project_backend/mod.rs:1774, 2227`; `resource_usages.rs:382-387`) → una
  máquina sin estados permitidos nunca aparece.
- Captura: permiso existente `edit_resource_usage_today` (Supervisor). Ventana
  actual de 4 días para staff se conserva.
- Costo real (sólo admin): Σ `allocated_cost` por concepto y por proyecto, vs
  `total_budget` / Σ `unit_price × quantity`.
- "Proveedor externo" no es máquina: su costo se registra como transacción
  ligada al proyecto (ya soportado vía planned entry → `project_id`).

---

## 5. Fase 5 — Migración desde Notion

Script de una sola vez (Node, reutilizando `tools/sp-mcp` + conector de Notion),
idempotente por `notion_page_id` guardado en `notes`/campo de origen:

1. Clientes faltantes como contactos (`MAKINTECH`, `RB MACHINE`); `C&H` →
   `CAMPILLO Y HUERTA INGENIERIA DE PRECISION`, `BRABATECH` → `BRABA TECH`.
2. Proyectos (`📋 Projects`): título, cliente, prioridad, inicio, entrega,
   notas, etapa mapeada; factura por folio del título si el CFDI existe (las
   F-94…F-99 son de dic-2025 y hoy no están descargadas).
3. Items (`🔧 Items`): número de parte, piezas pedidas/terminadas, estado,
   máquina, material, notas.
4. Archivos (fase 3 lista): adjuntos de proyecto como `purchase_order`; los de
   cada item según extensión.

Se corre primero contra `bodad` (tenant de pruebas) y luego `sp`.

---

## 6. Preguntas de revisión (openspec/README.md)

- **¿Qué empresa es dueña?** Todo nuevo documento lleva `company_id` y toda
  consulta filtra por la empresa activa; el `project_id`/`concept_id`/`file_id`
  de la ruta se valida contra ella (404 si es de otra).
- **¿Quién ve?** Tabla §1.2, §1.3, §3.3. Dinero y archivos comerciales: admin.
- **¿Quién modifica?** Admin todo; `update_part_progress` sólo avance/estado/
  material/notas; `upload_cnc_files` sólo versiones de `.nc`/listas.
- **Colecciones**: nuevas `project_stages`, `permission_profiles`,
  `project_files`, `project_file_versions`, `project_file_downloads`;
  modificadas `projects`, `project_concepts`, `user_companies`; leída `cfdis`.
- **Efectos financieros**: ninguno. Ligar facturas es sólo lectura.
- **Pruebas**: §tasks — aislamiento entre tenants, redacción de dinero por
  perfil, migración de etapas, límites de avance, permisos por tipo de archivo.
- **Debe fallar ruidosamente**: `quantity_completed` fuera de rango, CFDI ajeno o
  recibido, subir tipo/extension no permitido, confirmar versión cuyo objeto no
  existe o difiere en tamaño, borrar perfil o etapa en uso.

## 7. Preguntas abiertas

1. **Almacenamiento**: ¿R2 en la cuenta de Cloudflare de Luis Alfredo? (≈ USD
   0.015/GB-mes, sin costo de salida). Alternativa temporal: disco del servidor
   con límite < 100 MB por archivo.
2. **Material**: ¿qué significa "Maquinado" como estado de material en Notion?
3. **Setupista**: ¿captura horas de máquina o sólo el supervisor?
4. **Orden con G1**: ¿G1.4 se hace aquí (fase 1) aunque G1.1–G1.3 no existan?
   Se propone que sí: no depende de ellas.
5. **Etapa "Cancelado" en `sp`**: Notion no la tiene; ¿se agrega?

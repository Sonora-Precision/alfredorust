# SPA pages — part 2 (admin/ops pages)

Source: original `frontend/src/pages/*.rs`, routed from `frontend/src/app.rs` under `<Router base="/v2">`.
Those `/v2/...` route labels are historical source references; the current Solid equivalents are served under `/v3/...`.
All routes are session-protected (rendered only inside `AuthedApp`); `Me` (role, permissions, company)
is provided via Leptos context and is read with `use_context::<Me>()` in every page. Admin-only UI is
gated with `me.role == "admin"`; some pages also check `me.can("<permission>")` (see `Sidebar` gating in
app.rs: `view_projects`, `view_project_money`, `edit_resource_usage_today`, `view_resource_usage_history`,
`view_timeline`).

Shared helpers used across these pages (`frontend/src/pages/mod.rs`):
- `Options = Vec<(String, String)>` — id→label pairs for `<select>`.
- `load_account_options` / `load_category_options` / `load_contact_options` / `load_project_options` /
  `load_planned_entry_options` (and, referenced but not shown here, `load_concept_status_options`,
  `load_resource_options`) — each fires a GET on mount and fills an `Options` signal.
- `bool_badge(bool, yes_label, no_label)`, `status_badge`, `priority_badge`, `role_badge` — wrap the shared
  `Badge` component with a tone based on value.
- `money(f64)` — pretty `$1,234.56` formatting (see prior commit `35e73a1`).
- `date_to_rfc3339` / `rfc3339_to_date` (date-only) and `local_dt_to_rfc3339` / `rfc3339_to_local_dt`
  (datetime-local) — convert between `<input type=date|datetime-local>` string format and RFC3339 for the API.
- `set_html(el, html)` / `run_script(js)` — escape hatch used only by `resource_usages.rs` and `tiempo.rs`
  to inject raw HTML/JS (ported verbatim from the pre-Leptos v1 app) into a `NodeRef` host div.

Common list-page shape (companies, users, orders, projects, project_detail, concept_statuses, resources,
resource_logs): a `RwSignal<Option<Result<Vec<T>, ApiError>>>` "items" signal; a `reload()` closure that
sets it to `None` (→ "Cargando…") then spawns a GET and stores the `Result`; a create/edit `Card` form
whose fields are individual `RwSignal<String>`/`bool` signals; a `save` `Action::new_local` that POSTs to
either the create endpoint or `/…/{id}/update` depending on an `editing: RwSignal<Option<String>>`; a
`begin_edit(id)` that GETs the detail endpoint and populates the form signals; `delete_one(id)` that POSTs
`/…/{id}/delete` then reloads; inline row actions (Editar/Eliminar, sometimes a workflow action like
Avanzar/Completar/Terminar). Empty state: "Sin … todavía." Loading: "Cargando…". Error: red text.

---

## Companies — `/v2/companies` ("Compañías")

**File:** `frontend/src/pages/companies.rs`

**Purpose:** Tenant (company) admin — list companies the user administers, create/edit them, and a
"danger zone" for wiping test data. Visible in the sidebar only under "Administración" (admin role only).

**Data on mount:** `GET /api/admin/companies` → `Vec<CompanyData>`.

**UI:**
- Form card (max-w-2xl): Nombre (required), Slug (subdominio, optional — helper text "se genera del
  nombre si lo dejas vacío"), Moneda por defecto (text, default "MXN"), Activa (`Checkbox`), Notas
  (optional). Submit button label toggles Crear/Guardar/Guardando…; Cancelar button appears only while
  editing.
- Client-side slug validation (`slug_problem`): empty OK; else lowercase ascii letters/digits/hyphens, no
  leading/trailing hyphen, ≤64 chars, not in `RESERVED_SLUGS = [app, www, api, admin, mail, static]`
  (mirrors backend `RESERVED_SLUGS` in `state/companies.rs`).
- "Zona de pruebas" card, shown only while editing an existing company: two destructive buttons — "Borrar
  todos los CFDIs" (`POST /api/admin/companies/{id}/cfdis/delete_all`) and "Borrar todas las
  transacciones" (`POST /api/admin/companies/{id}/transactions/delete_all`) — each behind a native
  `window.confirm`.
- Table: Nombre, Moneda, Estado (`bool_badge` Activa/Inactiva), actions. The row for the *currently
  selected tenant* (`c.is_current`) shows a static "Actual" pill instead of a delete button (can't delete
  the company you're in).

**Actions → API:**
- Create: `POST /api/admin/companies`. Update: `POST /api/admin/companies/{id}/update`.
- Edit: `GET /api/admin/companies/{id}` → populate form.
- Delete: `POST /api/admin/companies/{id}/delete`.

**Reused components:** `Button`, `Card`/`CardHeader`/`CardContent`/`CardTitle`, `Checkbox`, `Input`,
`bool_badge`.

**Tricky bits:** Reserved-slug list must stay in sync with backend `RESERVED_SLUGS`. Danger-zone actions
have no list refresh needed (they don't change company rows), just show inline confirmation text.

---

## Users — `/v2/users` ("Usuarios")

**File:** `frontend/src/pages/users.rs`

**Purpose:** User admin with per-company role/permission memberships — the most complex form in this
batch. Admin-only sidebar entry.

**Data on mount:** `GET /api/admin/users` → `Vec<UserRowData>` (list); separately `GET
/api/admin/companies` → `Vec<CompanyData>` to seed one `MembershipState` row per company (`fresh_rows`).

**UI:**
- Form card: Nombre de usuario (email-like identifier, required, unique), Secreto TOTP (optional text
  input — "se genera automáticamente si lo dejas vacío"; also used to *set* a specific secret).
- "Compañías y rol" — one row per company (`membership_row`): checkbox "incluir esta compañía", and if
  checked, a native `<select>` for role (`staff`/`admin`). If role is `staff`, a permissions checklist
  appears with `PERMISSIONS` constants: `view_projects`, `edit_resource_usage_today`,
  `view_resource_usage_history`, `view_project_money`, `view_timeline` (label pairs, Spanish labels).
  Admin memberships carry no permission list (admins have everything implicitly).
- While editing an existing user: shows a QR code image (`<img src="/admin/users/{id}/qrcode">`, a plain
  HTTP image endpoint, not JSON) for TOTP re-enrollment, plus (if present) a read-only, selectable `<code>`
  block with the plaintext TOTP secret for copy/paste.
- Table: Usuario, Compañías (joined names), Rol (`role_badge`), actions. The row for the logged-in user
  (`u.username == my_username`) hides the delete button (can't delete yourself).

**Actions → API:**
- Create: `POST /api/admin/users` with `UserPayload { username, secret: Option<String>, memberships: Vec<UserMembershipPayload{ company_id, role, permissions }> }` — only `included` rows are sent.
- Update: `POST /api/admin/users/{id}/update`.
- Edit: `GET /api/admin/users/{id}` → `UserRowData` with `memberships` — rehydrates each `MembershipState`
  row by matching `company_id`.
- Delete: `POST /api/admin/users/{id}/delete`.

**Validation:** username required; at least one company must be `included`.

**Reused components:** `Button`, `Card`, `Input`, `role_badge`. Membership rows use raw `<input
type=checkbox>` / `<select>` (not the shared `Checkbox`/`Select` wrappers) because they're indexed into a
`Vec<MembershipState>` by position.

**Tricky bits:** This is a compound form — one root user record plus N membership sub-records, each with
its own nested permission array — all flattened into a single POST payload on save. The QR/secret display
is a side panel that only appears once `editing` is `Some`, sourced from a GET response field (`secret`)
that's blanked on create. Rebuilding in Solid: model memberships as an array of stores keyed by
`company_id`, derive the "show perms" condition from `included && role === 'staff'`.

---

## Orders — `/v2/orders` ("Órdenes de servicio")

**File:** `frontend/src/pages/orders.rs`

**Purpose:** Service orders with line items (quote/invoice-like), status workflow, and links to
category/account/contact. Sidebar under "Operaciones" (admin only).

**Data on mount:** `GET /api/admin/orders` → `Vec<Order>`; option lists via `load_category_options`,
`load_account_options`, `load_contact_options`.

**UI (admin-only form, max-w-4xl):**
- Título (required), Estado (`Select` from `STATUSES`: pending/confirmed/in_progress/completed/cancelled →
  Spanish labels), Cliente (optional contact `Select`), Categoría (optional), Cuenta destino (optional),
  Monto total (decimal input), Fecha (cita/entrega) (`type=date`).
- **Line items ("Conceptos"):** dynamic list (`Vec<ItemRow>`, each row = 3 independent `RwSignal<String>`:
  desc/qty/price) rendered via `<For each=lines key=|r| r.id>`; "+ Agregar línea" appends a row (id from a
  monotonic `line_seq` counter), "✕" removes by id. Empty-description rows are filtered out on save.
- Notas (optional).
- Table (visible to everyone, admin sees action buttons): Título, Cliente (resolved from `contact_id` via
  the loaded contacts list), Estado (`status_badge`), Monto (`money`), Fecha, actions.

**Actions → API:**
- Create/Update: `POST /api/admin/orders` or `/api/admin/orders/{id}/update`, payload `OrderPayload {
  title, contact_id?, category_id?, account_id?, status, amount, scheduled_at?, items: Vec<OrderItem{
  description, quantity, unit_price }>, notes? }`.
- Edit: `GET /api/admin/orders/{id}` → `OrderDetail` (includes items) → rebuild `ItemRow`s.
- Delete: `POST /api/admin/orders/{id}/delete`.
- **Completar** (row action, admin only): `POST /api/admin/orders/{id}/complete` — a workflow shortcut
  distinct from "edit status to completed"; reloads list.

**Reused components:** `Button`, `Card`, `Input`, `Select`, `status_badge`, `money`,
`date_to_rfc3339`/`rfc3339_to_date`.

**Tricky bits:** Non-admin (staff) users see the list but no form and no row actions — the whole
create/edit card and the action buttons are conditionally rendered on `is_admin`. Line items need
per-field reactivity while under a keyed list (`<For>`) — in Solid this is a `createStore`/array of
signals keyed by a stable local id, not the DB id (new rows have none yet).

---

## Projects — `/v2/projects` ("Proyectos")

**File:** `frontend/src/pages/projects.rs`

**Purpose:** Top-level projects list; each row links to its concept breakdown (`project_detail`).
Sidebar entry visible to staff with `view_projects` permission (list + view only) and to admins (full
CRUD) — see `app.rs` Sidebar gating.

**Data on mount:** `GET /api/admin/projects` → `Vec<ProjectRow>`; `load_category_options`,
`load_contact_options`.

**Permission nuance:** `can_money = is_admin || me.can("view_project_money")`. When false, the
"Presupuesto" column header and cell are omitted entirely (not just blanked) — the backend also nulls the
amount for these users, so this is UI/data parity, not just a display filter.

**UI (admin-only form, max-w-4xl):**
- Título (required), Prioridad (`Select` from `PRIORITIES`: low/medium/high/urgent → Spanish), Cliente
  (optional), Categoría (optional), Presupuesto (optional decimal), Fecha límite (optional date),
  Descripción (optional), Notas (optional).
- Table: Título, Estado (`status_badge`), Prioridad (`priority_badge`, takes both raw value and label),
  Presupuesto (only if `can_money`), Fecha límite, actions. Every row has a "Ver" link
  (`/v2/projects/{id}`) to the detail page, visible to all; Avanzar/Editar/Eliminar are admin-only.

**Actions → API:**
- Create/Update: `POST /api/admin/projects` / `/api/admin/projects/{id}/update`, payload `ProjectPayload {
  title, contact_id?, category_id?, description?, priority, total_budget?: f64, scheduled_at?, notes? }`.
- Edit: `GET /api/admin/projects/{id}` → `ProjectDetail`.
- Delete: `POST /api/admin/projects/{id}/delete`.
- **Avanzar** (admin row action): `POST /api/admin/projects/{id}/advance` — advances project status one
  step in its workflow; reloads.

**Reused components:** `Button`, `Card`, `Input`, `Select`, `status_badge`, `priority_badge`, `money`.

---

## Project detail — `/v2/projects/:id`

**File:** `frontend/src/pages/project_detail.rs`

**Purpose:** Per-project breakdown into "concepts" (line-item-like work units with quantity, unit,
estimate, status). Nested under a project via route param.

**Route param:** `use_params_map()`, `pid()` reads `id` from the URL.

**Data on mount (`reload`, called once eagerly — not re-triggered reactively if the param changes without
a full remount):**
1. `GET /api/admin/projects/{id}` → `ProjectDetail`, used only for `title` (page heading).
2. `GET /api/admin/projects/{id}/concepts` → `Vec<ProjectConcept>`.
3. Also loads concept-status options via `load_concept_status_options` (shared helper, referenced but
   defined elsewhere in `mod.rs`) for the status `<Select>` and for resolving `status_id` → name in the
   table.

**UI:**
- Breadcrumb "← Proyectos" link back to `/v2/projects`; `<h1>` = project title (reactive signal, filled
  async).
- Admin-only form (max-w-4xl): Concepto/name (required), Estado (`Select`, empty option = "— Inicial —",
  i.e. `status_id: None` on create), Cantidad (decimal, default "1"), Unidad, Orden/position (numeric,
  default "0"), Horas estimadas, Costo estimado, Descripción. Note: the payload type has a `notes` field
  but this form hardcodes it to `None` on save — concept notes aren't editable here even though the API
  supports them (worth flagging as a possible gap rather than porting the omission blindly).
- Table: Orden, Concepto, Cantidad (formatted `money(qty) + " " + unit`), Estado (name resolved from
  `statuses` options by `status_id`), Estimado (h), actions.

**Actions → API:**
- Create: `POST /api/admin/projects/{id}/concepts`. Update: `POST /api/admin/project_concepts/{cid}/update`.
  Payload `ProjectConceptPayload { status_id?, name, quantity, unit?, description?, estimated_hours?,
  estimated_cost?, notes: None, position }`.
- Edit: populates form directly from the already-loaded `ProjectConcept` row (no extra GET — unlike most
  sibling pages' `begin_edit`, which re-fetch detail by id).
- Delete: `POST /api/admin/project_concepts/{cid}/delete`.
- **Avanzar** (admin row action): `POST /api/admin/project_concepts/{cid}/advance` — moves concept to next
  status in its workflow; reloads.

**Reused components:** `Button`, `Card`, `Input`, `Select`, `money`, `load_concept_status_options`,
`Options`.

**Tricky bits:** This is the "nested resource" pattern for the Solid port — route is `/projects/:id`, and
both a parent fetch (project title) and a child-collection fetch (concepts) fire off the same id; in Solid
this maps naturally to `useParams()` + two resources keyed on the id. `begin_edit` takes the already-fetched
row by value rather than re-fetching — fine to keep or to normalize to the GET-by-id pattern used elsewhere,
either works.

---

## Concept statuses — `/v2/concept-statuses` ("Estados de concepto")

**File:** `frontend/src/pages/concept_statuses.rs`

**Purpose:** Admin-configurable workflow states used by project concepts and by resources'
`allowed_status_ids` (e.g., "Cotización", "En proceso", "Terminado"...). Admin-only sidebar entry under
"Operaciones".

**Data on mount:** `GET /api/admin/concept_statuses` → `Vec<ConceptStatusFull>`.

**UI (admin-only form, max-w-3xl):** Nombre (required), Posición (numeric, default "0", controls sort
order), Color (optional, freeform — presumably a hex or Tailwind token consumed elsewhere), then four
`Checkbox`es: Inicial, Terminal, Cancelado, Activo (default true). These are workflow flags: `is_initial`
marks the default status for new concepts, `is_terminal`/`is_cancelled` mark completion states.

**Table:** Posición, Nombre, Inicial (plain "Sí"/"" text, not a badge), Terminal (same), Activo
(`bool_badge`), actions.

**Actions → API:**
- Create/Update: `POST /api/admin/concept_statuses` / `/{id}/update`, payload `ConceptStatusPayload {
  name, position, color?, is_initial, is_terminal, is_cancelled, is_active }`.
- Edit: populates directly from the row object passed in (`begin_edit(s: ConceptStatusFull)`, cloned from
  the already-loaded list — no re-fetch), same pattern as project_detail's concepts.
- Delete: `POST /api/admin/concept_statuses/{id}/delete`.

**Reused components:** `Button`, `Card`, `Checkbox`, `Input`, `bool_badge`.

---

## Resources — `/v2/resources` ("Recursos")

**File:** `frontend/src/pages/resources.rs`

**Purpose:** Catalog of billable resources (machinery/vehicles/equipment/other) with an hourly cost and a
per-resource "which concept statuses show this resource in the usage grid" allow-list — this feeds
directly into `resource_usages.rs`'s cell menus. Admin-only sidebar entry.

**Data on mount:** `GET /api/admin/resources` → `Vec<Resource>`; `load_concept_status_options` for the
allow-list checklist.

**UI (admin-only form, max-w-3xl):** Nombre (required), Tipo (`Select` from `TYPES`:
machinery/vehicle/equipment/other → Spanish labels), Costo por hora (decimal), Moneda (text, default
"MXN"), Activo (`Checkbox`, default true), "Mostrar en estados" — a wrapped set of checkboxes (one per
concept status, `toggle_status` pushes/removes from a `Vec<String>` of allowed status ids), Notas.

**Table:** Nombre, Tipo (label), Costo/hora (`money`), Moneda, Estados (count of allowed statuses, not
names), Activo (`bool_badge`), actions.

**Actions → API:**
- Create/Update: `POST /api/admin/resources` / `/{id}/update`, payload `ResourcePayload { name,
  resource_type, is_active, hourly_cost, currency?, allowed_status_ids: Vec<String>, notes? }`.
- Edit: `GET /api/admin/resources/{id}` → `ResourceDetail`.
- Delete: `POST /api/admin/resources/{id}/delete`.

**Reused components:** `Button`, `Card`, `Checkbox`, `Input`, `Select`, `bool_badge`, `money`.

---

## Resource logs — `/v2/resource-logs` ("Registros de recursos")

**File:** `frontend/src/pages/resource_logs.rs`

**Purpose:** Free-form start/end time-tracking entries for a resource against a project+phase (distinct
from the structured hourly grid in `resource_usages.rs` — this is more like a stopwatch log with optional
operator name). Admin-only sidebar entry.

**Data on mount:** `GET /api/admin/resource_logs` → `Vec<ResourceLog>`; `load_project_options`,
`load_resource_options`.

**UI (admin-only form, max-w-4xl):** Proyecto (optional `Select`), Recurso (optional `Select`), Fase (free
text), Inicio (`type=datetime-local`, required), Fin (optional `type=datetime-local`), Operador (free
text), Notas.

**Table:** Proyecto (resolved name client-side), Fase, Recurso (`resource_name` pre-joined server-side,
unlike project), Inicio, Fin, Horas (`duration_hours`, computed server-side, `{h:.2}`), Operador, actions.

**Actions → API:**
- Create/Update: `POST /api/admin/resource_logs` / `/{id}/update`, payload `ResourceLogPayload {
  project_id?, phase?, resource_id?, started_at, ended_at?, operator_name?, notes? }` — datetimes via
  `local_dt_to_rfc3339`.
- Edit: `GET /api/admin/resource_logs/{id}` → `ResourceLogDetail`.
- Delete: `POST /api/admin/resource_logs/{id}/delete`.
- **Terminar** (row action, shown only when `ended_at.is_none()`, i.e. an "open" log): `POST
  /api/admin/resource_logs/{id}/end` with `ResourceLogEndPayload { ended_at: None }` — server stamps "now".

**Reused components:** `Button`, `Card`, `Input`, `Select`.

---

## Resource usages (hourly grid) — `/v2/resource-usages` ("Uso de recursos (grid)")

**File:** `frontend/src/pages/resource_usages.rs`

**Purpose:** A day-view grid: rows = active project concepts (grouped by project), columns = 24 hours;
each cell lets you assign one or more resources to that concept for that hour. This is the highest-risk
page to port because the interactive grid (long-press context menu, tap-to-cycle, live label update) is
**raw HTML built as a Rust string, injected via `set_html`, then a hand-rolled vanilla-JS block
(`GRID_JS`) is appended as a `<script>` tag and runs against that DOM.** Leptos itself only owns the
date/status filter bar and the Save button; it does not track the grid's row/cell state reactively.
Sidebar entry: visible to staff with `edit_resource_usage_today` or `view_resource_usage_history`
permission, and to admins.

**Data on mount / on filter change:** `GET /api/admin/resource_usages/grid?date={date}&status_id={status}`
→ `GridView` JSON:
```
GridView {
  date: String,
  can_edit: bool,
  statuses: Vec<{ id, name }>,           // for the status filter <select>
  rows: Vec<{
    project_id, project_title,
    concept_id, concept_name, status_name,
    quantity: f64, unit: String,
    cells: Vec<{                          // exactly 24, one per hour 0..23
      hour: i32,
      is_work_hour: bool,                 // true for 7..=22
      resources: Vec<{ resource_id, label, selected: bool }>,
    }>,
  }>,
}
```
`build_grid_html(&GridView)` turns this into the full `<table>` string (sticky first column, 24 hour
header columns, one row group per project with a colored divider row showing the project title/link, one
row per concept). Each cell is a `<button>` showing either "+" or the comma-joined selected resource
labels, plus a hidden dropdown menu (`data-resource-cell-menu`) of `<label><input type=checkbox
name="cell_{concept_id}_{hour}_{resource_id}" data-resource-id data-resource-label></label>` rows, one per
allowed resource for that concept (per `Resource.allowed_status_ids` matching the concept's current
status).

**Read-only gating:** a hidden marker div `<div data-resource-usage-editable="{true|false}">` carries
`view.can_edit`; `GRID_JS` reads that once via `dataset.resourceUsageEditable === "true"` before wiring any
click handlers — if not editable, checkboxes render `disabled` and no menu/cycle interactions attach at
all (not just visually disabled). This `can_edit` gate must be preserved as the single source of truth for
whether the grid is interactive in the Solid rebuild too.

**GRID_JS behavior (to reimplement natively in Solid, not string-inject):**
- Each cell shows a live label: comma-joined labels of checked resources, or "+" if none.
- **Short press** (pointerdown+pointerup < 450 ms) on a cell button: `cycleSingleResource` — clears all
  checkboxes in that cell, then checks the "next" resource after whichever was previously checked (cyclic
  single-select via tap). **Special case:** if nothing was checked at all in this cell, it first tries to
  **copy the previous hour's cell selection** (same row, previous DOM sibling cell) — if the previous cell
  had any checked resources that also exist as options in this cell, it copies them instead of falling
  through to "select the first option."
- **Long press** (≥450 ms): toggles open a small floating menu (`data-resource-cell-menu`) with full
  multi-select checkboxes for that cell — lets you check more than one resource for the same hour. Only
  one menu is open at a time (`closeMenus`); clicking outside any cell closes all menus.
- Checkbox `change` on any input updates that cell's live label immediately.

**Save button** (visible only when `view.can_edit`): does **not** read from Leptos signals — it does
`host_el.query_selector_all("input[type='checkbox']:checked")`, parses each `name="cell_{concept}_{hour}_{resource}"`
back into `GridSelection { concept_id, hour, resource_id }`, and POSTs the **entire current selection
state of the whole visible grid in one shot**:
```
POST /api/admin/resource_usages/grid
GridSavePayload { date, status_id: Option<String> (None if filter == "all"), selections: Vec<GridSelection> }
```
On success, shows "Guardado" and increments a `reload` counter to refetch+re-render the grid from the
server (so it reflects whatever the backend actually persisted). On error, shows the humanized error.

**Filter bar:** Fecha (`type=date`, default today via `js_sys::Date`), Estado (`Select`, "Todos" + all
concept statuses from `meta.statuses`, populated after first successful grid load — so on first paint only
"Todos" exists). "Filtrar" submit re-fetches with the new date/status (does not preserve unsaved local
checkbox edits — they're wiped because filtering re-renders `innerHTML` from a fresh fetch, so unsaved
changes are lost on filter/reload, matching current behavior).

**Reused components:** `Button`, `Input`, `Select` for the filter bar only — the grid itself uses zero
Leptos components (all string-built HTML).

**Porting note for Solid:** Rebuild the grid as real Solid components/signals (e.g. a `createStore` of
`{ [conceptId]: { [hour]: Set<resourceId> } }`), replacing:
- the long-press/short-press gesture logic (keep the same UX: tap cycles single resource with
  copy-from-previous-hour fallback; long-press opens multi-select menu),
- the disabled/read-only gate (`can_edit` from the GET response),
- the single bulk-save POST semantics (collect the *entire current grid selection* client-side, not
  per-cell PATCHes — this matches how the backend endpoint is shaped, one `GridSavePayload` per date+status
  filter).
Keep the `concept_id + hour + resource_id` selection identity model since that's the API contract
(`GridSelection`), even though the DOM `name="cell_..."` attribute encoding is purely an implementation
detail of the current version and doesn't need to survive the port.

---

## Tiempo (financial timeline) — `/v2/tiempo` ("Tiempo")

**File:** `frontend/src/pages/tiempo.rs`

**Purpose:** A horizontal, infinite-scrolling financial timeline (day/week/month/year granularity) showing
cumulative real vs. planned cash flow, with per-bucket transaction/planned-entry line items and inline
bulk-pay. Explicitly documented in the file header as "ported verbatim" from a pre-Leptos v1 vanilla-JS
widget and **should be rebuilt natively in Solid, not ported as a JS blob.** Sidebar entry gated on
`view_timeline` permission (staff) or admin.

**Mount behavior:** Leptos renders a single empty host `<div>`; on mount, `set_html` injects the static
`TIEMPO_HTML` markup (mode buttons, "Ir a hoy" button, hidden bulk-pay button, chart legend, viewport/strip
containers), then `run_script` appends `TIEMPO_JS` as a `<script>` tag that self-initializes
(`void setMode(mode)` at the bottom, `mode` starts as `"month"`). All state (mode, scroll origin, fetched
buckets, chart points, bulk-pay selection) lives in JS closures — nothing is exposed back to Leptos/Rust.

**Data endpoint:** `GET /api/tiempo?mode={day|week|month|year}&from={ISO}&to={ISO}` → JSON array of
bucket objects (no explicit Rust type — consumed only by JS):
```
[{
  start: ISOString,                    // bucket start (UTC)
  cumulative_real: number,
  cumulative_planned: number,
  real_income: number, real_expense: number, net_real: number,
  planned_income: number, planned_expense: number, net_planned: number,
  transactions: [{ type: "income"|"expense"|..., amount: number, description: string }],
  planned_entries: [{ id, name, status: string, flow_type: "income"|"expense", amount_estimated: number }],
}, ...]
```
`from`/`to` are computed client-side to cover the currently-buffered window (200 virtual cells centered on
`origin`, buffer-refetch triggered by scroll — see below).

**Rendering model (what to rebuild, not port):**
- **Virtualized horizontal strip:** 200 fixed-width (560px) cells pre-created once; each cell shows a
  bucket label/value header, a metrics table (Real vs Plan rows × Ingresos/Gastos/Total/Acumulado columns,
  color-coded pill badges — green if positive, red if negative, gray if zero), and a list of that bucket's
  transactions + planned entries.
- **Infinite scroll:** tracks `viewport.scrollLeft`; when the visible index gets within `BUFFER=40` cells
  of either edge of the 200-cell strip, it shifts `origin` by the delta, re-renders all cell labels/content
  for the new window, snaps `scrollLeft` back by the same delta (so the user doesn't see a jump), and
  fires a new `/api/tiempo` fetch for the newly-needed range. This is the classic "recenter a fixed window"
  virtualization trick — in Solid this could be replaced by a proper virtualized list or an equivalent
  windowed-fetch strategy; it does not need bucket-for-bucket parity, just the same infinite-scroll UX.
- **Mode switch (Día/Semana/Mes/Año buttons):** recomputes the anchor date at the current scroll offset in
  the *old* mode, sets it as the new mode's `baseDate`, resets `origin` to 0, clears cached buckets,
  re-renders, recenters the scroll position (twice — before and after `requestAnimationFrame`, to avoid a
  flash), then refetches.
- **"Ir a hoy" button:** resets to today, same recenter+refetch dance.
- **Chart:** an SVG line chart (`renderChart`) rendered fresh on every `renderCells()` call, drawn from the
  currently *visible* cells' cumulative real/plan values — two paths (purple = plan, sky blue = real),
  with per-point value labels (rounded-rect + text) and horizontal gridlines with currency-formatted tick
  labels (`Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' })`). Renders "Sin datos en
  rango" when there are no points.
- **Bulk pay:** each planned-entry line item that isn't `covered`/`cancelled` gets a checkbox
  (`data-timeline-bulk-pay`, tracked in a JS `Set<id>` — persists across re-renders/scroll since it's
  outside the bucket cache) and a per-item "Pagar" link
  (`/admin/planned_entries/{id}/pay?return_to=/v2/tiempo` — a **non-SPA, server-rendered v1 route**, full
  page navigation). The floating "Pagar seleccionados (N)" button (shown only when the set is non-empty)
  navigates to `/admin/planned_entries/bulk_pay?ids=...&return_to=/v2/tiempo` — also a full navigation to a
  legacy server route, not an API call.

**Reused components:** none — zero Leptos components involved beyond the host `<div node_ref>`.

**Porting note for Solid:** Treat this as a fresh native build against the same `GET /api/tiempo` contract
above, not a literal JS port. Priorities to preserve: the mode switcher (day/week/month/year), the
infinite horizontal scroll feel, the cumulative real/plan chart, the per-bucket transaction/planned-entry
breakdown, and the bulk-pay flow. Flag to the orchestrator/product owner whether the pay/bulk-pay actions
should become in-SPA calls instead of full navigations to legacy `/admin/planned_entries/...` routes, since
those server-rendered routes may not exist post-migration.

# SolidJS migration notes — pages, part 1

Source: original `frontend/src/pages/*.rs` (Leptos/WASM SPA). Router: `frontend/src/app.rs`.
The source app was mounted under `<Router base="/v2">`; the current Solid app is served under `/v3`.
Route tables below use route-relative paths unless a full historical `/v2/...` URL is called out.

---

## Shared layout (`frontend/src/app.rs`)

### Bootstrap / auth
- `App` calls `api::get_me()` once on mount. 401 → renders `LoginView` (email + 6-digit TOTP code form, posts to `api::login`, then either full-page redirects to `redirect_url` (tenant subdomain) or re-fetches `get_me`). Success → renders `AuthedApp` with `Me` and an `auth` `RwSignal` in context.
- `Me` (from `api::get_me`) carries: `username`, `role` ("admin"/other), `company`, `company_slug`, `companies: Vec<{slug, name, active}>`, and a permission-check `me.can("perm_name")` used for staff nav gating (`view_timeline`, `view_projects`, `edit_resource_usage_today`, `view_resource_usage_history`).

### AuthedApp shell
`<div class="flex min-h-screen">` → `Sidebar` (fixed width aside) + right column (`Topbar` + `<main>` routed content).

### Router table (leptos_router `Routes`)
| Path | Component |
|---|---|
| `/` | `Dashboard` |
| `/accounts` | `AccountsPage` |
| `/categories` | `CategoriesPage` |
| `/contacts` | `ContactsPage` |
| `/transactions` | `TransactionsPage` |
| `/recurring-plans` | `RecurringPlansPage` |
| `/planned-entries` | `PlannedEntriesPage` |
| `/forecasts` | `ForecastsPage` |
| `/orders` | `OrdersPage` (not in this doc batch) |
| `/projects`, `/projects/:id` | `ProjectsPage`, `ProjectDetailPage` (not in this batch) |
| `/concept-statuses` | `ConceptStatusesPage` (not in this batch) |
| `/resources`, `/resource-logs`, `/resource-usages` | (not in this batch) |
| `/tiempo` | `TiempoPage` (not in this batch) |
| `/cfdi` | `CfdiPage` |
| `/companies` | `CompaniesPage` (not in this batch) |
| `/users` | `UsersPage` (not in this batch) |
| `/sat-configs` | `SatConfigsPage` |
| `/account` | `AccountPage` |
| fallback | "No encontrado" |

**Note:** `frontend/src/pages/charts.rs` exists (`pub(crate) mod charts` in `mod.rs`, not exported publicly) but is **not a route** — it's a helper module of two pure SVG-string builder functions (`line_area_chart`, `donut`) consumed by `transactions.rs` and `cfdi.rs` for inline chart rendering. There is no standalone "Charts" page/route in the app.

### Sidebar (`Sidebar` component)
Static links (always visible): "Inicio" (`/`), conditionally "Tiempo" (`/tiempo`, gated by `can_timeline`), "Mi cuenta" (`/account`).
Then role/permission-gated `<NavGroup>` accordions (native `<details open>`, chevron rotates via CSS, indented guide-rail):
- **Non-admin staff**, if `can_projects || can_resource_usage`: one group **"Operaciones"** with conditionally "Proyectos" and "Uso de recursos (grid)".
- **Admin** gets the full menu:
  - **"Finanzas"**: Cuentas, Categorías, Contactos, Movimientos, Planes recurrentes, Entradas planificadas, Pronósticos.
  - **"Operaciones"**: Órdenes, Proyectos, Estados de concepto, Recursos, Registros de recursos, Uso de recursos (grid).
  - **"Fiscal"**: CFDIs, Config. SAT.
  - **"Administración"**: Compañías, Usuarios.
- Active link styled via `aria-[current=page]` (leptos_router sets `aria-current="page"` on the matching `<A>`).

### Topbar (`Topbar` component)
Left: username + company name (stacked), role `Badge` (Info tone for admin, Neutral for staff).
Right: theme toggle button (🌙/☀️ emoji, persisted via `crate::theme` to localStorage + `<html>` class), `CompanySwitcher`, "Salir" (logout) button — logout calls `api::logout()` then sets auth to `Anon`.

### CompanySwitcher
Hidden entirely if the user belongs to ≤1 company. Otherwise a `<Select>` of `me.companies`; changing it triggers `window.location.href` full navigation to `switch_company_href(slug)` = `{protocol}//{slug}.{root-domain}/v3/` (subdomain swap, lands on `/v3/` of the target tenant). Session cookie is shared cross-subdomain so no re-login needed.

---

## Shared helpers (`frontend/src/pages/mod.rs`) — reused by nearly every page below

- **Option loaders** (`RwSignal<Options>` where `Options = Vec<(id, label)>`), fire-and-forget `spawn_local` on mount: `load_account_options`, `load_category_options`, `load_contact_options`, `load_project_options`, `load_planned_entry_options`, `load_resource_options`, `load_concept_status_options`.
- **Badge renderers** (wrap the shared `Badge` component): `flow_badge` (income=Success/green, expense=Danger/rose), `bool_badge(on, yes_label, no_label)` (Success/Neutral), `status_badge(label)` (keyword-sniffs Spanish words to pick tone: cancel→Neutral, vencid/atras/overdue→Danger, parcial→Warning, cubiert/pagad/complet/termin/cerrad/listo→Success, plan/pendiente/proceso→Info, else Neutral), `priority_badge`, `role_badge`, `type_badge` (generic Info pill, used for account type).
- **`money(f64) -> String`**: `$1,232,543.90` style — thousands separators, 2 decimals, leading `-$` for negatives.
- **Date helpers**: `date_to_rfc3339` (`<input type=date>` → RFC3339 midnight UTC), `rfc3339_to_date` (inverse, for pre-filling edit forms), `local_dt_to_rfc3339`/`rfc3339_to_local_dt` (datetime-local ↔ RFC3339).
- **`flow_label`**: "income"→"Ingreso", "expense"→"Egreso".
- All of these need a straight port to Solid as plain TS utility functions + small `<Badge>`-wrapping components.

---

## Page-by-page

### Dashboard
- **Route**: `/` — **Title**: "Inicio"
- **Purpose**: landing page, lists the companies the user belongs to as a switch-tenant menu.
- **Data loaded**: none via API — uses `Me` from context (already loaded at app bootstrap), specifically `me.companies`.
- **UI**: `<h1>` + `<h2>"Compañías"</h2>` + `<ul>` of company names as links. Active company bold ("(activa)" suffix); others muted with hover underline.
- **Actions**: clicking a company name is a plain `<a href=switch_company_href(slug)>` — full navigation (not SPA nav), same subdomain-swap mechanism as `CompanySwitcher`.
- **Components reused**: none (no Card/Badge/etc.) — simplest page in the app.
- **Tricky bits**: none. Trivial to port.

---

### AccountsPage
- **Route**: `/accounts` — **Title**: "Cuentas"
- **Purpose**: CRUD for bank/cash/credit-card/investment/other accounts.
- **Data loaded on mount**: `api::list_accounts()` → `GET` accounts list, into `items: RwSignal<Option<Result<Vec<Account>, ApiError>>>` (the `None`/`Some(Err)`/`Some(Ok(empty))`/`Some(Ok(list))` 4-state pattern recurs on every list page in this doc).
- **Form fields** (admin-only, hidden entirely for staff — role gate is UI-only, backend also enforces admin-only): Nombre (text, required), Tipo (`<Select>` of `ACCOUNT_TYPES` const: bank/cash/credit_card/investment/other → Spanish labels), Moneda (text, default "MXN"), Notas (text), Activa (`Checkbox`, default true). Create vs Edit toggles button label/card title; "Cancelar" appears only while editing.
- **Table columns**: Nombre, Tipo (`type_badge`), Moneda, Estado (`bool_badge` Activa/Inactiva), row actions (Editar/Eliminar, admin-only).
- **Actions**:
  - Create/Update → `Action::new_local` dispatches `api::create_account`/`api::update_account(id, payload)`; on success resets form + reloads list; on error shows humanized error under the form.
  - Edit → fetches full `AccountDetail` via `GET /api/admin/accounts/{id}` to populate the form, sets `editing = Some(id)`.
  - Delete → `api::delete_account(id)` then reload, no confirm dialog.
- **Empty/loading/error states**: "Cargando…" / "No se pudieron cargar las cuentas." / "Sin cuentas todavía." — same three-line pattern reused everywhere.
- **Components reused**: `Card/CardHeader/CardContent/CardTitle`, `Input`, `Select`, `Checkbox`, `Button` (variants: default, Outline for Cancel, Ghost for row actions, Ghost+red for delete).
- **Tricky bits**: `is_active`/`notes` explicitly "preserved hidden" across edit per code comment — i.e. form always carries these fields even though not all are re-editable-looking; account type validity list is a hardcoded const shared with `account_type_label()` (unit-tested).

---

### CategoriesPage
- **Route**: `/categories` — **Title**: "Categorías"
- **Purpose**: CRUD for income/expense categories with optional parent (hierarchical).
- **Data loaded**: `GET /api/admin/categories` → `items`; plus `load_category_options` into a separate `cat_opts` signal for the parent-category `<Select>` (so the picker list is independent of the table's loading state and doesn't get affected by table reloads' `None` flash).
- **Form fields**: Nombre (required), Flujo (`<Select>` Ingreso/Egreso, plain hardcoded options not badge-driven), Categoría padre (optional `<Select>` populated from `cat_opts`, "— Ninguna —" default).
- **Table columns**: Nombre, Flujo (`flow_badge`), Padre (plain text, muted), row actions.
- **Actions**: create → `POST /api/admin/categories`; update → `POST /api/admin/categories/{id}/update`; delete → `POST /api/admin/categories/{id}/delete`; edit fetches `CategoryDetail` via `GET /api/admin/categories/{id}`.
- **Components reused**: Card/Input/Select/Button.
- **Tricky bits**: parent-category self-reference isn't guarded client-side (no filtering out the category being edited from its own parent options) — worth checking backend validation when porting; note the API uses POST-with-suffix (`/update`, `/delete`) rather than PUT/DELETE verbs, unlike `accounts.rs` which uses `api::update_account`/`api::delete_account` typed helpers hitting real REST verbs. Inconsistent API shape across pages — must check `api.rs` per-entity when porting each page's calls.

---

### ContactsPage
- **Route**: `/contacts` — **Title**: "Contactos"
- **Purpose**: CRUD for customers/suppliers/service/other contacts.
- **Data loaded**: `GET /api/admin/contacts` → `items`.
- **Form fields**: Nombre (required), Tipo (`<Select>` of `CONTACT_TYPES` const: customer/supplier/service/other), Correo (email input), RFC (text), Teléfono (text), Notas (text). All optional fields go through an `opt()` helper that trims and turns empty string into `None`.
- **Table columns**: Nombre, Tipo (plain text `c.kind`, **not** badge-wrapped — inconsistent with Categories/Accounts which do badge their type/flow column), Correo (muted), row actions.
- **Actions**: create `POST /api/admin/contacts`; update `POST /api/admin/contacts/{id}/update`; delete `POST /api/admin/contacts/{id}/delete`; edit fetches `ContactDetail`.
- **Components reused**: Card/Input/Select/Button.
- **Tricky bits**: the Tipo column being plain text while Accounts/Categories/Transactions use badges is worth normalizing when rebuilding in Solid (call it a UX gap in v1, or intentionally reuse `type_badge` for consistency).

---

### TransactionsPage
- **Route**: `/transactions` — **Title**: "Movimientos"
- **Purpose**: CRUD for income/expense/transfer transactions, plus an inline analytics dashboard computed client-side from the loaded list.
- **Data loaded**: `GET /api/admin/transactions/data` → `items: Vec<Transaction>`; option loaders for `categories`, `accounts`, `planned` (planned entries, for optional "compromiso ligado" link).
- **Form fields** (3-col grid): Fecha (date, required), Descripción (required), Tipo (`<Select>` income/expense/transfer), Categoría (required select), Monto (decimal text input), Cuenta origen / Cuenta destino (both optional selects — relevant for transfers), Compromiso ligado (optional select of planned entries), Notas, Confirmado (`Checkbox`, default true).
- **Client-side validation**: fecha, descripción, categoría required before dispatch.
- **Charts block** (`tx_charts`, only rendered when list non-empty): computed by iterating all loaded transactions —
  - Groups by `date[..7]` (YYYY-MM) into monthly `(income, expense)` sums → feeds `line_area_chart` (custom SVG line+area, from `charts.rs`).
  - Total income/expense/net → 3 KPI cards + a `donut` SVG (Ingresos green / Egresos rose, center label = net formatted with `money()`).
  - Groups by category into `(income, expense, transfer, count)`, sorted by total desc, **truncated to top 8**, rendered as horizontal 3-segment stacked mini-bars (green/rose/blue) with a `"N mov."` count caption.
  - This is meaningful business logic to port faithfully — it's not just a table wrapper.
- **Table columns**: Fecha, Descripción, Tipo (custom local `tx_badge`: income=Success, expense=Danger, transfer=Info), Monto (`money()`), Categoría (muted), row actions.
- **Actions**: create `POST /api/admin/transactions`; update `POST /api/admin/transactions/{id}/update`; delete `POST /api/admin/transactions/{id}/delete`; edit fetches `TransactionDetail`.
- **Components reused**: Badge (locally re-derives a `tx_badge` rather than reusing `flow_badge` because it has a 3rd "transfer" state), Card/Input/Select/Checkbox/Button.
- **Tricky bits**: the SVG chart math (`line_area_chart`/`donut` in `charts.rs`) needs a Solid equivalent — either port the pure string-building functions 1:1 (they take plain data tuples and return an SVG string) or replace with a charting library; either is fine since it's pure functions with no framework coupling. Also note `account_from_id`/`account_to_id` are both optional and both selects share the exact same accounts option list — likely needs a "can't be the same account" validation check when porting (not currently enforced in this file).

---

### RecurringPlansPage
- **Route**: `/recurring-plans` — **Title**: "Planes recurrentes"
- **Purpose**: CRUD for recurring income/expense templates (monthly/weekly) that generate `PlannedEntry` rows, plus a "Generar" action to materialize entries from a plan.
- **Data loaded**: `GET /api/admin/recurring-plans` → `items`; option loaders for `categories`, `accounts`, `contacts`.
- **Form fields** (3-col grid): Nombre (required), Flujo (income/expense), Frecuencia (monthly/weekly), Categoría (required select), Cuenta esperada (required select), Monto estimado (decimal), Inicio (date, required), Término (optional date), Día del mes (optional numeric — relevant for monthly frequency), Contacto (optional select), Notas, Activo (`Checkbox`).
- **Hidden/preserved field**: `version: i32` (default 1) — carried through edit without a form control; sent back unchanged in the update payload. Comment: "Preserved hidden across edits."
- **Table columns**: Nombre, Flujo (`flow_badge`), Monto (`money`), Frecuencia (plain text), Activo (`bool_badge` Sí/No), row actions: **Generar**, Editar, Eliminar.
- **Actions**:
  - Create/Update → `POST /api/admin/recurring-plans[/{id}/update]`.
  - Delete → `POST /api/admin/recurring-plans/{id}/delete`.
  - **Generar** → `POST /api/admin/recurring-plans/{id}/generate` (idempotent per version per backend comment in `CLAUDE.md`: "incrementing `version` marks existing `PlannedEntry` records as outdated"). Shows an inline green success message "Entradas generadas" or a humanized error (e.g. plan inactive) above the form — message persists until next generate call, no auto-dismiss.
- **Components reused**: Card/Input/Select/Checkbox/Button, `flow_badge`/`bool_badge`/`money` helpers.
- **Tricky bits**: the `version` field is invisible in the UI but semantically important (backend's outdated-entries marking) — must be round-tripped correctly in the Solid port (read on edit-fetch, resent unchanged on update) even though there's no visible input for it. The "Generar" flow's success/error message state (`generated: RwSignal<Option<String>>`) is a single shared banner for the whole list, not per-row.

---

### PlannedEntriesPage
- **Route**: `/planned-entries` — **Title**: "Entradas planificadas"
- **Purpose**: CRUD for planned/expected entries (the concrete instances a `RecurringPlan` generates, or manually created ones), with a payment workflow (single pay + bulk pay) and a status pipeline.
- **Data loaded**: `GET /api/admin/planned-entries` → `items`; option loaders for `categories`, `accounts`, `contacts`, `projects`.
- **Form fields**: Nombre (required), Flujo, Estado (`<Select>` of `STATUSES` const: planned/partially_covered/covered/overdue/cancelled → Spanish labels), Categoría (required), Cuenta esperada (required), Monto estimado, Vencimiento (date, required), Contacto (optional), Proyecto (optional), Notas.
- **This is the most stateful page in the batch** — three overlapping interaction modes:
  1. **Main CRUD form** (create/edit), same pattern as other pages.
  2. **Single "Pagar" flow**: clicking Pagar on a row sets `paying = Some(id)`, opens a separate emerald-bordered Card below with its own form (Fecha de pago, Monto real pagado, Cuenta, Notas) and its own `Action` → `POST /api/admin/planned-entries/{id}/pay` with `PlannedEntryPayPayload`. Cancel closes it. Independent pending/error state from the main form.
  3. **Bulk pay flow**: each row (admin-only) has a checkbox (`selected: RwSignal<Vec<String>>`, toggled via `toggle_sel`). When `selected` is non-empty and the bulk panel isn't open, a small bar shows "{n} seleccionadas" + "Pagar seleccionadas" button. Clicking it resets bulk form fields and opens a Card ("Pagar N entradas") with Fecha de pago + Cuenta (shared across all selected) + Notas, submitting `POST /api/admin/planned-entries/bulk-pay` with `entry_ids: selected`. On success, clears selection and closes panel.
- **Table columns**: checkbox (admin-only), Nombre, Flujo (`flow_badge`), Monto (`money`), Vence (`due_date`, muted), Estado (`status_badge`, using `status_label` from API if present else falling back to raw `status`), row actions: **Pagar** (emerald-tinted Ghost button), Editar, Eliminar.
- **Actions summary**: create `POST /api/admin/planned-entries`; update `.../{id}/update`; delete `.../{id}/delete`; pay `.../{id}/pay`; bulk-pay `POST /api/admin/planned-entries/bulk-pay`.
- **Components reused**: Card ×3 (main form, pay form, bulk form), Input/Select/Button, `flow_badge`/`status_badge`/`money`.
- **Tricky bits (highest complexity page in this batch)**:
  - Three independent forms with three independent `Action`/pending/error signal sets need careful state modeling in Solid (e.g. separate stores or a discriminated-union UI-mode signal).
  - Selection state (`Vec<String>` of ids) + derived "n selected" bar visibility + the constraint that the bulk panel and the "n selected" bar are mutually exclusive (`!bulk_open.get()`).
  - `status_label` vs `status` fallback logic for display.
  - `project_id: None` is hardcoded in both pay payloads (not wired to a project picker in the pay/bulk-pay forms even though PlannedEntry itself has an optional project) — worth flagging as a possible v1 gap rather than assuming it's intentional.

---

### ForecastsPage
- **Route**: `/forecasts` — **Title**: "Pronósticos"
- **Purpose**: CRUD for named financial-scenario forecasts (projected income/expense/net over a date range, optional initial/final balance).
- **Data loaded**: `GET /api/admin/forecasts` → `items`.
- **Form fields** (3-col grid): Escenario (optional scenario name, spans full width), Desde/Hasta (dates, required), Moneda (text, default MXN), Ingreso proyectado / Egreso proyectado (decimal), Saldo inicial / Saldo final (optional decimals), Detalles (optional text).
- **Computed field**: `projected_net = income - expense`, computed client-side at submit time, not user-editable directly.
- **Hidden/preserved field**: `generated_at` — on create defaults to `start_date`'s ISO value; on edit, preserved from the fetched detail (`gen_at: RwSignal<Option<String>>`) and resent unchanged.
- **Table columns**: Escenario (falls back to empty string if None), Periodo (`"{start} → {end}"`), Neto (`money`), Moneda, row actions.
- **Actions**: create `POST /api/admin/forecasts`; update `.../{id}/update`; delete `.../{id}/delete`; edit fetches `ForecastDetail`.
- **Components reused**: Card/Input/Button (no Select — plain text input for currency, unlike Accounts).
- **Tricky bits**: `num()`/`opt_num()` local helpers for required-vs-optional decimal parsing (empty string → `None` vs `0.0`) — same pattern needed generically across money-input pages; `generated_at` hidden round-trip similar in spirit to `RecurringPlan.version`.

---

### charts.rs (helper module, not a route)
- **Purpose**: two pure functions producing raw SVG markup strings, injected via `inner_html` by consuming pages (`transactions.rs`, `cfdi.rs`). No component, no state, no API calls.
- `line_area_chart(data: &[(label, income, expense)]) -> String`: 560×130(+28 padding) viewBox line+area chart, green income / rose expense, gridlines at 0/50/100% of max, up to ~7 x-axis labels (month suffix, `label[2..]`), "Sin datos" placeholder when empty.
- `donut(segments: &[(label, value, css_color)], center_value, center_label) -> String`: 144×144 viewBox ring chart (r=54, stroke-width=20), each segment as a `stroke-dasharray`/`rotate` arc, centered value/label text (`money()`-formatted net, typically).
- **Port strategy**: straightforward to port as plain TypeScript functions returning SVG strings or, better, as Solid components that build the same SVG. No third-party chart lib was used in v1 — a faithful port can also skip a chart library.

---

### CfdiPage
- **Route**: `/cfdi` — **Title**: "CFDIs"
- **Purpose**: read-only list of imported SAT invoices (CFDIs) with client-computed KPIs/charts, plus (admin-only) a "download from SAT" panel that kicks off async backend jobs (chunked per month) and polls until done.
- **Data loaded on mount**:
  - `GET /api/admin/cfdis/data` → `CfdiList { items: Vec<Cfdi> }` for the table + charts.
  - Admin-only: `GET /api/admin/sat-configs` → populates the SAT-config `<Select>` in the download form, auto-selects the first config.
  - Admin-only: immediately starts `poll_jobs()` to surface any in-flight download jobs from a previous visit (`GET /api/admin/companies/{cid}/cfdi/jobs`, polled every 4s while any job is `queued`/`running`).
- **Download form fields** (admin, only shown if `configs` non-empty — else an amber "no SAT config" hint): Configuración SAT (select, label falls back to RFC if no label), Tipo (`both`/`issued`/`received`), Desde/Hasta (dates, defaulting to 5-years-ago-Jan-1 → today), Crear pagos automáticamente (`Checkbox`).
- **Client validation**: Solid validates dates as exact `YYYY-MM-DD` and `Desde <= Hasta` before calling the backend. This prevents browser date inputs or manual edits from sending extended-year strings like `20206-06-01`.
- **Download action**: `POST /api/admin/companies/{cid}/cfdi/download` with `CfdiDownloadPayload`; on success starts polling; submit button disabled while the mutation is pending or any job is active. Backend splits the range into one background job per month. `both` means each monthly job calls SAT twice: issued + received.
- **Jobs table** (shown only once `jobs` non-empty): Período, Estado (`status_badge`: queued="En cola"/muted, running="● Descargando"/sky, done="✓ Listo"/emerald, failed="✗ Error"/rose), Encontrados, Creados, Actualizados, Omitidos, Errores.
  - Job status shape is discriminated: `queued`/`running` only include `{ status }`; `done` includes counters plus `errors[]`; `failed` includes `error`.
  - Counters render as `0` until `done`.
  - Errores renders `0` when empty; otherwise the count is a button that opens a Kobalte `Modal` with every error message.
- **Charts** (`cfdi_charts`, shown when `data.items` non-empty): same shape as `tx_charts` in transactions.rs — filters out payment-complement CFDIs (`tipo == "P"`) and non-positive totals, buckets by month into emitidos(issued)/recibidos(received) sums, renders 3 KPI cards + `line_area_chart` + `donut` (green emitidos / rose recibidos, center = net).
- **Table columns**: Folio, Tipo, Fecha (`rfc3339_to_date`), Emisor, Receptor, Total (`money(total) + moneda`), Dirección (Badge: Emitido=Success / Recibido=Info).
- **No create/edit/delete** on this page — CFDIs are only imported via the download flow, never hand-entered.
- **Components reused**: Badge, Card, Checkbox, Input, Select, Button — plus the `charts.rs` SVG helpers.
- **Tricky bits**: the async job-polling loop is implemented with `solid-query` `refetchInterval`, active only while any job is `queued`/`running`, so it cleans up with the component observer. Backend job data is in-memory only (`AppState.jobs`) and disappears on restart/deploy; do not promise historical job/error visibility unless persistence is added. SAT rejection `5002` ("Se han agotado las solicitudes de por vida") is definitive for that criterion and the backend must not retry it.

---

### SatConfigsPage
- **Route**: `/sat-configs` — **Title**: "Configuraciones SAT"
- **Purpose**: manage stored CSD (digital signature) certs for the active company — upload `.cer`+`.key`+password via multipart, list, delete. No edit (re-upload to replace, per file header comment).
- **Data loaded**: `GET /api/admin/sat-configs` → `items`.
- **Form fields**: Etiqueta (optional label, free text with helper caption), RFC (required, uppercase-styled input), Certificado `.cer` (native `<input type=file accept=.cer>` via `NodeRef`, not the shared `Input` component), Llave privada `.key` (same, `accept=.key`), Contraseña de la llave privada (password input, required).
- **Client-side validation**: both files present, RFC non-empty, password non-empty — else inline error, no dispatch.
- **Upload action**: `Action::new_local` taking `(rfc, label, password, File, File)` tuple → `api::upload_sat_config(...)` (presumably a `multipart/form-data` POST — worth checking `api.rs` for exact implementation when porting, since Solid's fetch-based multipart upload needs the equivalent `FormData` construction). On success resets the form (including clearing native file inputs via `el.set_value("")`) and reloads.
- **Table columns**: RFC (bold), Etiqueta (muted, empty fallback), Creada (`created_at[..10]`, i.e. date-only), row action: Eliminar only (no edit).
- **Delete**: `POST /api/admin/sat-configs/{id}/delete`, no confirm dialog.
- **Components reused**: Card/Input/Button; raw `<input type=file>` (styled manually with `file:` Tailwind classes) rather than the shared `Input` — Solid port needs its own file-input styling/component since none of the shared components cover file inputs.
- **Tricky bits**: multipart file upload with two files + text fields — `api::upload_sat_config` signature should be checked in `frontend/src/api.rs` before porting to know exact `FormData` field names; file input reset-after-success uses raw DOM `NodeRef.set_value("")` since file inputs are uncontrolled — Solid equivalent likely needs a ref + manual clear too (React/Solid can't set `.value` on file inputs to anything but empty string, which matches).

---

### AccountPage ("Mi cuenta")
- **Route**: `/account` — **Title**: "Mi cuenta"
- **Purpose**: the logged-in user's own profile editor — change username/email and optionally rotate their TOTP secret. Available to all authenticated users (not admin-gated) since it's self-service.
- **Data loaded on mount**: `GET /api/account` → `ProfileData { username, ... }`, pre-fills the `email` field (note: field is visually labeled "Usuario" and typed as `email` signal — naming mismatch between "email" var name and "Usuario"/username semantics worth normalizing in the Solid port, e.g. rename to `username`).
- **Form fields**: Usuario (text, `autocomplete="username"`, required), Secreto TOTP (font-mono text input, placeholder "Déjalo vacío para conservar el actual" — i.e. blank means "keep current secret", not "clear it").
- **Action**: single `Action` → `POST /api/account` with `ProfilePayload { username, secret }`. Success shows a green confirmation message ("Tu información se guardó correctamente"); error shows humanized message. No navigation/redirect on save.
- **Components reused**: Card/Input/Button. No table, no list, no delete — pure single-entity settings form, simplest CRUD-adjacent page besides Dashboard.
- **Tricky bits**: the "empty secret = keep existing" semantic needs a clear UI affordance in Solid too (currently just a placeholder hint, easy to misread as "will be cleared") — otherwise trivial to port.

---

## Cross-cutting patterns worth encoding once in the Solid port

1. **List-page skeleton**: `items` resource → 4-state render (loading/error/empty/list) — identical across Accounts, Categories, Contacts, Transactions, RecurringPlans, PlannedEntries, Forecasts, SatConfigs, Cfdi. Should become one generic `<DataTable>`/`useListResource` pattern in Solid rather than copy-pasted per page.
2. **Create/edit form skeleton**: single form doubles as create+edit via an `editing: Option<id>` signal; `reset_form()` clears all fields; submit dispatches to two different endpoints based on `editing`; success resets+reloads, error sets a form-level (not per-field) error string. Identical shape on 7 of these pages.
3. **Admin-only gating**: most pages hide the entire create/edit Card (and row action buttons) behind `me.role == "admin"` as a **UX-only** convenience — the task description confirms backend also enforces it server-side, so Solid port must not treat client-side role checks as the security boundary, just mirror them for UX parity.
4. **API call-shape inconsistency**: some entities use typed REST-verb helpers (`api::create_account`, `api::update_account`, `api::delete_account`), others use raw `POST .../create|update|delete` suffix endpoints via `api::post_json`/`api::post_empty`/`api::get_json` with string-built URLs. When porting each page's data layer to Solid, check the actual `frontend/src/api.rs` signatures rather than assuming REST verbs.
5. **money()/date formatting helpers** and the **badge-tone helper functions** in `mod.rs` should become a small shared `lib/format.ts` + `<Badge>`-derived components in Solid, used exactly as here.

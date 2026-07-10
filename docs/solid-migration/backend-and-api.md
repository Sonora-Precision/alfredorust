# Backend & API reference for the SolidJS rewrite

Generated from the Axum backend and the original Leptos/Rust WASM SPA contract.
As of 2026-07-08, the SolidJS SPA in `solid/` is the deployed SPA under `/v3`;
the old Leptos `frontend/` remains in the repo but is no longer served/built.
The API contract remains the same absolute `/api/...` cookie-authenticated
surface.

Source files read: `src/main.rs`, `src/session.rs`, `src/routes/login.rs`,
`src/routes/logout.rs`, `src/routes/profile.rs`, `src/routes/pdf.rs`,
`src/routes/qrcode.rs`, `src/routes/tiempo.rs`, `src/routes/sat.rs`,
`src/routes/admin/*.rs`, `src/models.rs`, `frontend/src/api/*.rs`,
`frontend/src/pages/*.rs`, and the deployed Solid implementation under
`solid/src/`.

---

## 1. How the SPA is served

In `src/main.rs` the SPA is mounted under `/v3`:

```rust
let spa_dir = std::env::var("SOLID_DIST").unwrap_or_else(|_| "solid/dist".to_string());
let spa_index = format!("{spa_dir}/index.html");
let spa_service = ServeDir::new(&spa_dir).fallback(ServeFile::new(spa_index));

let app = Router::new()
    .route("/", get(routes::home))
    .route("/login", post(routes::login))
    .merge(protected)      // all /admin/*, /api/*, /account, /pdf, /tiempo, etc.
    .merge(test_gated)     // /docs, /test, /test/reports — test-tenant only
    .nest_service("/v3", spa_service)
    .with_state(state);
```

- **Path prefix:** `/v3` — the built Solid SPA's static assets (`index.html`,
  JS bundle, CSS) are mounted with `nest_service("/v3", spa_service)`.
- **Directory served:** `solid/dist` by default, overridable via the
  `SOLID_DIST` env var.
- **Prefix stripping:** `nest_service` strips `/v3` before handing the path to
  `ServeDir`, so a request for `/v3/accounts` resolves against
  `solid/dist/accounts` inside the service.
- **SPA fallback:** `ServeDir::new(&spa_dir).fallback(ServeFile::new(spa_index))`
  — any path under `/v3` that doesn't match a real static file (e.g. a
  client-side route like `/v3/accounts`, `/v3/admin/projects/64f.../edit`)
  falls back to serving `index.html`, so the client-side router can take over.
- **NOT a global fallback:** the SPA service is only mounted at `/v3`. Any
  unmatched path outside `/v3` (e.g. a typo'd root path) still 404s — old
  pre-SPA behavior is unchanged for everything else.
- **Middleware on `/v3`:** none. The static file service is mounted directly
  on the top-level `app` Router, outside the `protected` router (which is the
  only place `session::require_session` is layered via `route_layer`). So the
  SPA's HTML/JS/CSS/WASM bundle is served **without** a session check —
  auth-gating happens client-side (the SPA calls `GET /api/me`, gets a 401,
  and redirects to `/login` itself). All the *data* endpoints the SPA calls
  (`/api/...`, `/admin/...`) live in `protected` and DO require a valid
  session cookie, checked per-request server-side.
- The SPA calls absolute `/api/...` paths, not `/v3/api`.

### Test-only surface (not relevant to the SPA, but exists on the same host)

`test_gated` mounts `/docs` (Swagger UI over `ApiDoc::openapi()`), `/test`
(a dashboard), and `/test/reports` (serves `TEST_REPORTS_DIR`, default
`test-reports/`, via `ServeDir`) — gated by `require_session` **and**
`require_test_tenant` (only visible when the active tenant slug equals
`TEST_TENANT_SLUG`, default `test`). Not part of the app's real UI.

---

## 2. Auth flow as the frontend sees it

### Tenant model
Companies are tenants selected by subdomain: `slug.alfredorivera.dev` in
prod, `slug.localhost:8090` (or `slug.<name>.local:8090`) in local dev.
`app.<domain>` and bare IPs never resolve to a tenant slug (see
`session::tenant_subdomain_from_host`). The slug is read from the `Host`
header on every request — `require_session` middleware re-derives the active
company on each request from the subdomain, it does NOT trust a
previously-selected company baked into the session token itself. If the
session's user isn't a member of the subdomain's company, the request gets a
401 (not a redirect).

### Login
`POST /login` (public, no session middleware)

Request body:
```json
{ "username": "user@example.com", "code": "123456" }
```
(`email` is accepted as a deprecated alias for `username` via `#[serde(alias = "email")]`.)

Response `200`:
```json
{ "ok": true, "redirect_url": "https://acme.alfredorivera.dev" | null }
```
`redirect_url` is `null` if the request's `Host` already matches the user's
company slug's target host (no redirect needed — e.g. already on the right
subdomain, or the user has no slug). Response `401`: `{"ok": false}`. `500`:
`{"error": "..."}`.

TOTP check: server rebuilds a TOTP against `(company_name, username, secret)`
and calls `check_current` (±1 step skew). No password — 6-digit code only.

**Cookies set on success** — `set_cookies_for_host` appends **multiple**
`Set-Cookie` headers, all named `session`, all `HttpOnly; SameSite=Lax; Path=/`
with `Max-Age` = `SESSION_TTL_SECONDS` (24h):
1. Host-only cookie, no `Domain` attribute (current host).
2. Two domain-scoped cookies for the current base host: `Domain=.<host_base>`
   and `Domain=<host_base>`.
3. If a "root domain" can be computed (via `BASE_DOMAIN` env var, or
   `localhost`, or `*.local` two/three-label heuristics): two more cookies
   scoped to the root domain (dotted + non-dotted), **plus** two more scoped
   to `<slug>.<root_domain>` (dotted + non-dotted) — pre-seeding the cookie
   for the tenant subdomain the browser is about to be redirected to, since
   that's a different origin the login response can't otherwise set a cookie
   for post-redirect.
   This is why login can set up to 7 `Set-Cookie` headers in one response.
4. Because multiple `session` cookies can be present at once (with
   overlapping domain scopes), `require_session` reads **all** `session`
   cookie values off the request and tries each until one resolves to a
   valid, non-expired session (`extract_cookies` splits on `;`, collects
   every `session=...` pair).

The SPA does **not** need to replicate this cookie logic — it's entirely
server-side. The SPA just needs to: (a) call `POST /login`, (b) if
`redirect_url` is present, `window.location.href = redirect_url` (this is a
cross-subdomain navigation, not an XHR redirect); (c) otherwise treat login
as complete and re-fetch `/api/me`.

### Logout
`POST /logout` (protected — requires a valid session). Deletes the session
row server-side and returns `Set-Cookie: session=; Max-Age=0` for the
host-only cookie plus the root-domain-scoped variants (dotted/non-dotted),
mirroring the domain computation from login. Response: `{"ok": true}` (200)
or `{"error": "..."}` (500). No redirect_url — the SPA/browser handles
navigating back to `/login` (or the login host) itself.

### Authenticated calls
Every protected request is same-origin (SPA served from the tenant
subdomain, API on the same host:port) and cookie-based — no bearer tokens,
no CSRF token observed. `Request::get/post(...).send()` from `gloo-net`
(current frontend) sends cookies automatically since it's same-origin; a
SolidJS `fetch` needs no special credentials mode either as long as it's
same-origin, but if calls ever cross-origin (e.g. local dev proxy setups),
remember to set `credentials: "include"`.

`GET /api/me` is the bootstrap call: `401` → anonymous (SPA should route to
`/login`); `200` → returns profile + role + permissions + all company
memberships (see §3 below). The SPA's route guard/session context should be
built on this call, matching the current Leptos app's pattern (`get_me()` on
boot, stored in a `Me` context/store).

### Session extractor gotchas relevant to a client rewrite
- 401 is returned for **missing session AND for a session valid but whose
  user does not belong to the current subdomain's company** — a single
  "unauthorized" bucket, so the client can't distinguish "not logged in" from
  "logged in on the wrong tenant" purely from the status code. (Current SPA's
  `ApiError::Unauthorized` treats both the same — routes to login.)
- `403 Forbidden` is a distinct case used for authenticated-but-not-permitted
  (e.g. `/api/tiempo` returns 403 if the user lacks `ViewTimeline` permission
  and isn't admin). The SPA's `ApiError` enum splits `Unauthorized` (401) vs
  `Forbidden` (403) — the Solid client should preserve that distinction for UX
  ("session expired, log in again" vs "you don't have permission").

---

## 3. Full API contract

Conventions below: all paths are absolute, same-origin. All bodies are JSON
(`Content-Type: application/json`) unless noted (multipart for SAT cert
upload). Success statuses used by the JSON helpers: `200/201/202/204`.
Error body shape on non-2xx (when the server sends one):
`{"error": "human message"}`. `401`/`403` bodies are typically empty text,
not JSON — the SPA's `err_with_body` special-cases those two codes to fixed
enum variants before trying to parse a body.

Every "detail"/`{id}` GET returns the same shape as the corresponding
`*Payload` used for create/update (i.e. detail response ≈ update request
body), so edit forms can pre-fill directly from the fetch — keep that
symmetry in the Solid client's types.

### 3.1 Auth / bootstrap (3 endpoints)

| Method | Path | Request | Response | Handler |
|---|---|---|---|---|
| POST | `/login` | `{username, code}` (alias `email`→`username`) | `{ok, redirect_url?}` | `routes::login::login` |
| POST | `/logout` | — | `{ok:true}` | `routes::logout::logout` |
| GET | `/api/me` | — | `MeResponse` (see below) | `routes::profile::me` |
| GET | `/api/me/companies` | — | `CompanySummary[]` | `routes::profile::me_companies` |

`MeResponse`:
```ts
{
  username: string; company: string; company_slug: string;
  role: "admin" | "staff"; permissions: string[]; // e.g. "view_projects", "view_project_money", "edit_resource_usage_today", "view_resource_usage_history", "view_timeline"
  companies: { id: string; name: string; slug: string; active: boolean }[];
}
```
(4 endpoints counted here; login/logout also listed since they're the
auth surface, bringing this group to 4.)

### 3.2 Own account profile (2 endpoints)

| Method | Path | Request | Response | Handler |
|---|---|---|---|---|
| GET | `/api/account` | — | `AccountData {id, username}` | `admin::account::account_profile_data_api` |
| POST | `/api/account` | `AccountPayload {username, secret}` (blank `secret` = keep existing) | 200 | `admin::account::account_profile_update_api` |

### 3.3 Companies (admin) (7 endpoints)

Row: `CompanyData {id, name, slug, default_currency, is_active, notes?, is_current}`.
Payload: `CompanyPayload {name, slug?, default_currency?, is_active?, notes?}`
(empty/omitted slug is auto-derived from `name` server-side).

| Method | Path | Request | Response | Handler |
|---|---|---|---|---|
| GET | `/api/admin/companies` | — | `CompanyData[]` | `companies_data_api` |
| POST | `/api/admin/companies` | `CompanyPayload` | 200/201 | `company_create_api` |
| GET | `/api/admin/companies/{id}` | — | `CompanyData` | `company_data_api` |
| POST | `/api/admin/companies/{id}/update` | `CompanyPayload` | 200 | `company_update_api` |
| POST | `/api/admin/companies/{id}/delete` | — | 200 | `company_delete_api` |
| POST | `/api/admin/companies/{id}/cfdis/delete_all` | — | 200 | `company_cfdis_delete_all_api` |
| POST | `/api/admin/companies/{id}/transactions/delete_all` | — | 200 | `company_transactions_delete_all_api` |

Current tenant is flagged `is_current: true` and presumably can't be deleted
(enforce/verify server-side; not confirmed by reading this pass).

### 3.4 CFDI download jobs (per company) (3 endpoints, JSON) + 1 legacy non-SPA endpoint

| Method | Path | Request | Response | Handler |
|---|---|---|---|---|
| POST | `/api/admin/companies/{id}/cfdi/download` | `CfdiDownloadPayload {sat_config_id, start, end, download_type: "issued"\|"received"\|"both", auto_create_payments}` | `StartedJobs` (job ids kicked off) | `company_cfdi_download_api` |
| GET | `/api/admin/companies/{id}/cfdi/jobs` | — | `CfdiJob[]` (each has nested `CfdiJobStatus`) | `company_cfdi_job_status` list / `company_cfdi_jobs_list` |
| GET | `/api/admin/companies/{id}/cfdi/jobs/{job_id}` | — | `CfdiJobStatus` | `company_cfdi_job_status` |

`CfdiJobStatus`: `{status: "queued"|"running"|"done"|"failed", imported, transactions_created, transactions_updated, transactions_skipped, errors: string[], error?}`.
This is a **polling job pattern** — the SPA starts a download, then polls
`/jobs` or `/jobs/{id}` for progress. A Solid rewrite needs the same
poll loop (no websocket/SSE observed).

There is also a separate, older, non-tenant-scoped endpoint
`POST /api/sat/cfdi/download` (`routes::sat::sat_cfdi_download`, admin-only)
that talks directly to the SAT web service given raw cert paths and does its
own ZIP import — **not called by the current SPA** (only the
`/api/admin/companies/{id}/cfdi/download` job-based flow is used from
`frontend/src/pages/cfdi.rs`). Treat it as legacy/unused for the rewrite
unless product wants to resurface it.

### 3.5 CFDIs (read-only, listing) (2 endpoints)

| Method | Path | Request | Response | Handler |
|---|---|---|---|---|
| GET | `/api/admin/cfdis/data` | — | `CfdiList {company_rfcs, items: Cfdi[]}` | `cfdis_data_api` |
| GET | `/api/admin/cfdis/{uuid}` | — | `CfdiDetailResponse` (adds `CfdiConceptData[]` line items) | `cfdi_data_api` |

`Cfdi`: `{uuid, folio, tipo, fecha, total, moneda, emisor_nombre, receptor_nombre, es_emitido}`.

### 3.6 SAT fiscal configs (6 endpoints, 1 multipart)

Row: `SatConfigData {id, company_id, rfc, label?, created_at}` — cert bytes
and passwords are never returned.

| Method | Path | Request | Response | Handler |
|---|---|---|---|---|
| GET | `/api/admin/sat-configs` | — | `SatConfigData[]` | `sat_configs_data_api` |
| POST | `/api/admin/sat-configs` | `SatConfigPayload {rfc, cer_path, key_path, key_password, label?}` (JSON, reuses existing uploaded cert paths) | 200/201 | `sat_config_create_api` |
| POST | `/api/admin/sat-configs/upload` | **multipart/form-data**: parts `rfc`, `label`, `key_password`, `cer_file` (blob), `key_file` (blob) | 200/201 | `sat_config_upload_api` |
| GET | `/api/admin/sat-configs/{id}` | — | `SatConfigData` | `sat_config_data_api` |
| POST | `/api/admin/sat-configs/{id}/update` | `SatConfigPayload` (updates keep existing cert files; only metadata/paths/password editable) | 200 | `sat_config_update_api` |
| POST | `/api/admin/sat-configs/{id}/delete` | — | 200 | `sat_config_delete_api` |

**This is the one non-JSON-body write in the whole app.** The browser sets
the multipart boundary automatically when the fetch body is a `FormData`
containing `File`/`Blob` parts — same approach works unchanged from
SolidJS (`fetch(url, {method: "POST", body: formData})`).

### 3.7 Users (admin) (5 endpoints)

Row: `UserRowData {id, username, role, companies: string[], memberships: UserMembershipData[], secret}`
(`secret` — the TOTP secret — is only populated on the single-user detail
endpoint, empty string in the list; needed there for showing next to the
QR code when e.g. re-enrolling a device).
`UserMembershipData {company_id, company_name, role, permissions: string[]}`.
Payload: `UserPayload {username, secret?, memberships: UserMembershipPayload[]}`
where `UserMembershipPayload {company_id, role?, permissions: string[]}`.
Omitted `secret` = server generates one on create, keeps existing on update.

| Method | Path | Request | Response | Handler |
|---|---|---|---|---|
| GET | `/api/admin/users` | — | `UserRowData[]` | `api_users_index` |
| POST | `/api/admin/users` | `UserPayload` | 200/201 | `api_users_create` |
| GET | `/api/admin/users/{id}` | — | `UserRowData` (with `secret`) | `api_user_detail` |
| POST | `/api/admin/users/{id}/update` | `UserPayload` | 200 | `api_users_update` |
| POST | `/api/admin/users/{id}/delete` | — | 200 | `api_users_delete` |

### 3.8 Accounts (finance) (5 endpoints)

Row: `Account {id, name, company, account_type, currency, is_active}`.
`account_type`: `bank | cash | credit_card | investment | other`.
Payload: `AccountPayload {name, account_type, currency?, is_active, notes?}`.
Detail: `AccountDetail {name, account_type, currency, is_active, notes?}`.

| Method | Path | Request | Response | Handler |
|---|---|---|---|---|
| GET | `/api/admin/accounts` | — | `Account[]` | `accounts_data_api` |
| POST | `/api/admin/accounts` | `AccountPayload` | 200/201 | `accounts_create_api` |
| GET | `/api/admin/accounts/{id}` | — | `AccountDetail` | `account_data_api` |
| POST | `/api/admin/accounts/{id}/update` | `AccountPayload` | 200 | `account_update_api` |
| POST | `/api/admin/accounts/{id}/delete` | — | 200 | `account_delete_api` |

### 3.9 Categories (5 endpoints)

Row: `Category {id, name, flow_type, parent?}`. `flow_type`: `income | expense`.
Payload/Detail: `{name, flow_type, parent_id?, notes?}`.

| Method | Path | Handler |
|---|---|---|
| GET | `/api/admin/categories` | `categories_data_api` |
| POST | `/api/admin/categories` | `categories_create_api` |
| GET | `/api/admin/categories/{id}` | `category_data_api` |
| POST | `/api/admin/categories/{id}/update` | `category_update_api` |
| POST | `/api/admin/categories/{id}/delete` | `category_delete_api` |

### 3.10 Contacts (5 endpoints)

Row: `Contact {id, name, kind, email?}` — **note:** the list row field is
`kind` but the write payload field is `contact_type`
(`ContactPayload/ContactDetail {name, contact_type, rfc?, email?, phone?, notes?}`).
`contact_type` enum: `customer | supplier | service | other`. This
read/write field-name mismatch is a real inconsistency in the existing
contract — the Solid client should paper over it in one place (a mapping
function), same as the current Leptos client implicitly does by using two
different structs.

| Method | Path | Handler |
|---|---|---|
| GET | `/api/admin/contacts` | `contacts_data_api` |
| POST | `/api/admin/contacts` | `contacts_create_api` |
| GET | `/api/admin/contacts/{id}` | `contact_data_api` |
| POST | `/api/admin/contacts/{id}/update` | `contact_update_api` |
| POST | `/api/admin/contacts/{id}/delete` | `contact_delete_api` |

### 3.11 Recurring plans (6 endpoints)

Row: `RecurringPlan {id, name, flow_type, amount_estimated, frequency, start_date, is_active}`.
Payload/Detail: adds `category_id, account_expected_id, contact_id?, day_of_month?, end_date?, version, notes?`.
`version: i32` — incrementing it (server-side, via the `/generate` action or
an update) marks existing generated `PlannedEntry` rows as outdated; the
Solid client just needs to send the current `version` back on update, not
compute it.

| Method | Path | Handler |
|---|---|---|
| GET | `/api/admin/recurring-plans` | `recurring_plans_data_api` |
| POST | `/api/admin/recurring-plans` | `recurring_plans_create_api` |
| GET | `/api/admin/recurring-plans/{id}` | `recurring_plan_data_api` |
| POST | `/api/admin/recurring-plans/{id}/update` | `recurring_plan_update_api` |
| POST | `/api/admin/recurring-plans/{id}/delete` | `recurring_plan_delete_api` |
| POST | `/api/admin/recurring-plans/{id}/generate` | `recurring_plan_generate_api` (no body — generates `PlannedEntry` rows from the plan) |

### 3.12 Planned entries (7 endpoints)

Row: `PlannedEntry {id, name, flow_type, amount_estimated, due_date, status, status_label}`.
`status`: `planned | partially_covered | covered | overdue | cancelled`.
Payload/Detail: adds `category_id, account_expected_id, contact_id?, project_id?, notes?`.

| Method | Path | Request | Handler |
|---|---|---|---|
| GET | `/api/admin/planned-entries` | — | `planned_entries_data_api` |
| POST | `/api/admin/planned-entries` | `PlannedEntryPayload` | `planned_entries_create_api` |
| GET | `/api/admin/planned-entries/{id}` | — | `planned_entry_data_api` |
| POST | `/api/admin/planned-entries/{id}/update` | `PlannedEntryPayload` | `planned_entry_update_api` |
| POST | `/api/admin/planned-entries/{id}/delete` | — | `planned_entry_delete_api` |
| POST | `/api/admin/planned-entries/{id}/pay` | `PlannedEntryPayPayload {paid_at, amount, account_id, project_id?, notes?}` | `planned_entry_pay_api` |
| POST | `/api/admin/planned-entries/bulk-pay` | `PlannedEntryBulkPayPayload {entry_ids: string[], paid_at, account_id, project_id?, notes?}` | `planned_entries_bulk_pay_api` |

### 3.13 Transactions (5 endpoints)

Row: `Transaction {id, date, description, tx_type, amount, category?, account_from?, account_to?, is_confirmed}`.
`tx_type`: `income | expense | transfer`.
Payload/Detail: `{date, description, transaction_type, category_id, account_from_id?, account_to_id?, amount, planned_entry_id?, is_confirmed, notes?}`.
Note the list endpoint is `/data` while create has no suffix (unlike most
other domains where the list endpoint has no suffix) — the transactions
domain's collection GET is specifically `/api/admin/transactions/data`, not
`/api/admin/transactions` (that path only accepts POST for create).

| Method | Path | Handler |
|---|---|---|
| GET | `/api/admin/transactions/data` | `transactions_data_api` |
| POST | `/api/admin/transactions` | `transactions_create_api` |
| GET | `/api/admin/transactions/{id}` | `transaction_data_api` |
| POST | `/api/admin/transactions/{id}/update` | `transaction_update_api` |
| POST | `/api/admin/transactions/{id}/delete` | `transaction_delete_api` |

### 3.14 Forecasts (5 endpoints)

Row: `Forecast {id, currency, projected_net, start_date, end_date, scenario_name?}`.
Payload: `{generated_at, start_date, end_date, currency, projected_income_total, projected_expense_total, projected_net, initial_balance?, final_balance?, details?, scenario_name?, notes?}`.
Detail: same minus `projected_net` (recomputed?), plus the rest.

| Method | Path | Handler |
|---|---|---|
| GET | `/api/admin/forecasts` | `forecasts_data_api` |
| POST | `/api/admin/forecasts` | `forecasts_create_api` |
| GET | `/api/admin/forecasts/{id}` | `forecast_data_api` |
| POST | `/api/admin/forecasts/{id}/update` | `forecast_update_api` |
| POST | `/api/admin/forecasts/{id}/delete` | `forecast_delete_api` |

### 3.15 Service orders (5 endpoints)

Row: `Order {id, title, status, status_label, amount, scheduled_at?, contact_id?}`.
`status`: `pending | confirmed | in_progress | completed | cancelled`.
Payload/Detail: `{title, contact_id?, category_id?, account_id?, status, amount, scheduled_at?, items: OrderItem[], notes?}`,
`OrderItem {description, quantity, unit_price}`.

| Method | Path | Handler |
|---|---|---|
| GET | `/api/admin/orders` | `orders_data_api` |
| POST | `/api/admin/orders` | `orders_create_api` |
| GET | `/api/admin/orders/{id}` | `order_data_api` |
| POST | `/api/admin/orders/{id}/update` | `order_update_api` |
| POST | `/api/admin/orders/{id}/delete` | `order_delete_api` |
| POST | `/api/admin/orders/{id}/complete` | `order_complete_api` (no body) |

(6 endpoints — includes `/complete`.)

### 3.16 Projects (6 endpoints)

Row: `ProjectRow {id, title, description?, status, status_label, priority, priority_label, total_budget?, scheduled_at?, contact_id?}`.
`status`: `pedidos | analisis | cotizado | orden_de_compra_mandada | ingenieria | produccion | calidad | esperando_entrega | entregado | cancelado`.
`priority`: `low | medium | high | urgent`.
Payload/Detail: `{title, contact_id?, category_id?, description?, priority, total_budget?, scheduled_at?, notes?}`.
Minimal option-picker shape: `Project {id, title}` (from the same list
endpoint, frontend just narrows the type it deserializes into).

| Method | Path | Handler |
|---|---|---|
| GET | `/api/admin/projects` | `projects_data_api` |
| POST | `/api/admin/projects` | `projects_create_api` |
| GET | `/api/admin/projects/{id}` | `project_data_api` |
| POST | `/api/admin/projects/{id}/update` | `project_update_api` |
| POST | `/api/admin/projects/{id}/delete` | `project_delete_api` |
| POST | `/api/admin/projects/{id}/advance` | `project_advance_api` (advances project status; no body observed) |

### 3.17 Project concepts + status summary (5 endpoints)

Row: `ProjectConcept {id, status_id, name, quantity, unit?, description?, estimated_hours?, estimated_cost?, position}`.
Payload: `{status_id?, name, quantity, unit?, description?, estimated_hours?, estimated_cost?, notes?, position}`.

| Method | Path | Handler |
|---|---|---|
| GET | `/api/admin/projects/{project_id}/concepts` | `api_project_concepts_index` |
| POST | `/api/admin/projects/{project_id}/concepts` | `api_project_concepts_create` |
| GET | `/api/admin/projects/{project_id}/status_summary` | `api_project_status_summary` |
| POST | `/api/admin/project_concepts/{id}/update` | `api_project_concepts_update` |
| POST | `/api/admin/project_concepts/{id}/advance` | `api_project_concepts_advance` (no body — moves to next status) |
| POST | `/api/admin/project_concepts/{id}/delete` | `api_project_concepts_delete` |

(6 endpoints — includes advance.)

### 3.18 Concept statuses (kanban-style pipeline stages) (4 endpoints)

`ConceptStatus {id, name}` (minimal, for pickers) vs
`ConceptStatusFull {id, name, position, color?, is_initial, is_terminal, is_cancelled, is_active}`.
Payload: `{name, position, color?, is_initial, is_terminal, is_cancelled, is_active}`.

| Method | Path | Handler |
|---|---|---|
| GET | `/api/admin/concept_statuses` | `api_concept_statuses_index` |
| POST | `/api/admin/concept_statuses` | `api_concept_statuses_create` |
| POST | `/api/admin/concept_statuses/{id}/update` | `api_concept_statuses_update` |
| POST | `/api/admin/concept_statuses/{id}/delete` | `api_concept_statuses_delete` |

### 3.19 Resources (5 endpoints)

Row: `Resource {id, name, resource_type, resource_type_label, is_active, hourly_cost, currency, allowed_status_ids: string[]}`.
`resource_type`: `machinery | vehicle | equipment | other`.
Payload/Detail: `{name, resource_type, is_active, hourly_cost, currency?, allowed_status_ids, notes?}`.

| Method | Path | Handler |
|---|---|---|
| GET | `/api/admin/resources` | `resources_data_api` |
| POST | `/api/admin/resources` | `resources_create_api` |
| GET | `/api/admin/resources/{id}` | `resource_data_api` |
| POST | `/api/admin/resources/{id}/update` | `resource_update_api` |
| POST | `/api/admin/resources/{id}/delete` | `resource_delete_api` |

### 3.20 Resource logs (6 endpoints)

Row: `ResourceLog {id, project_id?, phase?, resource_name?, started_at, ended_at?, duration_hours?, operator_name?}`.
Payload/Detail: `{project_id?, phase?, resource_id?, started_at, ended_at?, operator_name?, notes?}`.
End payload: `{ended_at?}` (defaults to "now" server-side if omitted, per naming).

| Method | Path | Handler |
|---|---|---|
| GET | `/api/admin/resource_logs` | `resource_logs_data_api` |
| POST | `/api/admin/resource_logs` | `resource_logs_create_api` |
| GET | `/api/admin/resource_logs/{id}` | `resource_log_data_api` |
| POST | `/api/admin/resource_logs/{id}/update` | `resource_log_update_api` |
| POST | `/api/admin/resource_logs/{id}/delete` | `resource_log_delete_api` |
| POST | `/api/admin/resource_logs/{id}/end` | `resource_log_end_api` (`ResourceLogEndPayload {ended_at?}`) |

### 3.21 Resource usages — hourly grid (5 endpoints)

This is the most structurally unusual domain: a matrix editor (project
concepts × hour-of-day × resource checkboxes) persisted as one call.

`GridView {date, can_edit, statuses: GridStatus[], rows: GridRow[]}`,
`GridRow {concept_id, project_id?, project_title?, status_name?, concept_name, quantity, unit?, cells: GridCell[]}`,
`GridCell {hour, is_work_hour, resources: GridResource[]}`,
`GridResource {resource_id, label, selected}`.

Read: `GET /api/admin/resource_usages/grid?date=YYYY-MM-DD&status_id=<id|all>`
→ `GridView`.

Write: `POST /api/admin/resource_usages/grid` with
`GridSavePayload {date, status_id?, selections: GridSelection[]}`,
`GridSelection {concept_id, hour, resource_id}` — the client scrapes every
currently-checked `<input>` in its rendered grid into a flat list of
`(concept_id, hour, resource_id)` triples and POSTs the **entire selection
set** for that date/status filter combo in one shot (not incremental
per-checkbox toggles). A Solid rewrite should replicate "collect full
selection state, save whole grid" rather than trying to diff.

| Method | Path | Handler |
|---|---|---|
| GET | `/api/admin/resource_usages` | `api_resource_usages_index` (flat list, distinct from the grid view) |
| POST | `/api/admin/resource_usages` | `api_resource_usages_create` |
| GET | `/api/admin/resource_usages/grid?date=&status_id=` | `api_resource_usages_grid_view` |
| POST | `/api/admin/resource_usages/grid` | `api_resource_usages_grid_save` |
| GET | `/api/admin/resource_usages/{id}` | `api_resource_usage_detail` |
| POST | `/api/admin/resource_usages/{id}/update` | `api_resource_usages_update` |
| POST | `/api/admin/resource_usages/{id}/delete` | `api_resource_usages_delete` |
| GET/POST | `/api/admin/resource_usages/{id}/allocations` | `api_resource_usage_allocations_index` / `_replace` |

(8 endpoints total in this domain — the SPA currently only exercises the
`/grid` GET+POST pair from `frontend/src/pages/resource_usages.rs`; the flat
list/detail/allocations endpoints exist server-side but weren't observed
being called from any page component in this pass — verify against the
OpenAPI doc at `/docs` if the Solid rewrite needs them.)

### 3.22 Tiempo (timeline) — read-only aggregation (1 endpoint)

`GET /api/tiempo?mode=day|week|month|year&from=<RFC3339>&to=<RFC3339>`
→ `TimelineBucket[]`:
```ts
{
  start: string; end: string; // RFC3339
  real_income: number; real_expense: number;
  planned_income: number; planned_expense: number;
  net_real: number; net_planned: number;
  cumulative_real: number; cumulative_planned: number; // running totals seeded from all data before `from`
  transactions: { id, description, amount, date, type: "income"|"expense"|"transfer" }[];
  planned_entries: { id, name, amount_estimated, due_date, flow_type, status }[];
}
```
Requires `ViewTimeline` permission (or admin) — 403 otherwise. `from`/`to`
must be strict RFC3339 (`ChronoDateTime::parse_from_rfc3339`), `to` is
clamped server-side to 5 years in the future. Buckets are always fully
populated across the requested range (zero-filled), not sparse.

This endpoint backs the "infinite horizontal scroll" timeline widget
(`frontend/src/pages/tiempo.rs`), currently implemented as ~300 lines of
hand-written vanilla JS injected via `inner_html` + a `<script>` run — see
§4 "surprising" notes. The data contract above is what the Solid
reimplementation needs to match; the UI/interaction itself is free to be
rebuilt idiomatically in Solid rather than ported verbatim.

### 3.23 PDF preview (Typst) (1 endpoint, non-CRUD)

`POST /pdf/preview` — body `{source: string}` (raw Typst source, capped at
256 KiB). Shells out to a `typst compile` binary (path from `TYPST_BIN` env,
default `typst`) with a 10s timeout, in a scratch temp dir per request.

Response: `{ok: boolean, pdf_base64: string | null, error: string | null}`
— **the PDF bytes come back base64-encoded inside a JSON envelope**, not as
a binary `application/pdf` response. The Solid client needs to
base64-decode and construct a `Blob`/object URL itself to preview/download
it (e.g. `data:application/pdf;base64,...` or `URL.createObjectURL(new Blob([bytes], {type: "application/pdf"}))`).

### 3.24 QR code (TOTP enrollment) (1 endpoint, non-JSON)

`GET /qrcode` (also `/admin/users/{id}/qrcode` for admin-issued QR of another
user, same handler family) — returns a **raw binary PNG** image
(`Content-Type: image/png`), not JSON. Renders a QR of the user's `otpauth://`
URL built from `(company_name, username, secret)`. In a Solid app this is
just an `<img src="/qrcode">` — no fetch/JSON handling needed, but note it's
NOT wrapped like the PDF endpoint (inconsistent binary-response strategy
between these two: PDF is base64-in-JSON, QR is a raw image response).

### 3.25 Non-API server-rendered routes (Askama HTML — not part of the JSON contract, but exist and are session-protected)

The `protected` router also serves a full parallel set of **server-rendered
HTML** admin pages (`/admin/accounts`, `/admin/accounts/new`,
`/admin/accounts/{id}/edit`, ...`/update`, `/delete` as HTML form posts) for
essentially every domain above, plus `/account`, `/pdf`, `/tiempo`,
`/admin/users/*`, `/admin/companies/*`, etc. These are the **pre-SPA UI**
(Askama templates in `src/templates/`), still wired in `main.rs` and
presumably still reachable, coexisting with the JSON API + SPA. They are
**not** what the SPA (or the Solid rewrite) should call — ignore them for
the migration, but be aware they exist on the same routes namespace-adjacent
to the JSON API (e.g. `/admin/accounts` HTML page vs `/api/admin/accounts`
JSON endpoint are different routes).

---

## 4. Things that will complicate (or at least surprise) a Solid rewrite

1. **Multipart upload is real, not just theoretical**: SAT config cert
   upload (`POST /api/admin/sat-configs/upload`) needs `FormData` with two
   file blobs (`cer_file`, `key_file`) plus three string fields. Standard
   `fetch` + `FormData` handles this fine in Solid; just don't
   `JSON.stringify` it or set a `Content-Type` header manually (let the
   browser set the multipart boundary).

2. **Two different non-JSON response encodings for binary data**: PDF
   preview returns base64 text inside a JSON envelope; QR code returns a raw
   `image/png` body. Two different client-side handling paths needed.

3. **Async job polling for CFDI downloads**: no websockets/SSE — the client
   starts a download job then polls `GET .../cfdi/jobs` or
   `.../cfdi/jobs/{job_id}` on an interval until `status` is `done`/`failed`.
   Needs a poll loop with cleanup on unmount in Solid.

4. **Multi-`Set-Cookie` login/logout with same cookie name, different
   `Domain` scopes**: entirely server-side behavior, but worth knowing when
   debugging cross-subdomain session issues in dev — the browser will hold
   several `session` cookies simultaneously with different domain scope, and
   the server tries all of them per request. Nothing the Solid client needs
   to implement, just don't be surprised by devtools showing multiple
   `session` cookies.

5. **Cross-subdomain redirect after login is a full page navigation, not an
   XHR-followed redirect**: `POST /login` itself doesn't 3xx-redirect; it
   returns `redirect_url` in the JSON body and the *client* must
   `window.location.href = redirect_url` to actually move to the tenant
   subdomain (this is required because that subdomain is a different origin
   the login response's `Set-Cookie`s already anticipated via the
   root-domain/slug-domain cookie variants described in §2).

6. **Read/write field-name mismatches per domain** — worth grepping for
   before assuming symmetry:
   - Contacts: list row uses `kind`, write payload uses `contact_type`.
   - Transactions collection GET lives at `/data` suffix
     (`/api/admin/transactions/data`) while every other domain's collection
     GET has no suffix.
   - Forecasts: list row has `projected_net` but the payload has
     `projected_income_total` + `projected_expense_total` (net is likely
     derived, not requested from the client as-is on write in all cases —
     double check `ForecastPayload` requires `projected_net` explicitly too;
     it's present in `ForecastPayload` but absent from `ForecastDetail`).

7. **The timeline (`/tiempo`) UI is currently ~300 lines of imperative
   vanilla JS driving the DOM directly** (`frontend/src/pages/tiempo.rs`,
   `TIEMPO_JS` const) — recycled DOM cell pool, infinite scroll via
   scroll-position math, hand-rolled SVG chart. This is the single largest
   "needs a real rewrite, not a port" surface; the API contract (`GET
   /api/tiempo`) is simple and stable, but the interaction model should
   probably be redesigned idiomatically in Solid (signals/stores + a
   virtualized list) rather than transliterated.

8. **The resource-usage hourly grid** is a save-the-whole-grid pattern (see
   §3.21) — the client must track the complete current checkbox state and
   submit it wholesale, not send incremental deltas. Also note the grid GET
   is filtered by `status_id` (or `all`) and `date`, and returns `can_edit`
   — some dates/roles may be read-only, gate the UI on that flag.

9. **Permission model is coarse and client-trust-but-verify**: `Me.can(...)`
   client-side checks are UX-only (`// UX-only permission check; the server
   remains the authorization boundary` — comment in `frontend/src/api/mod.rs`).
   Permissions are a flat string array (`view_projects`,
   `view_project_money`, `edit_resource_usage_today`,
   `view_resource_usage_history`, `view_timeline`) plus a coarse `role`
   (`admin`/`staff`) where admin implicitly has all permissions
   (`is_admin() || permissions.contains(...)` pattern server-side, per
   `session.rs`'s `has_permission`). The Solid app should mirror this: gate
   UI affordances on `role`/`permissions` from `/api/me`, but always expect
   the server to also enforce it (401/403).

10. **`ApiError` taxonomy worth preserving**: the current client distinguishes
    `Unauthorized` (401 → force re-login), `Forbidden` (403 → "no permission"
    message), `Status{code, message}` (other 4xx/5xx, message from the
    server's `{"error": "..."}` body when present), and `Transport` (network/
    parse failure). Non-2xx bodies are best-effort JSON-parsed for an
    `error` field; 401/403 bodies are treated as fixed enum variants without
    attempting to parse a body at all (they're typically plain text, not
    JSON). A Solid `ApiError`-equivalent should keep this 4-way split — the
    UI copy in the current app (`humanize()` in `frontend/src/api/mod.rs`) is
    keyed off exactly these buckets.

11. **Endpoints that exist server-side but aren't (confirmed) called by the
    current SPA**: `POST /api/sat/cfdi/download` (legacy direct-cert SAT
    download, superseded by the per-company job flow), and several
    `resource_usages` endpoints beyond the grid pair (`GET
    /api/admin/resource_usages` flat list, `{id}` detail/update/delete,
    `{id}/allocations`). Confirm against `/docs` (Swagger UI, test-tenant
    only) before deciding whether the Solid rewrite needs to cover them —
    they may be dead code or may back a not-yet-built UI.

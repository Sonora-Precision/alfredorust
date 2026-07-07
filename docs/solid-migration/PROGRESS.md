# PROGRESS — Migración a SolidJS (`/v3`)

> **Fuente única de verdad del avance.** Se actualiza cada vez que se termina una tarea.
> Al empezar una sesión nueva: leer PRIMERO el bloque «RESUME HERE», luego este checklist.
> Plan completo: `PLAN.md`. Inventario: `backend-and-api.md`, `pages-part1.md`, `pages-part2.md`, `design-system.md`, `animation-strategy.md`.

Leyenda estado: `[ ]` pendiente · `[~]` en curso · `[x]` hecho · `[!]` bloqueado/atención

---

## 🔖 RESUME HERE  (leer esto primero al reabrir sesión)

- **Fecha última actualización:** 2026-07-07
- **Fase actual:** **Fase B COMPLETA** ✅ (19 páginas, build 0 errores) + **Fase D1/D2 hechas** (`/v3` wired en `src/main.rs`, `cargo check` limpio; CI construye+envía `solid/dist`, Node 22 — NO pusheado aún). Falta: feedback de look del usuario, **Fase C (animaciones)**, y **D3 (verificar paridad, requiere backend+.env) / D4 (cutover)**. Push a `main` = deploy a prod → pedir OK antes.
- **GATE A:** presentado con screenshots reales light/dark de Dashboard+Accounts (se ven muy bien). **Aprobación DIFERIDA** — el usuario estaba fuera; pidió NO frenar; revisará después y pedirá cambios. **NO borrar `solid/src/preview/` ni la ruta `/preview/design`** hasta que apruebe. El preview acepta `?theme=light|dark&tab=dashboard|accounts` para capturas headless.
- **Puntos de diseño pendientes de feedback del usuario:** (1) el sidebar se mantiene oscuro en tema claro (patrón intencional) — confirmar si lo quiere claro; (2) el toggle de tema muestra luna en ambos temas (posible sol/luna).
- **Cosas a verificar contra backend real (reportadas por agentes B):** ¿renombrar `username` en Account invalida sesión? (B4 hace `auth.refresh()` tras guardar); reserved-slugs de Companies ahora dependen del mensaje de error del server; bulk-pay de Tiempo usa el endpoint JSON `POST /api/admin/planned-entries/bulk-pay` (account_id+paid_at recogidos en modal in-SPA).
- **Siguiente acción concreta:** esperar feedback de look del usuario. Luego: **Fase C** (animaciones solid-transition-group + solid-motionone, ver `animation-strategy.md` y CLAUDE.md §render) y **Fase D** (nest_service `/v3` en `src/main.rs` + CI + verificación de paridad `/v2` vs `/v3` + cutover). Para verificar `/v3` de verdad se necesita backend corriendo + login TOTP contra un tenant real.
- **Dashboard.tsx / Accounts.tsx:** puerto fiel de `dashboard.rs`/`accounts.rs` (ver pages-part1.md) + pulido. Dashboard conserva el switcher de "Compañías" real (único dato que trae `dashboard.rs`) y añade KPIs (Ingresos/Egresos/Neto/Cuentas activas) + gráficos `LineArea`/`Donut` calculados client-side desde `listTransactions()` + `listAccounts()` — mismo patrón que `tx_charts` de `transactions.rs`, aplicado a la landing ya que `dashboard.rs` en sí no trae datos financieros propios. Accounts es CRUD completo real (Modal crear/editar + Modal confirmar borrar, `createQuery`/`createMutation` de solid-query, toasts, badges, gate admin-only) sobre `lib/api/finance.ts` sin añadir funciones nuevas al api layer.
- **Preview de diseño (`solid/src/preview/`, deletable):** `DesignPreview.tsx` en la ruta pública `/preview/design` (fuera de `RequireAuth`). En vez de props "mock" sueltos, instala un interceptor de `window.fetch` (`mockFetch.ts`) que responde `/api/me`, `/api/admin/accounts[/:id[/update|delete]]` y `/api/admin/transactions/data` con datos de `sampleData.ts`, y luego llama al `auth.refresh()` real del `AuthContext` ya existente — así Dashboard/Accounts corren con el código real sin ninguna rama especial, CRUD de Accounts incluido (store en memoria). `onCleanup` desinstala el mock y refresca auth si el usuario navega fuera sin recargar. `npm run build` (tsc+vite) pasa con 0 errores; `npm run dev` sirve `/v3/preview/design` correctamente (verificado con un server local en :5173).
- **A1–A15 completos:** scaffold Vite+Solid+TS+Tailwind+Kobalte+solid-query+router, `lib/api/{client,types,auth,finance,fiscal,admin,operations,misc}.ts`, `lib/{theme,format,cn,tenant}.ts`, `lib/auth/{AuthContext,RequireAuth}.tsx`, `components/ui/*` (Badge/Button/Card/Input/Select/Checkbox + Kobalte Modal/Dropdown/Toast/Tabs/Accordion/Table/Spinner), `components/layout/*` (AppShell/Sidebar/NavGroup/Topbar/CompanySwitcher/ThemeToggle), `components/charts/{LineArea,Donut}`, `App.tsx` + `main.tsx`, página `Login` real, 20 páginas placeholder. `npm run build` pasa limpio (tsc + vite build, 0 errores).
- **`solid/` en construcción.** El frontend Leptos sigue en `frontend/` (servido en `/v2`), intacto.
- **Cómo se sirve hoy:** `frontend/` (Leptos) en `/v2`. El nuevo Solid irá en `solid/` servido en `/v3` (backend intacto hasta cutover).
- **Contratos congelados (se definen en Fase A, luego solo-lectura para Fase B):** `solid/src/lib/api/client.ts`, `lib/api/types.ts`, `components/ui/*`, `components/layout/*`, `App.tsx` (rutas con lazy imports). Los agentes de página NO editan estos; solo rellenan su archivo en `src/pages/`.
- **Principio:** paridad primero, mejora/animaciones después. No replicar bugs (ver PLAN §13).

**Cómo correr (cuando exista `solid/`):**
```bash
cd solid && npm install && npm run dev     # Vite dev en proxy a Axum :8090
# backend en otra terminal: cargo run   (o bacon)
# probar contra un tenant real: slug.localhost:8090
```

---

## FASE A — Scaffold + Sistema de diseño + 2 pantallas de referencia  (SERIAL) — *gate de aprobación de look*

- [x] A1 · Init proyecto `solid/` (Vite + Solid + TS). Deps: solid-js, @solidjs/router, @tanstack/solid-query, @kobalte/core, solid-transition-group, solid-motionone, lucide-solid, tailwindcss v3. (+clsx, tailwind-merge para `cn()`.)
- [x] A2 · `vite.config.ts`: `base:'/v3/'`, proxy dev de `/api`,`/login`,`/logout` → `http://127.0.0.1:8090` (changeOrigin).
- [x] A3 · `tailwind.config.ts` + `src/index.css`: portar tokens HSL night/light (de `design-system.md`), exponer con `hsl(var(--x)/<alpha>)`.
- [x] A4 · `lib/api/client.ts`: `apiGet/apiPost/apiPostForm/apiGetBlob`, `credentials:'include'`, manejo 401→login / 403→ApiError (contrato PLAN §5).
- [x] A5 · `lib/api/types.ts`: DTOs portados de `src/models.rs` + shapes de `backend-and-api.md`.
- [x] A6 · `lib/theme.ts`: store tema, `localStorage['alfredodev-theme']`, default dark, `data-theme="light"` en `<html>`.
- [x] A7 · `lib/format.ts`: money `$1,232,543.90`, fechas, RFC3339 (replicar manejo actual, PLAN §13).
- [x] A8 · `lib/auth/*`: AuthContext + `RequireAuth` + bootstrap `GET /api/me` + permisos (`role`+`permissions[]`, solo UX).
- [x] A9 · `components/ui/` base: Badge (mapeo completo de tonos), Button, Card(+Header/Title/Content), Input (**cablear `disabled`**), Select, Checkbox.
- [x] A10 · `components/ui/` sobre Kobalte: Modal/Dialog, Dropdown, Toast, Tabs, Accordion, Table, Spinner.
- [x] A11 · `components/layout/`: AppShell, Sidebar + NavGroup (accordion, gated por permisos), Topbar, CompanySwitcher, ThemeToggle (layout de PLAN §8).
- [x] A12 · `components/charts/`: LineArea + Donut (port de `charts.rs`).
- [x] A13 · `App.tsx`: Router `base="/v3"` + `RequireAuth` + **todas las rutas** con `lazy(()=>import('./pages/X'))` (placeholders de todas las páginas).
- [x] A14 · `lib/api/{auth,finance,fiscal,admin,operations,misc}.ts`: firmas/stubs por dominio (encapsulan quirks de nombres).
- [x] A15 · Página **Login** (POST /login, redirect_url).
- [x] A16 · Página **Dashboard** (referencia; KPIs + gráficos + switcher de compañías).
- [x] A17 · Página **Accounts** (referencia CRUD completa).
- [ ] **GATE A** · Mostrar al usuario Dashboard+Accounts en light/dark (`/v3/preview/design`, ver `solid/src/preview/`) → **aprobación de look antes de Fase B.**

---

## FASE B — Fan-out de páginas restantes  (PARALELO; archivos disjuntos; contrato congelado)

> Cada agente rellena SOLO sus archivos en `src/pages/`. No tocan api/types/components/router.

### B1 — Finanzas core (Sonnet)
- [x] categories · [x] contacts (mismatch `kind`/`contact_type`) · [x] transactions (analítica cliente: buckets, KPIs, donut/line)

### B2 — Finanzas planning (Sonnet)
- [x] recurring-plans (campo oculto `version`) · [x] planned-entries (**3 flujos**: CRUD + Pagar + bulk-pay) · [x] forecasts (`generated_at`)

### B3 — Fiscal (Sonnet)
- [x] cfdi (**job async + poll**, `onCleanup` — bug de fuga corregido) · [x] sat-configs (**upload multipart** 2 archivos)

### B4 — Admin (Sonnet)
- [x] companies (slugs reservados) · [x] users (**form compuesto** membresías/rol/permisos + QR/secreto TOTP) · [x] account (perfil)

### B5 — Operaciones A (Sonnet)
- [x] orders (**line-items dinámicos** → `createStore`) · [x] projects · [x] project-detail (conceptos anidados, roots API distintos; campo `notes` expuesto) · [x] concept-statuses

### B6 — Operaciones B (Sonnet)
- [x] resources · [x] resource-logs (`datetime-local`→RFC3339 `Z`) · [x] resource-usages (**grid 24×N**, gate `can_edit`, POST estado completo → `createStore`; long-press→Modal)

### B7 — Tiempo (Opus)
- [x] tiempo (**rebuild nativo** en Solid: timeline virtualizado + SVG; bucketing UTC 1:1 con `src/routes/tiempo.rs`; bulk-pay vía endpoint JSON en modal in-SPA)

---

## FASE C — Pasada de animaciones  (PARALELO por grupo; tras verificar paridad de B)

- [ ] Transiciones de ruta (`<Transition mode="outin">`)
- [ ] Filas de tabla enter/remove/reorder (`<TransitionGroup moveClass>`)
- [ ] Modales/drawers (`<Presence>`+`<Motion>`)
- [ ] Toasts
- [ ] Accordion sidebar
- [ ] KPIs: count-up + stagger de cards (dashboard)
- [ ] Micro-interacciones hover/press + reveal on scroll
- [ ] Guard global `prefers-reduced-motion`

---

## FASE D — Serving `/v3` + cutover  (backend)

- [x] D1 · `nest_service("/v3", ServeDir::new("solid/dist").fallback(index.html))` en `src/main.rs` (env override `SOLID_DIST`, default `solid/dist`). `cargo check` limpio. `/v2` intacto.
- [x] D2 · CI (`.github/workflows/deploy.yml`): Node 22 + `npm ci && npm run build` en `solid/` + rsync de `solid/dist` al server. **Aún NO pusheado** (push a `main` dispara deploy a prod — pedir OK antes).
- [ ] D3 · Verificación de paridad `/v2` vs `/v3` (visual + e2e adaptados de `e2e/`). Requiere backend con `.env` real (no está en el repo) + login TOTP contra un tenant.
- [ ] D4 · Cutover: apuntar path principal a Solid; retirar `/v2` cuando el usuario apruebe.

**Nota:** `.env` no está en el repo (gitignored). Para correr/verificar en local el usuario usa su `.env`. `solid/dist/index.html` referencia `/v3/assets/...` correctamente.

---

## 🗒️ Log de decisiones / cambios

- **2026-07-07** — Inventario completo (5 docs) vía 4 subagentes paralelos. Stack cerrado: Solid+Vite+TS+Tailwind+Kobalte+solid-query+solid-transition-group+solid-motionone. Servicio en `/v3`, lado a lado con `/v2`. Plan maestro en `PLAN.md`. Este PROGRESS.md creado como fuente de verdad del avance.

---

## 📌 Notas para retomar rápido

- Si una fase quedó a medias: mira qué `[~]`/`[x]` hay arriba y sigue por el primer `[ ]` de esa fase.
- Los detalles de comportamiento de CADA página están en `pages-part1.md` / `pages-part2.md` (una sección por página) — usarlos como spec al implementar.
- Quirks de API (multipart, base64 PDF, QR raw, poll CFDI, mismatches de nombres) → `backend-and-api.md §d` y PLAN §5.
- Bugs a corregir (no replicar) → PLAN §13.

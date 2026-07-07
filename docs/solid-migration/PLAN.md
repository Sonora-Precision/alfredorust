# Plan maestro — Migración del frontend a SolidJS (servicio `/v3`)

> Documento vivo y **contrato de ejecución**. Los agentes de implementación deben
> poder trabajar leyendo esto + los 4 anexos sin volver a preguntar nada.
>
> Anexos (ya escritos en esta carpeta):
> - `backend-and-api.md` — serving actual + contrato completo de ~111 endpoints JSON.
> - `pages-part1.md` — comportamiento de 11 páginas (dashboard, finanzas, fiscal, cuenta).
> - `pages-part2.md` — comportamiento de 10 páginas (admin, operaciones, tiempo).
> - `design-system.md` — tokens de tema, componentes, mapeos de Badge.
> - `animation-strategy.md` — guía de solid-transition-group + solid-motionone.

---

## 1. Objetivo y principios

Reconstruir el SPA actual (Leptos 0.8 CSR, servido en `/v2`) en **SolidJS**, servido en
paralelo bajo **`/v3`**, sin borrar ni tocar el `/v2` existente hasta el cutover final.

**Principios rectores:**
1. **Paridad primero, mejora después.** La base replica exactamente lo que hay hoy
   (mismas rutas, mismos datos, mismas acciones). Sobre esa base sólida se mejora UX,
   fluidez y animaciones. No mezclar "portar" con "rediseñar" en el mismo paso.
2. **El backend NO cambia** (salvo añadir el serving de `/v3`). El Solid app consume
   los mismos `/api/...` absolutos que el `/v2`.
3. **No replicar bugs conocidos.** Se documentan aparte (§13) y se corrigen conscientemente.
4. **Convivencia sin riesgo.** `/v2` sigue vivo; comparamos página a página; cutover al final.

---

## 2. Stack definitivo (decisiones cerradas)

| Área | Elección |
|---|---|
| Framework | **SolidJS** (CSR) + **Vite** |
| Lenguaje | **TypeScript** |
| Estilos | **Tailwind CSS v3** (reusa tokens night/light actuales) |
| Router | **@solidjs/router** |
| Primitivos UI accesibles | **Kobalte** (`@kobalte/core`) + Tailwind |
| Data layer | **@tanstack/solid-query** (caché/revalidación/mutaciones) |
| Animaciones | **solid-transition-group** (mount/unmount + reflow de listas) + **solid-motionone** (gestos, count-up, stagger, inView) |
| Iconos | **lucide-solid** |
| Fechas | nativo `Intl` + helpers propios (replicar el manejo actual, ver §13) |
| Serving | Axum `nest_service("/v3", ServeDir::new("solid/dist").fallback(index.html))` |
| Path/carpeta | Código en **`solid/`** (raíz del repo); build a `solid/dist`; base pública **`/v3/`** |

---

## 3. Convivencia y serving

### 3.1 Backend (Axum)
Espejo exacto del serving de `/v2` (ver `backend-and-api.md §1`). En `src/main.rs`, junto al
`nest_service("/v2", …)` existente, añadir:

```rust
.nest_service(
    "/v3",
    ServeDir::new("solid/dist")
        .fallback(ServeFile::new("solid/dist/index.html")),
)
```

- Fuera del router protegido por sesión (igual que `/v2`).
- El SPA llama `/api/...` **absolutos** (nunca `/v3/api/...`) → los mismos handlers protegidos.
- `/v3/<ruta-cliente>` inexistente cae a `index.html` (client-side routing).

### 3.2 Vite
- `base: '/v3/'` (para que los assets salgan como `/v3/...`).
- Router de Solid con `base="/v3"`.
- **Dev server** con proxy a Axum `:8090` para `/api`, `/login`, `/logout` (igual que hace `Trunk.toml` hoy). Las cookies siguen necesitando un host de tenant real (`slug.localhost:8090`); documentar en el README del `solid/`.

### 3.3 CI/CD
- Extender `.github/workflows/deploy.yml`: paso `npm ci && npm run build` en `solid/` antes del build del binario; subir `solid/dist` junto al binario.
- Mientras dure la migración, ambos (`/v2` y `/v3`) se despliegan.

---

## 4. Estructura del proyecto Solid

```
solid/
├─ index.html
├─ vite.config.ts            # base /v3/, proxy dev, plugins solid+tailwind
├─ tailwind.config.ts        # tokens portados de frontend/tailwind.config.js
├─ tsconfig.json
├─ package.json
└─ src/
   ├─ main.tsx               # render + QueryClientProvider + Router base=/v3
   ├─ App.tsx                # <Routes> (todas las rutas con lazy imports) + <RequireAuth>
   ├─ index.css              # @tailwind + CSS vars de ambos temas (:root / [data-theme=light])
   ├─ lib/
   │  ├─ api/
   │  │  ├─ client.ts        # fetch tipado (credentials, 401/403, multipart, base64/blob)
   │  │  ├─ types.ts         # DTOs (portados de src/models.rs + shapes de backend-and-api.md)
   │  │  ├─ auth.ts          # login/logout/me
   │  │  ├─ finance.ts       # accounts, categories, contacts, transactions, recurring, planned, forecasts
   │  │  ├─ fiscal.ts        # cfdi (jobs+poll), sat-configs (multipart)
   │  │  ├─ admin.ts         # companies, users
   │  │  ├─ operations.ts    # orders, projects, concepts, concept-statuses, resources, logs, usages
   │  │  └─ misc.ts          # tiempo, pdf, qr
   │  ├─ auth/               # AuthContext, RequireAuth, permisos (role + permissions[])
   │  ├─ theme.ts            # store de tema (localStorage alfredodev-theme, data-theme)
   │  ├─ format.ts           # money ($1,232,543.90), fechas, RFC3339 (replicar §13)
   │  └─ motion.ts           # helpers de animación + prefers-reduced-motion
   ├─ components/            # sistema de diseño (ver §7)
   │  ├─ ui/                 # Badge, Button, Card, Input, Select, Checkbox, Table, Modal, Toast, Spinner
   │  ├─ layout/             # AppShell, Sidebar, NavGroup, Topbar, CompanySwitcher, ThemeToggle
   │  └─ charts/             # LineArea, Donut (port de charts.rs a SVG en Solid)
   └─ pages/                 # una carpeta/archivo por página (ver §9)
```

**Regla anti-conflicto:** cada agente de página crea/edita SOLO sus archivos en `src/pages/<x>`
(y opcionalmente su módulo `lib/api/<dominio>`). El **router (`App.tsx`), el api client, los
tipos y los componentes `ui/` y `layout/` se escriben en la Fase A y quedan de solo-lectura**
para los agentes de página. Así nadie pisa a nadie.

---

## 5. Contrato de la capa de datos (definido por el orquestador)

Espejo de `backend-and-api.md`. Firma del cliente (los agentes implementan contra esto):

```ts
// lib/api/client.ts
export async function apiGet<T>(path: string, params?: Record<string,string>): Promise<T>
export async function apiPost<T>(path: string, body?: unknown): Promise<T>
export async function apiPostForm<T>(path: string, form: FormData): Promise<T>  // multipart SAT
export async function apiGetBlob(path: string): Promise<Blob>                    // QR raw PNG
// Todos: credentials:'include', base '' (absoluto), Accept json.
// 401 -> redirige a /login (limpia auth). 403 -> lanza ApiError(403) (UX de "sin permiso").
```

**Solid Query:** cada lista/detalle es un `createQuery`; cada create/edit/delete un
`createMutation` que invalida la(s) query key(s) del dominio. Keys por dominio+company.

**Quirks a manejar explícitamente (de `backend-and-api.md §d`):**
- **CFDI**: descarga = job async → `createQuery` con `refetchInterval` (~4s) mientras haya job activo; **cancelar el poll con `onCleanup`/enabled** (bug actual: no limpia).
- **PDF**: llega base64 dentro de JSON → decodificar a Blob para preview/descarga.
- **QR**: llega `image/png` crudo → `apiGetBlob` → objectURL.
- **SAT config**: upload multipart real (`cer_file`, `key_file` + campos) → `apiPostForm`.
- **Mismatches de nombres**: contacts lista `kind` / payload `contact_type`; transacciones lista en `/api/admin/transactions/data`; concepts create en `/projects/{id}/concepts` pero update/advance/delete en `/project_concepts/{id}/...`. Cada módulo api encapsula estas rarezas para que la página no las vea.
- **Permisos**: `role` + `permissions[]` de `/api/me` son solo UX; el server manda (401/403). Preservar la distinción en el manejo de errores.

---

## 6. Auth y modelo multi-tenant en el SPA

De `backend-and-api.md §a-b`:
- **Bootstrap:** al cargar, `GET /api/me` → `{user, company, role, permissions[], companies[]}`. 401 → a `/login`.
- **Login:** `POST /login {username, code}` → `{ok, redirect_url?}`. Éxito → `window.location.href = redirect_url` (el server ya seteó las cookies multi-variante para el subdominio del slug).
- **Logout:** `POST /logout` (limpia cookies) → a `/login`.
- **Tenant switch:** `CompanySwitcher` navega por subdominio completo (swap de URL slug), no SPA nav. Oculto si ≤1 compañía.
- `RequireAuth` envuelve todas las rutas menos login.

---

## 7. Sistema de diseño portado (de `design-system.md`)

- **Tokens:** portar los HSL de `:root` (night) y `[data-theme=light]` a `solid/src/index.css`;
  exponerlos a Tailwind con `hsl(var(--x) / <alpha-value>)`. Copiar el `tailwind.config.js` actual
  a `tailwind.config.ts` (colors: background, foreground, card, muted, border/input, primary(=ring), accent, destructive).
- **Tema:** replicar mecanismo exacto — `localStorage['alfredodev-theme']`, default dark, set/remove `data-theme="light"` en `<html>`. `ThemeToggle` en el topbar.
- **Componentes `ui/`** (portar props/variantes/clases 1:1 de `design-system.md`):
  Badge (con el mapeo completo de tonos: FlowType, PlannedStatus, AccountType, role, priority, activo/inactivo), Button, Card(+Header/Title/Content), Input, Select, Checkbox.
  Nuevos sobre Kobalte: **Modal/Dialog, Dropdown, Toast, Tabs, Accordion** (accesibles).
- **Correcciones conscientes (no replicar):** `Input` debe **cablear el prop `disabled`** de verdad; la píldora de estado de job CFDI debe usar tokens de tema (hoy es solo-light).

---

## 8. Layout compartido (de `pages-part1.md` + `pages-part2.md`)

`AppShell` = `Sidebar` (ancho fijo) + columna derecha (`Topbar` + `<main>` ruteado).

- **Sidebar:** links estáticos (Inicio, Tiempo condicional, Mi cuenta) + grupos accordion
  **gated por permisos** (`NavGroup` = `<details>` nativo, abierto por defecto, chevron `rotate`):
  - No-admin (staff): grupo **Operaciones** (Proyectos / Uso de recursos, gated).
  - Admin: **Finanzas** (Cuentas/Categorías/Contactos/Movimientos/Planes recurrentes/Entradas planificadas/Pronósticos), **Operaciones**, **Fiscal** (CFDIs/Config. SAT), **Administración** (Compañías/Usuarios).
- **Topbar:** izquierda = usuario + compañía + badge de rol; derecha = ThemeToggle + CompanySwitcher + logout.

---

## 9. Inventario de páginas (base a replicar)

Detalle completo en `pages-part1.md` / `pages-part2.md`. Resumen de rutas (bajo base `/v3`):

| Grupo | Ruta | Página | Notas de port (dificultad) |
|---|---|---|---|
| Home | `/` | Dashboard | KPIs; candidato #1 para stagger + count-up |
| Finanzas | `/accounts` | Accounts | CRUD simple |
| Finanzas | `/categories` | Categories | CRUD simple |
| Finanzas | `/contacts` | Contacts | mismatch `kind`/`contact_type` |
| Finanzas | `/transactions` | Transactions | **analítica cliente** (buckets mensuales, KPIs, donut/line) |
| Finanzas | `/recurring-plans` | RecurringPlans | campo oculto `version` load-bearing |
| Finanzas | `/planned-entries` | PlannedEntries | **3 flujos**: CRUD + "Pagar" + bulk-pay con selección |
| Finanzas | `/forecasts` | Forecasts | campo oculto `generated_at` |
| Fiscal | `/cfdi` | Cfdi | **job async + poll** (onCleanup); analítica cliente |
| Fiscal | `/sat-configs` | SatConfigs | **upload multipart** (2 archivos) |
| Cuenta | `/account` | Account | perfil propio |
| Admin | `/companies` | Companies | CRUD; slugs reservados |
| Admin | `/users` | Users | **form compuesto**: user + N membresías/rol/permisos; QR+secreto TOTP en edición |
| Ops | `/orders` | Orders | **line-items dinámicos** (per-field signals → `createStore`) |
| Ops | `/projects` | Projects | CRUD; enlaza a detalle |
| Ops | `/projects/:id` | ProjectDetail | conceptos anidados; roots de API distintos por operación |
| Ops | `/concept-statuses` | ConceptStatuses | CRUD simple |
| Ops | `/resources` | Resources | CRUD simple |
| Ops | `/resource-logs` | ResourceLogs | `datetime-local`→RFC3339 con `Z` (replicar tal cual, §13) |
| Ops | `/resource-usages` | ResourceUsages | **grid 24×N**: DOM como fuente de verdad, gate `can_edit`, POST del estado completo → **rebuild reactivo con `createStore`** |
| Ops | `/tiempo` | Tiempo | **~300 líneas de JS a mano** (timeline virtualizado + SVG) → **rebuild nativo en Solid**, no port |

`charts.rs` no es ruta: son 2 builders SVG (`line_area_chart`, `donut`) → `components/charts/`.

---

## 10. Estrategia de diseño ("claude design" → mockups reales)

En vez de mockups desechables, la **Fase A produce el diseño hecho realidad**: sistema de
diseño + layout + **2 pantallas de referencia** (Dashboard + una CRUD, p.ej. Accounts/Transactions)
funcionando en Solid con los tokens night/light. Eso es tu **gate de aprobación de look**:
lo ves navegable (light y dark) y decides antes de fanear el resto. Ventaja vs. HTML estático:
lo que apruebas es el código real, cero retrabajo.

Si prefieres además un set de mockups estáticos previos, se puede, pero la recomendación es
aprobar sobre las 2 pantallas reales.

---

## 11. Estrategia de animaciones (de `animation-strategy.md`)

Se aplican en una **pasada posterior a la paridad** (capa de "mejora"). Mapeo:

| Interacción | Librería |
|---|---|
| Transición de ruta/página | solid-transition-group (`<Transition mode="outin">`) |
| Filas de tabla enter/remove/reorder | solid-transition-group (`<TransitionGroup moveClass>` = FLIP) |
| Modal/drawer | solid-motionone (`<Presence>` + `<Motion.div>`) |
| Toasts | transition-group (reflow) + motionone (pulido opcional) |
| Accordion sidebar | transition-group |
| Count-up de KPIs | solid-motionone (tween de señal numérica) |
| Stagger de cards al montar | solid-motionone (delay por índice) |
| Micro-interacción hover/press | solid-motionone (`hover`/`press`, accesible por teclado) |
| Reveal on scroll | solid-motionone (`inView`) |

**Top oportunidades (alto impacto):** stagger de KPIs en dashboard; count-up de saldos/totales;
highlight al insertar fila; exit al borrar/cancelar; modal open/close; toasts; cross-fade de rutas;
accordion. **Red flags:** motionone no tiene spring (usar duration+easing); no hay `layout`/FLIP en
motionone (usar `moveClass`); respetar `prefers-reduced-motion` (fade en vez de translate/scale);
**no** animar fila-por-fila tablas grandes (diff/virtualizar; replace = fade de página).

---

## 12. Plan de ejecución en paralelo (agentes)

> El orquestador (yo) define contratos y revisa/integra cada ola. Los agentes ejecutan.
> Modelo por costo: **Sonnet** para implementación; **Opus** para lo más delicado (contrato de
> tipos/api y las 2 páginas más complejas); **Haiku** para CRUD mecánico repetitivo.

### Fase A — Scaffold + diseño (SERIAL, 1 agente fuerte + revisión mía) — *gate de aprobación*
Crea todo lo compartido y las 2 pantallas de referencia. Debe terminar y ser revisado **antes**
de fanear páginas (todo depende de esto). Entrega:
1. Proyecto Vite+Solid+TS+Tailwind+Kobalte+solid-query+router+animaciones.
2. `lib/api/client.ts` + `types.ts` (contrato §5) — **defino yo las firmas, agente implementa**.
3. `theme.ts` + `index.css` + `tailwind.config.ts` (tokens).
4. `components/ui/*` + `components/layout/*` (sistema de diseño §7-8).
5. `App.tsx` con **todas las rutas ya declaradas** vía `lazy(() => import('./pages/X'))` (placeholders).
6. **Dashboard + Accounts (o Transactions)** completos = gate de diseño.
→ **Aquí te pido aprobación del look (light/dark) antes de continuar.**

### Fase B — Fan-out de páginas (PARALELO; cada agente = archivos disjuntos)
Nadie edita `App.tsx`/`ui/`/`api client` (solo-lectura): cada agente **rellena su placeholder**.

| Agente | Páginas | Modelo |
|---|---|---|
| B1 Finanzas-core | categories, contacts, transactions | Sonnet |
| B2 Finanzas-plan | recurring-plans, planned-entries, forecasts | Sonnet |
| B3 Fiscal | cfdi (poll), sat-configs (multipart) | Sonnet |
| B4 Admin | companies, users, account | Sonnet |
| B5 Ops-A | orders, projects, project-detail, concept-statuses | Sonnet |
| B6 Ops-B | resources, resource-logs, resource-usages (grid) | Sonnet |
| B7 Tiempo | tiempo (rebuild nativo) | **Opus** |

(Dashboard y Accounts ya salieron en Fase A.)

### Fase C — Pasada de animaciones (PARALELO por grupo, tras verificar paridad)
Aplica el mapeo §11 sobre páginas ya funcionando. Empezar por dashboard/modales/tablas/rutas.

### Fase D — Serving + cutover (backend)
1. `nest_service("/v3", …)` en `src/main.rs`.
2. Script de build + CI (`solid/` → `solid/dist`).
3. Verificación de paridad `/v2` vs `/v3` (§14). Cutover: apuntar el path principal a Solid, retirar `/v2` cuando estés conforme.

**Regla de correctness (de mi CLAUDE.md):** solo se paraleliza *escribir* archivos disjuntos.
Nada de paralelizar builds/benchmarks o el registro de rutas compartido.

---

## 13. Bugs/rarezas actuales — decisiones explícitas

| Hallazgo | Decisión |
|---|---|
| `Input` tiene clases `disabled:` pero no cablea `disabled` | **Corregir** (cablear prop). |
| Píldora de estado job CFDI solo-light, no usa tokens | **Corregir** (usar tokens de tema). |
| `datetime-local`→RFC3339 append `"Z"` (trata local como UTC) | **Replicar exacto** por ahora (cambiarlo altera semántica de datos); anotar como deuda. |
| `project_detail` hardcodea `notes: None` aunque el payload lo soporta | **Revisar**: exponer `notes` (posible mejora), confirmar con backend. |
| `resource_usages` lee del DOM y hace POST del estado completo | Reconstruir con `createStore`, **preservar el contrato de POST completo**. |
| Endpoints legacy no usados (`/api/sat/cfdi/download`, sub-endpoints resource_usages) | **No portar** salvo confirmación vía `/docs` (Swagger, solo test-tenant). |

---

## 14. Verificación y testing

- **Paridad visual/funcional:** con `/v2` y `/v3` corriendo, comparar pantalla a pantalla (light y dark).
- **e2e:** el repo ya tiene `e2e/` — adaptar/duplicar los flujos críticos apuntando a `/v3`
  (login, CRUD de una entidad, planned-entry pay, grid de usage, tiempo).
- **Smoke:** flujo de login → bootstrap `/api/me` → navegación por cada ruta → una mutación por dominio.
- Gate por fase: no se avanza de A→B sin tu OK de diseño; no C sin paridad verificada en B.

---

## 15. Riesgos y mitigaciones

| Riesgo | Mitigación |
|---|---|
| Cookies/tenant en dev (subdominio) | Documentar correr contra `slug.localhost:8090` vía proxy Vite; igual que Trunk hoy. |
| `tiempo` y `resource-usages` (lógica no trivial) | Asignados a agente Opus / rebuild dedicado, con su sección de anexo como spec. |
| Deriva de contrato entre agentes | Contrato (api/types/components/router) congelado en Fase A y solo-lectura en B. |
| Regresiones de paridad | `/v2` intacto como referencia + e2e + gates por fase. |
| Bundle/perf de animaciones | transform/opacity, reduced-motion, no animar tablas grandes fila a fila. |

---

## 16. Estado / próximos pasos

- [x] Inventario completo (backend+api, páginas ×2, diseño, animaciones).
- [x] Decisiones de stack cerradas (§2) + serving `/v3` (§3).
- [ ] **Aprobación de este plan** ← estamos aquí.
- [ ] Fase A (scaffold + diseño) → **gate de aprobación de look**.
- [ ] Fase B (fan-out de páginas en paralelo).
- [ ] Fase C (animaciones).
- [ ] Fase D (serving `/v3` + cutover).

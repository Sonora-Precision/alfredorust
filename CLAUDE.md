# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Build
cargo build

# Run (development)
cargo run

# Hot-reload development (default job is `run-long`)
bacon

# Tests
cargo test

# Run a single test
cargo test <test_name>

# Run tests in a specific file
cargo test --test <test_file_name>
```

The app runs on port **8090**. Integration tests use an isolated MongoDB DB named `alfredodevtest_*`.

## Architecture

**alfredorust** is a multi-tenant financial management web app built with Axum (Rust). It uses TOTP-based authentication, MongoDB for persistence, Askama for HTML templating, and Typst for PDF generation.

### Multi-tenancy

Companies are tenants selected via subdomain: `slug.alfredorivera.dev` in production, `slug.localhost:8090` in local dev. All financial entities are scoped by `company_id`. Users can belong to multiple companies with per-company roles (Admin/Staff), bridged by the `UserWithCompany` struct and the `user_companies` collection.

`app.alfredorivera.dev` is reserved exclusively for the login page — the slug `app` is blocked in `state/companies.rs` via `RESERVED_SLUGS`.

### Authentication

- TOTP login: email + 6-digit code (no password)
- Sessions stored in MongoDB with 24-hour TTL
- `session.rs` provides middleware and an extractor that injects `UserWithCompany` into protected handlers
- Public routes: `/`, `/login`, `/secret`, `/setup`, `/qrcode`
- All `/admin/*`, `/account`, `/pdf`, `/tiempo` routes are session-protected
- After login, the app redirects to `https://slug.alfredorivera.dev` using `BASE_DOMAIN` env var

### Code Structure

| Path | Purpose |
|------|---------|
| `src/main.rs` | Router wiring — all route registrations |
| `src/models.rs` | All domain types (User, Company, Account, Category, Transaction, RecurringPlan, PlannedEntry, Forecast) |
| `src/state/mod.rs` | `AppState` struct with MongoDB collection handles |
| `src/state/users.rs` | User and session management functions |
| `src/state/companies.rs` | Company CRUD — contains `RESERVED_SLUGS` constant |
| `src/state/finance.rs` | Finance entity CRUD (accounts, categories, contacts, recurring plans, planned entries, transactions, forecasts) |
| `src/routes/login.rs` | Login handler + `compute_redirect_url` / `compute_root_domain` / `set_cookies_for_host` |
| `src/routes/` | HTTP handlers grouped by feature |
| `src/templates/` | Askama HTML templates |
| `data/` | Seed JSON files loaded once if DB is empty |

### Key Domain Enums

- `FlowType`: `Income` / `Expense`
- `AccountType`: `Bank` / `Cash` / `CreditCard` / `Investment` / `Other`
- `TransactionType`: `Income` / `Expense` / `Transfer`
- `PlannedStatus`: `Planned` / `PartiallyCovered` / `Covered` / `Overdue` / `Cancelled`

`RecurringPlan` has a `version` field — incrementing it marks existing `PlannedEntry` records as outdated.

### Environment

Configure via `.env` (excluded from git):
- `MONGODB_URI` — MongoDB Atlas connection string (`mongodb+srv://demo:...@cluster0.s3ja5ef.mongodb.net/`)
- `MONGODB_DB` — database name (`alfredodev`)
- `BASE_DOMAIN` — root domain for tenant routing (`alfredorivera.dev` in prod, omit for localhost)

---

## Production Infrastructure

### Server
- **IP:** `134.199.216.25`
- **OS:** Ubuntu 24.10 (EOL — apt sources point to `old-releases.ubuntu.com`)
- **SSH:** `ssh alfredo@134.199.216.25`
- **App binary:** `/home/alfredo/alfredorust/alfredodev`
- **Repo clone:** `/home/alfredo/alfredorust/`
- **Env file:** `/home/alfredo/alfredorust/.env`

### Systemd Service
```bash
sudo systemctl restart alfredorust   # restart app
sudo systemctl status alfredorust    # check status
sudo journalctl -u alfredorust -f    # live logs
```
Service file: `/etc/systemd/system/alfredorust.service`
Runs as user `alfredo`, reads `.env` via `EnvironmentFile`.

### Nginx
Config: `/etc/nginx/sites-available/app.alfredorivera.dev`
- Listens on port 80 and 443
- `server_name *.alfredorivera.dev` → proxies to `127.0.0.1:8090`
- WordPress at `alfredorivera.dev` and `www.alfredorivera.dev` is handled by a separate config
- SSL cert used is for `alfredorivera.dev` (Let's Encrypt via Certbot)

```bash
sudo nginx -t && sudo systemctl reload nginx   # test and reload
```

### DNS (Cloudflare)
Domain `alfredorivera.dev` managed in Cloudflare. Relevant records:
| Type | Name | Value | Proxy |
|------|------|-------|-------|
| A | `*` | `134.199.216.25` | Proxied (orange) |
| A | `app` | `134.199.216.25` | Proxied |
| A | `alfredorivera.dev` | `134.199.216.25` | Proxied |

**SSL/TLS mode: Flexible** — Cloudflare handles HTTPS with browsers, sends HTTP to origin.
The wildcard `*.alfredorivera.dev` DNS covers all company slugs (e.g. `research.alfredorivera.dev`).

### CI/CD (GitHub Actions)
- **Repo:** `https://github.com/lrivera/alfredorust`
- Workflow: `.github/workflows/deploy.yml`
- On push to `main`: builds release binary on GitHub's Ubuntu runner, SCPs binary to server, restarts `alfredorust` service
- Cache: `~/.cargo/registry` + `target/` cached by `Cargo.lock` hash
- Required GitHub Secrets: `SSH_HOST`, `SSH_USER`, `SSH_PRIVATE_KEY`
- Build takes ~3-5 min first time, faster with cache hit

---

## Guía de decisión de renderizado — cuándo DOM, cuándo Canvas, cuándo WebGPU

App en SolidJS. Aplicar estos criterios (basados en benchmarks propios medidos en producción, no teoría) al implementar o proponer cómo renderizar UI, especialmente listas, tablas, gráficos o cualquier elemento que se actualice con frecuencia. No aplicar a ciegas: usar como marco de decisión y explicar brevemente la elección al implementar algo con datos dinámicos o visualización.

### El principio general
El costo de renderizado no depende del "framework", depende de: (1) cuántos nodos/elementos cambian por actualización, (2) qué tan seguido cambian, (3) si el contenido es texto/interactivo (necesita DOM) o puramente visual (puede vivir fuera del DOM). Elegir la herramienta según estas tres variables, no por hábito ni por lo que se ve "más moderno".

### Regla 1 — El DOM (Solid normal) es la opción por defecto y correcta para casi todo
Usar Solid normal (signals, `<For>`, `createMemo`) para: formularios, listas y tablas de hasta unos pocos miles de filas, texto, navegación, cualquier cosa donde el usuario necesite seleccionar texto, usar lector de pantalla, o donde importe SEO. Solid con reactividad granular bien usada (sin desestructurar props, derivados como funciones, `<For>` con key) ya rinde cerca del techo práctico del DOM. No sacar nada del DOM "por si acaso" sin haber medido primero que el DOM es realmente el cuello de botella.

### Regla 2 — Antes de optimizar, identifica si el problema es reactividad o volumen
Si algo se siente lento, primero verificar que la reactividad esté bien granular (memos correctos, sin recalcular de más, sin desestructurar props, `<For>` con key estable) antes de considerar salir del DOM. La mayoría de la "lentitud" en apps reales es reactividad mal aplicada, no un límite del DOM. Solo considerar Canvas/WebGPU cuando el volumen de nodos vivos actualizándose simultáneamente sea el problema.

### Regla 3 — Canvas 2D: la opción intermedia para gráficos/visualizaciones de tamaño medio
Usar Canvas 2D (API nativa, sin librerías de charts) cuando: hay un gráfico/visualización con cientos a pocos miles de puntos actualizándose seguido (línea en tiempo real, sparkline, heatmap chico) y se quiere evitar mantener cientos de nodos DOM vivos, pero el volumen no justifica WebGPU. Medido aquí: gráfico de ~100 puntos → Canvas 2D ~0.045ms/frame vs WebGPU ~0.141ms/frame (a esa escala WebGPU es MÁS caro por el overhead de buffers/encode/submit). Si dudas entre Canvas y WebGPU para tamaño moderado, empieza con Canvas 2D.

### Regla 4 — WebGPU: solo para carga masiva y paralela
Usar WebGPU (compute shaders WGSL) únicamente cuando el trabajo por frame sea genuinamente masivo y paralelo: decenas de miles a millones de elementos actualizándose cada frame (grids densos, autómatas celulares, sistemas de partículas grandes, millones de puntos). Medido aquí: 16,384 celdas/frame → mejor DOM granular ~110 fps vs WebGPU 180 fps (tope de monitor); 1,048,576 celdas → ningún approach DOM renderiza a tasas interactivas, WebGPU sigue en el tope. La frontera real: unos pocos miles de nodos vivos el DOM (bien hecho) alcanza; por encima, GPU no es optimización, es la única opción viable.

### Regla 5 — Arquitectura híbrida: la tabla en DOM, el gráfico aparte
Cuando una vista combina texto/datos tabulares con visualización pesada (dashboard), NUNCA sacar todo el dashboard del DOM. Dejar tabla, filtros, texto y controles en DOM/Solid normal (necesitan selección, accesibilidad, SEO) y aislar SOLO la parte puramente visual (gráfico/mapa/simulación) en su propio `<canvas>`. Medido aquí: dashboard con tabla de 10,000 filas actualizándose + gráfico de línea simple → cambiar el gráfico de SVG a Canvas/WebGPU no movió el FPS general, porque la tabla —no el gráfico— era el cuello de botella. Antes de mover un gráfico a Canvas/WebGPU, confirmar que el gráfico es de verdad el cuello de botella y no la tabla/lista alrededor.

### Regla 6 — Nunca pierdas accesibilidad ni selección de texto sin más
Si sacas algo del DOM (Canvas/WebGPU) y contiene información que el usuario podría leer con lector de pantalla, seleccionar o buscar, considerar mantener un elemento DOM paralelo invisible (o `aria-label`/texto oculto) con la info equivalente. Solo donde el contenido tenga valor informativo real, no en decoración puramente visual.

### Regla 7 — Signals de Solid como fuente de verdad, incluso alimentando Canvas/WebGPU
Al implementar en Canvas o WebGPU, seguir usando signals de Solid como fuente de verdad de los datos y un solo `createEffect` que dispare el redibujado — no reinventar gestión de estado paralela para la parte gráfica. Mantiene consistencia y evita bugs de sincronización entre el estado de Solid y lo que se ve en el canvas.

### Referencia rápida
| Escenario | Usa |
|---|---|
| Formularios, tablas normales, navegación, texto | Solid + DOM |
| Tabla/lista de hasta unos miles de filas, updates frecuentes en una fracción | Solid + `<For>` con reactividad granular (sin salir del DOM) |
| Gráfico/visualización de cientos a pocos miles de puntos, actualiza seguido | Canvas 2D |
| Grid denso, simulación, partículas: decenas de miles a millones de elementos por frame | WebGPU (compute shader) |
| Dashboard con tabla + gráfico | Tabla en DOM, gráfico aislado en Canvas (WebGPU solo si el gráfico mismo es masivo) |

### Animaciones en este proyecto (Solid)
Para transiciones/animaciones de UI normal (fades, entradas/salidas de listas, reordenamiento), usar `solid-transition-group` como base. Si se necesita algo más rico (springs, gestos, secuencias), añadir `solid-motionone` encima (se combinan bien). NO usar Canvas/WebGPU para animaciones de interfaz normales (botones, modales, listas): las reglas de GPU son para volumen de datos/visualización, no para microinteracciones de UI, que el DOM maneja perfectamente con CSS/transition-group.

### Nota final
Estas reglas vienen de mediciones reales, no de "GPU siempre gana". Lo más importante: para el 90% de una app normal (formularios, tablas, dashboards típicos), Solid + DOM bien hecho ya es lo más rápido y lo más simple de mantener. Salir del DOM solo con evidencia concreta (no sospecha) de que el volumen de nodos vivos actualizándose por frame es el cuello de botella real.

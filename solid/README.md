# alfredodev SPA (SolidJS, `/v3`)

SolidJS rewrite of the Leptos SPA at `frontend/` (historically served at `/v2`).
Current production serves this app at `/v3` and CI deploys `solid/dist` — see
`docs/solid-migration/PLAN.md`.

## Usage

```bash
npm install
npm run dev     # Vite dev server, proxies /api, /login, /logout -> :8090
```

In another terminal, run the backend:

```bash
cargo run   # or `bacon` for hot reload
```

**Tenant subdomains matter.** The backend derives the active company from the
`Host` header, and the session cookie is scoped per-subdomain. Visiting plain
`localhost:5173` will bootstrap without a valid tenant. Use a real tenant
subdomain instead, e.g. `slug.localhost:5173` (matching a company `slug` that
exists in the database), the same way `frontend/Trunk.toml` requires for the
Leptos SPA.

The app is served under base path `/v3/`, so once the dev server is up, open:

```
http://<slug>.localhost:5173/v3/
```

## Build

```bash
npm run build   # tsc -b && vite build -> dist/
```

`dist/` is what gets served by Axum at `/v3` in production
(`nest_service("/v3", ServeDir::new("solid/dist").fallback(index.html))`,
see PLAN §3.1/§16 Fase D).

## Project structure

See `docs/solid-migration/PLAN.md` §4 for the full layout. Frozen contract
(read-only outside Fase A): `src/lib/api/*`, `src/lib/auth/*`,
`src/components/ui/*`, `src/components/layout/*`, `src/App.tsx`. Page bodies
live in `src/pages/<Name>.tsx`, one file per route.

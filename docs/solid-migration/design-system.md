# alfredodev SPA — Design System (for SolidJS + Tailwind port)

Source: Leptos (Rust/WASM) SPA at `frontend/`. This document is a faithful
transcription of the current design system so it can be rebuilt pixel-accurately
in SolidJS + Tailwind. All values are quoted verbatim from source.

---

## Theme System

Source: `frontend/src/theme.rs`, applied via CSS in `frontend/style/input.css`,
consumed as Tailwind color tokens in `frontend/tailwind.config.js`.

### Mechanism

- Two themes: `Theme::Dark` ("night", the default) and `Theme::Light`.
- **Storage:** persisted choice lives in `localStorage` under the key
  `alfredodev-theme`, value `"dark"` or `"light"`.
- **Default on first load / no stored preference:** `Theme::Dark`. There is no
  `prefers-color-scheme` media-query check — dark is the hard default regardless
  of OS preference.
- **DOM application:** theme is reflected on the root `<html>` element via a
  `data-theme` attribute, NOT a class:
  - `Theme::Dark` → the `data-theme` attribute is **removed** from `<html>`
    (dark tokens live in plain `:root`, i.e. dark is the "no attribute" state).
  - `Theme::Light` → `<html data-theme="light">` is set.
- **Toggling:** `Theme::toggled()` is a simple involution (`Dark ⇄ Light`).
  `set_theme(theme)` writes to localStorage AND calls `apply_theme(theme)` to
  update the DOM attribute in the same call — the two are always kept in sync.
  The toggle button (in the Topbar) reads `theme.get().toggled()`, calls
  `set_theme(next)`, then updates a local Leptos signal that drives the icon.
- **Icon:** toggle button shows 🌙 (moon) when current theme is Dark, ☀️ (sun)
  when Light — i.e. the icon shows the CURRENT theme, not the theme you'd
  switch to.

### Porting note for SolidJS

Equivalent implementation: read `localStorage.getItem('alfredodev-theme')` on
boot, default to `'dark'` if absent/invalid; set/remove `data-theme="light"` on
`document.documentElement`; write back to the same localStorage key on toggle.
Keep the key name `alfredodev-theme` identical if you want state continuity
across a rebuild sharing the same domain/browser.

### Design tokens (CSS custom properties)

All values are HSL **triplets without the `hsl()` wrapper** (space-separated
`H S% L%`), consumed by Tailwind as `hsl(var(--x) / <alpha-value>)` so alpha
modifiers (`bg-primary/90`, `ring-emerald-500/30`, etc.) work.

Defined in `frontend/style/input.css`:

| Token (`--var`) | Dark ("night", default, `:root`) | Light (`:root[data-theme="light"]`) |
|---|---|---|
| `--background` | `222 47% 7%` | `210 40% 98%` |
| `--foreground` | `213 31% 91%` | `222 47% 11%` |
| `--card` | `222 40% 11%` | `0 0% 100%` |
| `--card-foreground` | `213 31% 91%` | `222 47% 11%` |
| `--muted` | `217 33% 17%` | `210 40% 96%` |
| `--muted-foreground` | `215 20% 65%` | `215 16% 47%` |
| `--border` | `217 30% 22%` | `214 32% 91%` |
| `--input` | `217 30% 22%` | `214 32% 91%` |
| `--primary` | `217 91% 60%` | `217 91% 55%` |
| `--primary-foreground` | `0 0% 100%` | `0 0% 100%` |
| `--accent` | `199 89% 55%` | `199 89% 48%` |
| `--accent-foreground` | `0 0% 100%` | `0 0% 100%` |
| `--ring` | `217 91% 60%` | `217 91% 55%` |
| `--destructive` | `0 72% 55%` | `0 72% 51%` |
| `--destructive-foreground` | `0 0% 100%` | `0 0% 100%` |

`body` applies `@apply bg-background text-foreground;` — that's the only base
rule beyond the token declarations.

---

## Tailwind Config

Source: `frontend/tailwind.config.js`.

```js
content: ["./index.html", "./src/**/*.rs"]
```
(SolidJS equivalent: point at `./index.html` and `./src/**/*.{ts,tsx}`.)

`theme.extend.colors` — every entry maps to the CSS variables above via
`hsl(var(--token) / <alpha-value>)`, which is what enables Tailwind opacity
modifiers on semantic color names:

| Tailwind color name | Maps to |
|---|---|
| `background` | `hsl(var(--background) / <alpha-value>)` |
| `foreground` | `hsl(var(--foreground) / <alpha-value>)` |
| `card` (DEFAULT) | `hsl(var(--card) / <alpha-value>)` |
| `card-foreground` | `hsl(var(--card-foreground) / <alpha-value>)` |
| `muted` (DEFAULT) | `hsl(var(--muted) / <alpha-value>)` |
| `muted-foreground` | `hsl(var(--muted-foreground) / <alpha-value>)` |
| `border` | `hsl(var(--border) / <alpha-value>)` |
| `input` | `hsl(var(--input) / <alpha-value>)` |
| `primary` (DEFAULT) | `hsl(var(--primary) / <alpha-value>)` |
| `primary-foreground` | `hsl(var(--primary-foreground) / <alpha-value>)` |
| `accent` (DEFAULT) | `hsl(var(--accent) / <alpha-value>)` |
| `accent-foreground` | `hsl(var(--accent-foreground) / <alpha-value>)` |
| `ring` | `hsl(var(--ring) / <alpha-value>)` |
| `destructive` (DEFAULT) | `hsl(var(--destructive) / <alpha-value>)` |
| `destructive-foreground` | `hsl(var(--destructive-foreground) / <alpha-value>)` |

No custom fonts, no custom spacing/radius/shadow scale extensions, no plugins
(`plugins: []`). Only stock Tailwind spacing/radius/shadow utilities are used
throughout the codebase (e.g. `rounded-md`, `rounded-xl`, `rounded-full`,
`shadow-sm`, `p-6`, `px-3 py-2`, etc.) — there is no design-token layer for
these beyond what Tailwind ships by default.

---

## CSS Variables & Base Styles

Source: `frontend/style/input.css` (the only hand-written CSS file; `output.css`
is the Tailwind-generated build artifact and not source of truth).

Full structure:

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

@layer base {
  :root { /* dark tokens, see table above */ }
  :root[data-theme="light"] { /* light tokens, see table above */ }
  body {
    @apply bg-background text-foreground;
  }
}
```

Notes:
- No `@layer components` block exists — there are **no custom component
  classes** like `.btn` or `.card` defined in CSS. All component styling is
  done via Tailwind utility classes composed directly in Rust (see Components
  section below), not via `@apply`-based CSS classes.
- No `@import` of external stylesheets/fonts.
- No `@keyframes` / custom animations defined in CSS. The only animated bit is
  a Tailwind `transition-*` utility (color/transform transitions) and one
  `transition-transform` on the sidebar accordion chevron (see Sidebar section).
- No custom fonts are loaded — the app relies on the browser/OS default font
  stack (Tailwind's default `font-sans` stack is not even explicitly applied
  anywhere; no `font-sans`/`font-mono` utility class was found in components).

---

## Components

Source: `frontend/src/components/*.rs`. Directory contains exactly 6 component
files, all re-exported from `frontend/src/components/mod.rs`: `badge.rs`,
`button.rs`, `card.rs`, `checkbox.rs`, `input.rs`, `select.rs`. No other
component files exist in that directory (no separate textarea, modal, tooltip,
tabs, dialog, etc. — those either don't exist yet or are inlined ad hoc in
page files).

All components accept an optional `class: String` prop that is **appended
after** the base classes (`merge_classes(base, extra) = "{base} {extra}"` when
extra is non-empty, else just `base`). This means caller-supplied classes lose
Tailwind specificity ties by *source order* only — last-declared utility wins
in case of literal conflicts within the same layer, so callers can override
by repeating a utility (e.g. passing `"py-1.5"` to shrink an Input's vertical
padding, as `CompanySwitcher` does with `Select`).

### Badge

Props (`frontend/src/components/badge.rs`):

| Prop | Type | Required | Default |
|---|---|---|---|
| `tone` | `BadgeTone` | optional | `BadgeTone::Neutral` |
| `class` | `String` (`into`) | optional | `""` |
| `children` | `Children` | required | — |

`BadgeTone` variants and their exact classes:

| Variant | Classes |
|---|---|
| `Neutral` (default) | `bg-muted text-muted-foreground ring-border` |
| `Success` | `bg-emerald-500/15 text-emerald-600 ring-emerald-500/30` |
| `Warning` | `bg-amber-500/15 text-amber-600 ring-amber-500/30` |
| `Danger` | `bg-rose-500/15 text-rose-600 ring-rose-500/30` |
| `Info` | `bg-sky-500/15 text-sky-600 ring-sky-500/30` |

Base classes (`BADGE_BASE`, always applied, prepended to the tone classes):

```
inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ring-inset whitespace-nowrap
```

Final class string = `"{BADGE_BASE} {tone.classes()} {class}"`. Renders as
`<span class=classes>{children}</span>`.

Note: `Neutral`/`Success`/etc. use token colors (`bg-muted`, `ring-border`)
for Neutral but hardcoded Tailwind palette colors (emerald/amber/rose/sky) for
the semantic tones — these are chosen to read correctly on both themes without
needing separate dark/light variants, since the opacity-based backgrounds
(`/15`, `/30`) sit on top of whatever background/card color is active.

### Button

Props (`frontend/src/components/button.rs`):

| Prop | Type | Required | Default |
|---|---|---|---|
| `variant` | `ButtonVariant` | optional | `ButtonVariant::Primary` |
| `class` | `String` (`into`) | optional | `""` |
| `disabled` | `MaybeProp<bool>` | optional | `false` (reactive) |
| `type` (`r#type`) | `String` (`into`) | optional | `"button"` (never `"submit"` unless explicitly set — deliberate default so action buttons inside forms don't accidentally submit) |
| `children` | `Children` | required | — |

`ButtonVariant` variants and exact classes:

| Variant | Classes |
|---|---|
| `Primary` (default) | `bg-primary text-primary-foreground hover:bg-primary/90` |
| `Secondary` | `bg-muted text-foreground hover:bg-muted/70` |
| `Outline` | `border border-border bg-transparent text-foreground hover:bg-muted` |
| `Ghost` | `bg-transparent text-foreground hover:bg-muted` |

Base classes (`BUTTON_BASE`, always applied):

```
inline-flex items-center justify-center rounded-md px-3 py-2 text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-ring disabled:pointer-events-none disabled:opacity-50
```

Final class string = `"{BUTTON_BASE} {variant.classes()} {class}"`. Renders a
native `<button type=ty class=classes disabled=...>`.

### Card (compound component: 4 sub-parts)

Source: `frontend/src/components/card.rs`. All four accept only `class`
(optional, `into`) and `children` (required).

| Sub-component | Base classes |
|---|---|
| `Card` | `rounded-xl border border-border bg-card text-card-foreground shadow-sm` |
| `CardHeader` | `flex flex-col space-y-1.5 p-6` |
| `CardTitle` | `text-lg font-semibold leading-none tracking-tight` (renders as `<h3>`) |
| `CardContent` | `p-6 pt-0` |

No `CardFooter`/`CardDescription` exist in this codebase (unlike typical
shadcn Card — only these 4 parts are implemented). `CardTitle` is a `<h3>`;
`Card`, `CardHeader`, `CardContent` are `<div>`s.

### Checkbox

Source: `frontend/src/components/checkbox.rs`. Simpler than the others — no
`merge_classes` helper used (class is inlined via `format!`), no base/variant
split.

| Prop | Type | Required | Default |
|---|---|---|---|
| `checked` | `RwSignal<bool>` | required (controlled) | — |
| `label` | `String` (`into`) | required | — |
| `class` | `String` (`into`) | optional | `""` |

Markup:
```html
<label class="inline-flex items-center gap-2 text-sm text-foreground {class}">
  <input type="checkbox" class="h-4 w-4 rounded border-input" ... />
  {label}
</label>
```
No variants/sizes/states beyond checked/unchecked (no explicit `disabled` prop,
no error state).

### Input

Source: `frontend/src/components/input.rs`. Controlled text input.

| Prop | Type | Required | Default |
|---|---|---|---|
| `value` | `Signal<String>` (`into`) | required (controlled) | — |
| `on_input` | `Callback<String>` (`into`) | required | — |
| `class` | `String` (`into`) | optional | `""` |
| `type` (`r#type`) | `String` (`into`) | optional | `"text"` |
| `placeholder` | `String` (`into`) | optional | `""` |
| `autocomplete` | `String` (`into`) | optional | `""` |
| `inputmode` | `String` (`into`) | optional | `""` |
| `maxlength` | `String` (`into`) | optional | `""` |
| `required` | `bool` | optional | `false` |

Base classes (`INPUT_BASE`, always applied, no separate variants):

```
w-full rounded-md border border-input bg-background text-foreground placeholder:text-muted-foreground px-3 py-2 text-sm outline-none transition-colors focus:border-ring focus:ring-2 focus:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50
```

Final class string = `"{INPUT_BASE} {class}"`. There is no built-in error
state (no `error`/`invalid` prop) — pages presumably compose their own error
styling via the `class` override if needed (none observed in the files read).
`disabled` styling exists in the base classes (`disabled:cursor-not-allowed
disabled:opacity-50`) but there's no `disabled` prop wired on the `<input>`
element itself in this component — worth flagging as a possible bug/gap when
porting (the CSS is present but nothing sets the `disabled` attribute).

### Select

Source: `frontend/src/components/select.rs`. Controlled native `<select>`.

| Prop | Type | Required | Default |
|---|---|---|---|
| `value` | `RwSignal<String>` | required (controlled) | — |
| `class` | `String` (`into`) | optional | `""` |
| `children` | `Children` | required (the `<option>` elements) | — |

Base classes (`SELECT_BASE`, always applied):

```
w-full rounded-md border border-input bg-background text-foreground px-3 py-2 text-sm outline-none transition-colors focus:border-ring focus:ring-2 focus:ring-ring/30
```

Same base as Input minus the `placeholder:`/`disabled:` utilities. Final class
string = `"{SELECT_BASE} {class}"`.

---

## Badge Color Mapping

Badge-tone-assignment logic lives centrally in `frontend/src/pages/mod.rs`
(helper functions `flow_badge`, `bool_badge`, `status_badge`, `priority_badge`,
`role_badge`, `type_badge`), reused across page files. One page (`cfdi.rs`)
also defines its own **local, non-Badge-component** status pill for CFDI job
polling states (`queued`/`running`/`done`/`failed`) that does not use the
shared `Badge` component at all — noted separately below.

### `flow_badge(value)` — FlowType

| Value | Label (`flow_label`) | BadgeTone |
|---|---|---|
| `"income"` | "Ingreso" | `Success` |
| `"expense"` | "Egreso" | `Danger` |
| other | value verbatim | `Neutral` |

Used for: `Category.flow_type`, `PlannedEntry.flow_type`, `RecurringPlan.flow_type`,
`TransactionType`-flow rendering (transactions.rs has its own inline copy of
this exact logic, see below).

### `transactions.rs` inline flow/type badge (TransactionType)

`frontend/src/pages/transactions.rs` reimplements the same pattern with a 3rd
case for transfers:

| Value | BadgeTone |
|---|---|
| `"income"` | `Success` |
| `"expense"` | `Danger` |
| `"transfer"` | `Info` |
| other | `Neutral` |

### `bool_badge(on, yes_label, no_label)` — active/inactive & generic booleans

| `on` | BadgeTone | Label used (caller-supplied) |
|---|---|---|
| `true` | `Success` | e.g. "Activa" / "Sí" |
| `false` | `Neutral` | e.g. "Inactiva" / "No" |

Used for: `Account.is_active`, `Company.is_active`, `ConceptStatus.is_active`,
`Resource.is_active`, `RecurringPlan.is_active`.

### `status_badge(label)` — PlannedStatus / order / project status

Tone is inferred by lowercased **keyword substring match on the display
label** (not the raw enum discriminant), in this priority order:

| Condition (substring of lowercased label) | BadgeTone | Corresponds to (PlannedStatus) |
|---|---|---|
| contains `"cancel"` | `Neutral` | `Cancelled` |
| contains `"vencid"`, `"atras"`, or `"overdue"` | `Danger` | `Overdue` |
| contains `"parcial"` or `"partial"` | `Warning` | `PartiallyCovered` |
| contains `"cubiert"`, `"pagad"`, `"complet"`, `"termin"`, `"cerrad"`, or `"listo"` | `Success` | `Covered` (also used for order/project "done" states) |
| contains `"plan"`, `"pendiente"`, or `"proceso"` | `Info` | `Planned` (also "in progress" states) |
| none of the above (unknown custom status) | `Neutral` | — (fallback) |

Used for: `PlannedEntry` status, `Order` status, `Project` status (all pass
the Spanish display label, not the wire value).

### `priority_badge(value, label)` — Project priority

| Value | BadgeTone |
|---|---|
| `"high"` or `"urgent"` | `Danger` |
| `"medium"` | `Warning` |
| `"low"` | `Neutral` |
| other/unknown | `Info` |

### `role_badge(role)` — company user role

| Value | BadgeTone | Extra class |
|---|---|---|
| `"admin"` | `Info` | `uppercase` |
| anything else (e.g. `"staff"`) | `Neutral` | `uppercase` |

Note: the Topbar (`frontend/src/app.rs`) inlines this exact same admin/staff →
Info/Neutral mapping a second time for the role badge shown next to the
username, but WITHOUT the `uppercase` class.

### `type_badge(label)` — generic classifier (e.g. AccountType)

Always `BadgeTone::Info` regardless of value — used for `Account.account_type`
(labels resolved via `account_type_label()` in `accounts.rs`: `bank`→"Banco",
`cash`→"Efectivo", `credit_card`→"Tarjeta de crédito", `investment`→"Inversión",
`other`→"Otro").

### `cfdi.rs` local (non-Badge) status pill — CFDI download job polling

This one does NOT use the `Badge` component/`BadgeTone` — it's a bespoke
`<span>` with its own literal Tailwind classes (note: these are **not**
theme-token-based, they use light-mode-only Tailwind grays/colors and would
look wrong in dark mode — a known inconsistency to be aware of when porting):

| Status | Label | Classes |
|---|---|---|
| `"queued"` | "En cola" | `bg-muted text-muted-foreground` |
| `"running"` | "● Descargando" | `bg-sky-100 text-sky-700` |
| `"done"` | "✓ Listo" | `bg-emerald-100 text-emerald-700` |
| `"failed"` | "✗ Error" | `bg-rose-100 text-rose-700` |
| other | value verbatim | `bg-muted text-muted-foreground` |

Wrapper: `<span class="rounded px-2 py-0.5 text-xs {cls}">`. Separately,
`cfdi.rs` also uses the real `Badge` component for CFDI direction:
`Badge tone=Success` → "Emitido" (issued), `Badge tone=Info` → "Recibido" (received).

---

## Sidebar / Accordion

Source: `frontend/src/app.rs`, components `NavGroup` and `Sidebar`.

### Accordion mechanism (`NavGroup`)

Implemented with the **native `<details>`/`<summary>` element** — no JS
state, no Solid signal needed for open/closed; accessible by default. `open`
attribute is set unconditionally, so **every group is expanded by default**.

```html
<details open class="group">
  <summary class="mt-3 flex cursor-pointer list-none select-none items-center justify-between rounded-md px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground transition-colors hover:bg-muted hover:text-foreground [&::-webkit-details-marker]:hidden">
    <span>{title}</span>
    <svg class="h-3.5 w-3.5 shrink-0 transition-transform duration-200 group-[[open]]:rotate-90" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M7 5l6 5-6 5" />
    </svg>
  </summary>
  <div class="ml-4 mt-1 space-y-0.5 border-l border-border pl-2">{children}</div>
</details>
```

Key technique: `group` on `<details>` + Tailwind's `group-[[open]]:rotate-90`
arbitrary-variant selector rotates the chevron `<svg>` when the `<details>` is
open, purely via CSS attribute selector (`details[open] .group-...`) — no JS.
`[&::-webkit-details-marker]:hidden` hides the native disclosure triangle.
Chevron default points right (`M7 5l6 5-6 5`, a `>`-shape path) and rotates 90°
clockwise when open (pointing down), transition duration `200ms`.

Porting note: in SolidJS + Tailwind you can keep the exact same `<details>`/
`<summary>` markup and classes verbatim (it's plain HTML/CSS, no Leptos-specific
API involved) — this is the simplest component in the whole system to port 1:1.

### Sidebar structure (`Sidebar`)

```
<aside class="w-56 shrink-0 border-r border-border bg-card p-3">
```
- App name label: `<p class="px-3 pb-3 text-sm font-semibold text-foreground">alfredodev</p>`
- Nav wrapper: `<nav class="space-y-1">`
- Nav link classes (constant, applied to every `<a>`/router-link):
  ```
  block rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground aria-[current=page]:bg-muted aria-[current=page]:text-foreground aria-[current=page]:font-semibold
  ```
  Active-link state is driven by the `aria-current="page"` attribute (set
  automatically by `leptos_router`'s `<A>` component) using Tailwind's
  `aria-*` variant — no separate "active" class computed manually. In
  SolidJS with `@solidjs/router`, `<A>` sets `aria-current="page"` too, so
  this pattern ports directly if using solid-router's `<A>`, or you replicate
  it manually by comparing the current route.
- Nav groups (`NavGroup title=...`) present, conditioned on role/permissions:
  "Operaciones" (staff subset), "Finanzas", "Operaciones" (admin full),
  "Fiscal", "Administración" — all admin-only except a reduced "Operaciones"
  group shown to staff with specific permissions. Two ungated top-level links
  always shown: "Inicio" (`/v3/`) and "Mi cuenta" (`/v3/account`); "Tiempo"
  (`/v3/tiempo`) shown conditionally by permission.

---

## Topbar / Tenant Switcher

Source: `frontend/src/app.rs`, components `Topbar` and `CompanySwitcher`.

### Topbar

```
<header class="flex items-center justify-between border-b border-border bg-card px-6 py-3">
```

Left side (`<div class="flex items-center gap-3">`):
- Username: `<p class="text-sm text-muted-foreground">`
- Company name: `<p class="font-semibold">`
- Role badge: real `Badge` component, `tone = Info` if role=="admin" else
  `Neutral` (same mapping as `role_badge()` but inlined here, and WITHOUT the
  `uppercase` class that `role_badge()` applies elsewhere).

Right side (`<div class="flex items-center gap-2">`), in order:
1. **Theme toggle button** — `Button variant=Ghost`, `aria-label="Cambiar tema"`,
   `title="Cambiar tema claro/oscuro"`. Content is an emoji that reflects
   current theme: 🌙 when Dark, ☀️ when Light.
2. **`CompanySwitcher`** (tenant switcher, see below).
3. **Logout button** — `Button variant=Outline`, label "Salir", calls
   `api::logout()` then sets auth state to `Auth::Anon`.

### CompanySwitcher (tenant switcher)

- **Hidden entirely** when the user belongs to only one company
  (`me.companies.len() <= 1` → renders nothing).
- Otherwise renders a `Select` (the shared component) wrapped in
  `<div class="w-44">`, with `class="py-1.5 text-sm"` override (shrinks the
  Select's default `py-2` vertical padding) and `attr:aria-label="Cambiar de
  compañía"`.
- Options are `<option value={company.slug}>{company.name}</option>` for each
  company the user belongs to.
- Switching is **not** an SPA route change — it's a full page navigation via
  `window().location().set_href(...)` to another tenant subdomain, computed by
  `switch_company_href(slug)`: swaps the leftmost host label for the new slug,
  preserves protocol/port, and always lands on `/v3/` on the destination
  tenant. An `Effect` watches the select's `RwSignal<String>` and triggers
  navigation only when it differs from the initial/current slug (so mounting
  doesn't cause a reload loop).

---

## Typography

No custom font family is declared anywhere (no `@import` of a webfont, no
`fontFamily` extension in `tailwind.config.js`, no `font-sans`/`font-mono`
utility observed in components) — the app relies on the browser/OS default
sans-serif stack.

Conventions observed across pages (e.g. `dashboard.rs`, `accounts.rs`):

| Role | Classes |
|---|---|
| Page title (`<h1>`) | `text-xl font-semibold` (sometimes with `mb-4`) |
| Section heading (`<h2>`) | `text-lg font-semibold` (sometimes with `mb-2`) |
| Card title (`CardTitle`, `<h3>`) | `text-lg font-semibold leading-none tracking-tight` |
| Form field label | `block text-sm font-medium text-foreground` |
| Body / table text | `text-sm` (default, no explicit size class needed beyond ambient) |
| Muted/secondary text | `text-sm text-muted-foreground` (or `text-muted-foreground` alone) |
| Small caption / uppercase group label | `text-xs font-semibold uppercase tracking-wide text-muted-foreground` (used for sidebar `NavGroup` summaries and KPI card captions) |
| Badge text | `text-xs font-semibold` (baked into `BADGE_BASE`) |
| Button text | `text-sm font-medium` (baked into `BUTTON_BASE`) |

---

## Spacing & Radius Conventions

No custom spacing/radius scale is defined — everything uses stock Tailwind
values, but usage is consistent enough to read as de-facto conventions:

**Border radius:**
- `rounded-md` — the default for interactive controls: `Button`, `Input`,
  `Select`, `NavGroup` summary, sidebar nav links.
- `rounded-xl` — larger surfaces: `Card`, KPI tiles (`cfdi.rs` charts).
- `rounded-full` — `Badge` (pill shape).
- `rounded` (plain, `0.25rem`) — the ad-hoc CFDI job-status pill only (an
  inconsistency vs. the rest of the app which uses `rounded-full` for badges).

**Padding:**
- Interactive controls (`Button`, `Input`, `Select`): `px-3 py-2`.
- `Badge`: `px-2 py-0.5` (tighter, pill-sized).
- `CardHeader`/`CardContent`: `p-6` (`CardContent` overrides top with `pt-0`
  so header+content padding doesn't double up vertically).
- Sidebar container: `p-3`; sidebar nav links: `px-3 py-2`; `NavGroup`
  summary: `px-3 py-1.5`.
- Topbar: `px-6 py-3`.
- Main content area (`<main>` in `AuthedApp`): `p-6`.

**Borders:**
- `border-border` token color used consistently for all hairline borders
  (`Card`, `Input`/`Select` via `border-input` which shares the same value as
  `--border`/`--input` tokens, Topbar bottom border, Sidebar right border,
  `NavGroup` children's left guide rail).

**Layout shell** (`AuthedApp` in `app.rs`):
```
<div class="flex min-h-screen">
  <Sidebar />                              <!-- w-56 shrink-0 -->
  <div class="flex min-w-0 flex-1 flex-col">
    <Topbar />
    <main class="min-w-0 flex-1 p-6">...</main>
  </div>
</div>
```
Sidebar is a fixed `w-56` column; everything else flexes. `min-w-0` is used
deliberately on both the content column and `<main>` to prevent flex-item
overflow from wide table content (a common Tailwind flex gotcha) — worth
preserving in the Solid port.

**Focus rings:** consistently `focus:ring-2 focus:ring-ring` (Button) or
`focus:ring-2 focus:ring-ring/30` (Input/Select, with `focus:border-ring`
added) — the `ring` token color is shared with `primary` in both themes
(`--ring` equals `--primary` in both dark and light palettes).

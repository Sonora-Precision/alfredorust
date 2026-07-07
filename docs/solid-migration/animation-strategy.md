# Animation strategy for the SolidJS SPA (solid-transition-group + solid-motionone)

Goal: make a data-heavy financial dashboard (tables, forms, modals, sidebar, page
transitions, KPI cards) feel fluid without hurting performance or accessibility.
Two libraries, two different jobs — see the mapping in §3 before writing any code.

---

## 1. solid-transition-group — CSS-class enter/exit transitions

Repo: https://github.com/solidjs-community/solid-transition-group
Demo: https://solid-transition-group.netlify.app/
Primitives variant (same API, part of the `solid-primitives` monorepo):
https://primitives.solidjs.community/package/transition-group/
Also mirrored as `@solid-primitives/transition-group`:
https://www.npmjs.com/package//@solid-primitives/transition-group

Install:

```bash
npm install solid-transition-group
```

Influenced by React Transition Group / Vue `<transition>`. It does **not** run its
own animation engine — it toggles CSS classes (or fires JS callbacks) around
DOM mount/unmount and lets CSS transitions/`Element.animate()` do the work.

### `<Transition>` — single element/component

Wraps one conditionally-rendered child (typically a `<Show>`). Renders **no**
extra DOM node — doesn't show up in the element tree.

| Prop | Default | Notes |
|---|---|---|
| `name` | `"s"` | Prefix for the six auto-generated class names below |
| `enterClass` / `enterActiveClass` / `enterToClass` | `s-enter` / `s-enter-active` / `s-enter-to` | Enter phase, Vue-style 3-class pattern |
| `exitClass` / `exitActiveClass` / `exitToClass` | `s-exit` / `s-exit-active` / `s-exit-to` | Exit phase |
| `mode` | simultaneous | `"outin"` (exit-then-enter) or `"inout"` (enter-then-exit), useful for tab/route swaps |
| `appear` | `false` | Also transition on first render |

Lifecycle callbacks (use for `Element.animate()`/WAAPI or any JS-driven
transition instead of CSS classes): `onBeforeEnter(el)`, `onEnter(el, done)`,
`onAfterEnter(el)`, `onBeforeExit(el)`, `onExit(el, done)`, `onAfterExit(el)`.
`done()` must be called to signal completion — this is how solid-transition-group
can host a `solid-motionone` or WAAPI animation instead of pure CSS.

CSS pattern:

```css
.slide-fade-enter-active,
.slide-fade-exit-active { transition: opacity .3s, transform .3s; }
.slide-fade-enter,
.slide-fade-exit-to     { transform: translateX(10px); opacity: 0; }
.slide-fade-enter       { transform: translateX(-10px); }
```

```tsx
<Transition name="slide-fade" appear>
  <Show when={isVisible()}><div>Hello</div></Show>
</Transition>
```

### `<TransitionGroup>` — lists of elements

Same props as `<Transition>` minus `mode`, plus `moveClass` (default `s-move`):
applied to items whose screen position changed after a re-order/insert/remove
so they animate to their new spot via the FLIP technique using `transform`.

```tsx
<ul>
  <TransitionGroup name="slide">
    <For each={rows()}>{row => <li>{row.text}</li>}</For>
  </TransitionGroup>
</ul>
```

Limitation called out in the repo: it detects DOM-child changes and only
supports a single DOM child per item — not text nodes or fragments, so every
`<For>` item needs a real wrapping element (e.g. `<tr>`, `<li>`, `<div>`).

**Best use-cases:** list item enter/exit (transaction rows, notifications),
modal/toast/drawer mount-unmount, route/page cross-fades (`mode="outin"`),
accordion expand/collapse (height/opacity via CSS, or `onEnter`/`onExit` with
WAAPI for animating to `scrollHeight`).

---

## 2. solid-motionone — declarative, physics-aware animation

Repo: https://github.com/solidjs-community/solid-motionone
npm: https://www.npmjs.com/package/solid-motionone
Background article: https://blog.logrocket.com/animating-solidjs-apps-motion-one/
Upstream engine docs (concepts carry over, package is React/vanilla-focused
now — Solid bindings are community-maintained): https://motion.dev/

Install:

```bash
npm install solid-motionone
# depends on @motionone/dom under the hood
```

~5.8kb library ("a tiny, performant animation library for SolidJS," per the
repo README), hardware-accelerated (WAAPI-driven) animations, springs and
independent transforms.

### `<Motion>` component

Renders any HTML/SVG tag: `<Motion.div>`, `<Motion.button>`, or
`<Motion tag="button">`.

Core props (types extend `motionone.Options` from `@motionone/dom`, plus a
Solid-specific `exit`):

- `initial` — starting values (or `false` to skip the mount animation)
- `animate` — target values; arrays are keyframes, spaced evenly unless an
  `offset` array is supplied
- `transition` — `{ duration, easing, delay }`, with per-property overrides,
  e.g. `transition={{ duration: .4, rotate: { duration: 2 } }}`
- `exit` — values to animate to on unmount (only fires inside `<Presence>`)
- `hover` / `press` / `inView` / `inViewOptions` — declarative gesture and
  viewport-triggered variants (inherited from `@motionone/dom`'s `Options`)
- Event-handler alternative to the declarative gesture props:
  `onHoverStart` / `onHoverEnd`, `onPressStart` / `onPressEnd`,
  `onViewEnter` / `onViewLeave`, plus `onMotionStart` / `onMotionComplete`
- `motion:` directive form is also registered for use as a Solid directive

```tsx
import { Motion, Presence } from "solid-motionone"

<Presence exitBeforeEnter>
  <Show when={modalIsOpen()}>
    <Motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95 }}
      transition={{ duration: 0.18, easing: "ease-out" }}
    >
      Modal content
    </Motion.div>
  </Show>
</Presence>
```

### `<Presence>` — unlocks exit animations

Solid tears down DOM nodes synchronously when a `<Show>`/`<For>` condition
flips, so there's nothing to animate out unless something delays removal —
that's what `<Presence>` does, holding the exiting node until its `exit`
animation finishes. `exitBeforeEnter` sequences exit-then-enter instead of
crossfading (equivalent to `Transition mode="outin"`).

### Gaps / caveats (verified against the repo, July 2026)

- **No spring easing.** Open issue since community port:
  https://github.com/solidjs-community/solid-motionone/issues/6 — the
  `easing` type is `"linear" | "ease" | "ease-in" | "ease-out" | "ease-in-out"
  | "steps-start" | "steps-end"` plus cubic-bezier arrays; the upstream
  Motion One `spring` easing value is **not exposed** through solid-motionone
  today. Don't promise spring-based KPI/number animations — use duration +
  easing curves instead, or reach for raw `@motionone/dom`'s `animate` +
  `spring()` directly if a spring is truly required.
- **No `layout`/FLIP prop.** Unlike Motion for React, solid-motionone doesn't
  expose a `layout` prop for automatic FLIP reflow animation. For animated
  list re-ordering, use `solid-transition-group`'s `<TransitionGroup
  moveClass>` instead (it implements FLIP via CSS transforms already).
- Known interop bug with `solid-styled-components`:
  https://github.com/solidjs-community/solid-motionone/issues/5 — check before
  pairing with a CSS-in-JS layer.

---

## 3. Library split: what to use where

| Interaction | Library | Why |
|---|---|---|
| Page / route transitions | **solid-transition-group** `<Transition mode="outin">` | Router unmounts/remounts whole trees; CSS crossfade is cheap and router-agnostic |
| Table/list row enter, remove, reorder (transactions, planned entries) | **solid-transition-group** `<TransitionGroup moveClass>` | Built-in FLIP reorder via `transform`; no per-row physics needed |
| Modal / drawer / dialog mount-unmount | **solid-motionone** `<Presence>` + `<Motion.div>` | Needs coordinated scale+opacity+position with an exit animation; nicer easing control than CSS keyframes |
| Toast / notification stack | **solid-transition-group** `<TransitionGroup>` for stacking/reflow, optionally with `solid-motionone` for the individual toast's slide-in polish | List reflow is TransitionGroup's job; per-toast micro-motion can use Motion |
| Sidebar accordion expand/collapse | **solid-transition-group** `<Transition>` with `onEnter`/`onExit` animating `max-height`/`grid-template-rows`, or CSS-only if height is static | Binary open/closed state, CSS-driven is enough and avoids layout thrash from JS-measured heights where possible |
| KPI number count-up | **solid-motionone** `animate()`/`<Motion>` driving a numeric signal (interpolate the number in JS on `requestAnimationFrame` via Motion's `animate` primitive, render text) or a dedicated count-up utility built on WAAPI progress callbacks | Needs a tween over a plain number, not a DOM enter/exit — this is Motion's core strength, not Transition's |
| KPI card mount / dashboard widget entrance | **solid-motionone** `<Motion>` with `initial`/`animate`, optionally staggered via per-index `transition.delay` | Declarative, easy to stagger across a `<For>` of cards |
| Hover / press micro-interactions (buttons, table rows, cards) | **solid-motionone** `hover` / `press` props or `onHoverStart`/`onPressStart` | Gesture recognition (incl. keyboard activation for `press`) isn't solid-transition-group's job at all |
| Scroll-into-view reveal (e.g. long forms, report sections) | **solid-motionone** `inView` / `inViewOptions` | Intersection-Observer-backed, built in |
| Form field validation error appear/disappear | **solid-transition-group** `<Transition>` | Small CSS fade/slide, no physics needed, minimal bundle cost per field |
| Sidebar/tenant switcher open menu | **solid-transition-group** `<Transition>` (simple) or **solid-motionone** if you want a spring-like scale-in feel *(remember: no true spring — fake it with an `ease-out` overshoot curve or cubic-bezier)* | Either works; pick Transition first for bundle economy |

Rule of thumb: **binary DOM mount/unmount and list reflow → solid-transition-group.
Anything that's continuously interactive (drag-free gestures, numeric tweening,
staggered declarative entrances, viewport triggers) → solid-motionone.** Don't
use both on the same element for the same phase — pick one owner per transition
to avoid class/inline-style fights.

---

## 4. Performance guidance

- **Animate only `transform` and `opacity`.** Both libraries can technically
  animate anything, but only these two are compositor-only properties in all
  major browsers — everything else (`width`, `height`, `top`, `left`,
  `box-shadow`, `max-height` in some engines) triggers layout/paint. For
  accordions, prefer `transform: scaleY()` with `transform-origin` or a
  `grid-template-rows: 0fr → 1fr` trick over animating `max-height`/`height`
  where feasible; if you must animate height (accordions often force this),
  keep the animated subtree small and isolated (`contain: layout`).
- **Avoid layout thrash.** Don't read `offsetHeight`/`getBoundingClientRect`
  inside an `onEnter`/`onAfterEnter` callback right after writing a style —
  batch reads before writes, or let `TransitionGroup`'s FLIP implementation
  (which already does this correctly) own list reflow instead of hand-rolling it.
- **Respect `prefers-reduced-motion`.** MDN reference:
  https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion,
  WCAG technique C39: https://www.w3.org/WAI/WCAG22/Techniques/css/C39. Two options:
  - CSS-only paths (solid-transition-group): wrap the transition-duration
    rules in `@media (prefers-reduced-motion: no-preference) { … }` so reduced-motion
    users get an instant, un-transitioned swap by default.
  - JS-driven paths (solid-motionone): read
    `matchMedia("(prefers-reduced-motion: reduce)").matches` once (module-level
    signal) and short-circuit `transition={{ duration: reduced() ? 0 : .3 }}`,
    or drop `animate`/`exit` to `initial` values directly. Prefer fades over
    scale/translate/rotate for the reduced variant per WCAG guidance rather
    than removing motion entirely, since a fade is a smaller vestibular trigger.
- **Don't animate huge tables row-by-row.** If a table/grid can have hundreds
  of rows (transactions, planned entries, resource usage grid), animating
  every row's enter/exit on every data refresh will fall over. Mitigations:
  - Virtualize (windowed rendering) before adding row transitions — animating
    a virtualized list only ever animates the ~20-40 rows in the viewport.
  - If not virtualized, only wrap *newly inserted/removed* rows in the
    transition (diff the dataset, don't re-key the whole `<For>` on every
    poll), and skip transitions entirely on full-table replace/sort — that's a
    the-whole-list-changed op, not an enter/exit op, so a page-level fade is
    cheaper and less jarring than N row FLIPs firing at once.
  - Use `content-visibility: auto` on off-screen table sections to cut paint
    cost independent of the animation library.
- **GPU compositing.** `transform`/`opacity` animations run on the compositor
  thread without hitting the SolidJS reactive graph or triggering a Solid
  re-render — that's why both libraries default to those properties. Avoid
  forcing extra layers with unnecessary `will-change`; add it only right
  before an animation starts (or let the browser's heuristics handle it) and
  remove it after, since permanent `will-change` on many elements (e.g. every
  table row) can blow the compositor memory budget.
- **Bundle size.** solid-transition-group is a thin class-toggling wrapper —
  no runtime animation engine, negligible bundle cost. solid-motionone is
  ~5.8kb plus its `@motionone/dom` dependency (WAAPI-based, itself designed to
  be small/tree-shakable relative to Motion for React). For an admin app,
  both are cheap in absolute terms; the practical guidance is to use
  solid-transition-group as the default/cheap tool and reach for
  solid-motionone specifically where its gesture/spring-adjacent/stagger
  features are needed, rather than routing everything through Motion.
- **SSR/CSR note.** This app is CSR-only (SPA), so there's no hydration
  mismatch risk that SSR frameworks worry about with these libraries (e.g. no
  "enter animation fires on hydration" bug class) — `appear`/`initial` can be
  used freely on first paint without special-casing a server render pass.

---

## 5. Top animation opportunities for a fintech admin dashboard

Ranked by UX payoff vs. implementation cost, not novelty:

1. **KPI card mount stagger on dashboard load** (`solid-motionone`, `initial`→`animate`
   with small per-card `delay`) — turns a jarring "everything pops at once" load
   into a readable sequence; helps users' eyes track which number is which.
2. **KPI count-up on value change** (`solid-motionone` tweening the numeric
   signal) — reinforces *that a number changed* and *by how much/which direction*,
   which is the single highest-value cue in a finance dashboard (balances,
   totals, forecast deltas) and doubles as a subtle correctness signal (you
   see the transaction land).
3. **New transaction/planned-entry row insert highlight**
   (`solid-transition-group` `<TransitionGroup>` enter transition, e.g. a brief
   background-color flash + slide-in) — makes newly created/synced rows
   discoverable without the user hunting the table.
4. **Row removal (delete/cancel) exit transition** — confirms the delete
   actually happened (fade+collapse) instead of an abrupt disappearance that
   reads as a bug/UI glitch.
5. **Modal/drawer open-close** (`solid-motionone` `<Presence>`, scale+opacity)
   — the highest-frequency interaction surface (create transaction, edit
   category, resource usage entry); a good open/close feel disproportionately
   shapes "does this app feel polished."
6. **Toast/notification enter-exit + stack reflow**
   (`solid-transition-group` `<TransitionGroup>`) — confirms save/error state
   without a jarring layout pop when multiple toasts stack or clear.
7. **Route/page cross-fade** (`solid-transition-group` `<Transition
   mode="outin">`) — masks the flash-of-unstyled/empty-state during route swap
   between admin sections (accounts → categories → forecasts), especially
   valuable since data is fetched client-side and there's a beat before
   content is ready.
8. **Sidebar accordion expand/collapse** — already exists per recent commits
   (`accordion sidebar categories`); animating it (vs. instant show/hide)
   turns navigation into something that feels directly manipulated rather
   than teleporting, and it's cheap (bounded height, single element).
9. **Form validation error appear/disappear** (`solid-transition-group`,
   small fade+slide-down under the field) — softens the harshness of
   validation errors and draws the eye to *which* field failed without a
   layout jump when multiple errors show/hide across a submit cycle.
10. **Tenant/company switcher menu open** (already exists per recent commits;
    `solid-transition-group` fade+scale) — low-cost polish on a
    high-frequency, high-visibility control (top bar, every session).

Skip/avoid: animating every row of a large unfiltered table on sort/filter
(reads as slow, not fluid), animating on every polling refresh if data is
unchanged (diff first), decorative parallax/rotation on financial data
(reduces perceived trustworthiness of a finance tool — keep motion functional:
confirm, orient, or draw attention, not decorate).

---

## Sources

- solid-transition-group repo: https://github.com/solidjs-community/solid-transition-group
- solid-transition-group demo: https://solid-transition-group.netlify.app/
- Transition Group (Solid Primitives docs): https://primitives.solidjs.community/package/transition-group/
- `@solid-primitives/transition-group` on npm: https://www.npmjs.com/package//@solid-primitives/transition-group
- solid-motionone repo: https://github.com/solidjs-community/solid-motionone
- solid-motionone `types.ts` (event handlers, Options augmentation): https://github.com/solidjs-community/solid-motionone/blob/main/src/types.ts
- solid-motionone npm: https://www.npmjs.com/package/solid-motionone
- Spring-not-supported issue: https://github.com/solidjs-community/solid-motionone/issues/6
- solid-styled-components interop bug: https://github.com/solidjs-community/solid-motionone/issues/5
- "Animating SolidJS apps with Motion One" (LogRocket): https://blog.logrocket.com/animating-solidjs-apps-motion-one/
- Motion (formerly Motion One) docs — concepts (gestures, inView, spring, layout) that solid-motionone wraps: https://motion.dev/, https://motion.dev/docs/hover, https://motion.dev/docs/inview, https://motion.dev/docs/spring, https://motion.dev/docs/react-layout-animations
- `prefers-reduced-motion` (MDN): https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion
- WCAG C39 technique (prevent motion): https://www.w3.org/WAI/WCAG22/Techniques/css/C39

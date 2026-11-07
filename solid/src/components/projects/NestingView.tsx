// A nested sheet drawn to scale: the sheet, its unused edge and every blank, colored by
// part, with its number when it fits. SVG: a few dozen rectangles (CLAUDE.md, rule 1).
import { type JSX, For, Show } from 'solid-js'

import type { NestSheet, Placement } from '../../lib/nesting'

const COLORS = ['#3b82f6', '#f59e0b', '#10b981', '#ef4444', '#8b5cf6', '#06b6d4', '#ec4899', '#84cc16', '#f97316', '#64748b']

export function colorOf(ids: string[], id: string): string {
  return COLORS[Math.max(0, ids.indexOf(id)) % COLORS.length]!
}

const inch = (v: number) => String(+v.toFixed(3)).replace(/^0\./, '.')

export function NestingView(props: {
  sheet: NestSheet
  placements: Placement[]
  /** Part ids in legend order, for the colors. */
  ids: string[]
  title?: string
  class?: string
}): JSX.Element {
  // Drawn with the long side across.
  const across = () => props.sheet.length >= props.sheet.width
  const W = () => (across() ? props.sheet.length : props.sheet.width)
  const H = () => (across() ? props.sheet.width : props.sheet.length)
  const pos = (p: Placement) => (across() ? { x: p.y, y: p.x, w: p.h, h: p.w } : { x: p.x, y: p.y, w: p.w, h: p.h })
  return (
    <figure class={props.class}>
      <Show when={props.title}>
        <figcaption class="mb-1 text-xs text-muted-foreground">{props.title}</figcaption>
      </Show>
      <svg
        viewBox={`-0.5 -0.5 ${W() + 1} ${H() + 1}`}
        class="h-auto w-full rounded-md bg-muted/40"
        role="img"
        aria-label={`Placa de ${inch(props.sheet.width)} × ${inch(props.sheet.length)} con ${props.placements.length} piezas`}
      >
        <rect x="0" y="0" width={W()} height={H()} fill="none" stroke="currentColor" stroke-width="0.08" class="text-muted-foreground" />
        <Show when={props.sheet.margin > 0}>
          <rect
            x={props.sheet.margin}
            y={props.sheet.margin}
            width={W() - 2 * props.sheet.margin}
            height={H() - 2 * props.sheet.margin}
            fill="none"
            stroke="currentColor"
            stroke-width="0.04"
            stroke-dasharray="0.3 0.2"
            class="text-muted-foreground"
          />
        </Show>
        <For each={props.placements}>
          {(p) => {
            const r = pos(p)
            const color = colorOf(props.ids, p.id)
            const size = Math.min(r.w, r.h)
            return (
              <g>
                <title>{`${p.label}: ${inch(p.w)}" × ${inch(p.h)}"${p.rotated ? ' (girada)' : ''}`}</title>
                <rect x={r.x} y={r.y} width={r.w} height={r.h} fill={color} fill-opacity="0.35" stroke={color} stroke-width="0.05" />
                <Show when={size >= 0.6}>
                  <text
                    x={r.x + r.w / 2}
                    y={r.y + r.h / 2}
                    font-size={Math.min(0.5, size / 3)}
                    text-anchor="middle"
                    dominant-baseline="middle"
                    fill="currentColor"
                    class="text-foreground"
                  >
                    {`${inch(p.w)}×${inch(p.h)}`}
                  </text>
                </Show>
              </g>
            )
          }}
        </For>
      </svg>
    </figure>
  )
}

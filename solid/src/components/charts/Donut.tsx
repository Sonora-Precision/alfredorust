// Donut chart with a centered total. Ported 1:1 from
// frontend/src/pages/charts.rs's `donut` (144×144, r=54, stroke 20).
import type { JSX } from 'solid-js'
import { For, createMemo } from 'solid-js'

export interface DonutSegment {
  label: string
  value: number
  color: string
}

interface DonutProps {
  segments: DonutSegment[]
  centerValue: string
  centerLabel: string
  class?: string
}

export function Donut(props: DonutProps): JSX.Element {
  const cx = 72
  const cy = 72
  const r = 54
  const sw = 20
  const circ = 2 * Math.PI * r

  const arcs = createMemo(() => {
    const total = Math.max(1, props.segments.reduce((sum, s) => sum + s.value, 0))
    let cum = 0
    const out: { color: string; dash: number; gap: number; rot: number }[] = []
    for (const seg of props.segments) {
      if (seg.value <= 0) continue
      const frac = seg.value / total
      const dash = frac * circ
      const rot = (cum / total) * 360 - 90
      cum += seg.value
      out.push({ color: seg.color, dash, gap: circ - dash, rot })
    }
    return out
  })

  return (
    <svg viewBox="0 0 144 144" class={props.class} style={{ width: '100%', height: '100%' }}>
      <circle cx={cx} cy={cy} r={r} fill="none" stroke="currentColor" stroke-opacity="0.12" stroke-width={sw} />
      <For each={arcs()}>
        {(arc) => (
          <circle
            cx={cx}
            cy={cy}
            r={r}
            fill="none"
            stroke={arc.color}
            stroke-width={sw}
            stroke-dasharray={`${arc.dash.toFixed(2)} ${arc.gap.toFixed(2)}`}
            transform={`rotate(${arc.rot.toFixed(2)} ${cx} ${cy})`}
          />
        )}
      </For>
      <text x={cx} y={cy - 7} text-anchor="middle" style={{ 'font-size': '18px', 'font-weight': '700', fill: 'currentColor' }}>
        {props.centerValue}
      </text>
      <text x={cx} y={cy + 12} text-anchor="middle" style={{ 'font-size': '10px', fill: '#94a3b8' }}>
        {props.centerLabel}
      </text>
    </svg>
  )
}

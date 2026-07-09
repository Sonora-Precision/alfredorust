// Income (green) vs expense (rose) area+line chart over labeled buckets.
// Ported 1:1 from frontend/src/pages/charts.rs's `line_area_chart`
// (W=560, H=130).
import type { JSX } from 'solid-js'
import { For, Show, createMemo } from 'solid-js'

import { useAxeMax } from '../../lib/axe-preview'

export interface LineAreaPoint {
  label: string
  income: number
  expense: number
}

interface LineAreaProps {
  data: LineAreaPoint[]
  class?: string
}

export function LineArea(props: LineAreaProps): JSX.Element {
  const chart = createMemo(() => {
    const data = props.data
    if (data.length === 0) return null

    const w = 560
    const h = 130
    const pb = 28
    const max = Math.max(1, ...data.flatMap((d) => [d.income, d.expense]))
    const n = data.length
    const xstep = n > 1 ? w / (n - 1) : w
    const xof = (i: number) => i * xstep
    const yof = (v: number) => h - (v / max) * h

    const linePath = (key: 'income' | 'expense') =>
      data
        .map((d, i) => `${i === 0 ? 'M' : 'L'}${xof(i).toFixed(1)},${yof(d[key]).toFixed(1)}`)
        .join(' ')

    const areaPath = (key: 'income' | 'expense') =>
      `${linePath(key)} L${xof(n - 1).toFixed(1)},${yof(0).toFixed(1)} L0,${yof(0).toFixed(1)} Z`

    const every = Math.max(1, Math.ceil(n / 7))
    const grid = [0, 0.5, 1].map((t) => yof(max * t))
    const labels = data
      .map((d, i) => ({ d, i }))
      .filter(({ i }) => i % every === 0 || i === n - 1)
      .map(({ d, i }) => ({
        x: xof(i),
        anchor: (i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle') as 'start' | 'end' | 'middle',
        text: d.label.slice(2) || d.label,
      }))

    return {
      w,
      h,
      pb,
      grid,
      labels,
      areaIncome: areaPath('income'),
      areaExpense: areaPath('expense'),
      lineIncome: linePath('income'),
      lineExpense: linePath('expense'),
    }
  })

  return (
    <Show
      when={chart()}
      fallback={
        <div class="flex h-full items-center justify-center text-sm text-muted-foreground">
          Sin datos
        </div>
      }
    >
      {(c) => (
        <svg viewBox={`0 0 ${c().w} ${c().h + c().pb}`} class={props.class} style={{ width: '100%', height: '100%' }}>
          {/* axe-100 preview: solid backdrop so contrast checkers can measure
              the axis labels (SVG text otherwise has no determinable bg). */}
          <Show when={useAxeMax()()}>
            <rect x="0" y="0" width={c().w} height={c().h + c().pb} fill="hsl(var(--card))" />
          </Show>
          <defs>
            <linearGradient id="chartI" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="#10b981" stop-opacity="0.15" />
              <stop offset="100%" stop-color="#10b981" stop-opacity="0" />
            </linearGradient>
            <linearGradient id="chartE" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="#f43f5e" stop-opacity="0.12" />
              <stop offset="100%" stop-color="#f43f5e" stop-opacity="0" />
            </linearGradient>
          </defs>
          <For each={c().grid}>
            {(y) => (
              <line
                x1="0"
                x2={c().w}
                y1={y.toFixed(1)}
                y2={y.toFixed(1)}
                stroke="currentColor"
                stroke-opacity="0.12"
                stroke-width="1"
              />
            )}
          </For>
          <path d={c().areaExpense} fill="url(#chartE)" />
          <path d={c().areaIncome} fill="url(#chartI)" />
          <path d={c().lineExpense} fill="none" stroke="#f43f5e" stroke-width="2" stroke-linejoin="round" />
          <path d={c().lineIncome} fill="none" stroke="#10b981" stroke-width="2" stroke-linejoin="round" />
          <For each={c().labels}>
            {(l) => (
              <text
                x={l.x.toFixed(1)}
                y={c().h + c().pb - 4}
                text-anchor={l.anchor}
                font-size="10"
                fill="hsl(var(--muted-foreground))"
              >
                {l.text}
              </text>
            )}
          </For>
        </svg>
      )}
    </Show>
  )
}

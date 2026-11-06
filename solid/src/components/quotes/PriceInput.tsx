// Price per kg of one material, saved on blur (Daniel's quoting method: weight × $/kg × multiplier).
import { type JSX, createSignal } from 'solid-js'

import { toast } from '../ui/Toast'

export function PriceInput(props: {
  material: string
  current: number | null
  note: string | null
  busy: boolean
  onSave: (price: number | null) => void
}): JSX.Element {
  const [text, setText] = createSignal(props.current?.toString() ?? '')
  const save = () => {
    const t = text().trim()
    const p = t === '' ? null : Number(t)
    if (p !== null && (!Number.isFinite(p) || p <= 0)) {
      toast.error('Precio inválido', 'Escribe pesos por kg, ej. 250')
      return
    }
    if (p !== props.current) props.onSave(p)
  }
  return (
    <label class="flex items-center gap-2 rounded-lg border border-border px-2 py-1 text-sm" title={props.note ?? undefined}>
      <span class="text-foreground">{props.material}</span>
      <span class="text-muted-foreground">$</span>
      <input
        class="h-8 w-20 rounded border border-border bg-background px-1 text-right tabular-nums"
        inputmode="decimal"
        placeholder="—"
        aria-label={`Precio por kg de ${props.material}`}
        value={text()}
        disabled={props.busy}
        onInput={(e) => setText(e.currentTarget.value)}
        onBlur={save}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      />
      <span class="text-xs text-muted-foreground">/kg</span>
    </label>
  )
}


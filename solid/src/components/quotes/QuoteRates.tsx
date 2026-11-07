// Tarifas — the hourly rates of the time-based suggested price and the fixed exchange rate
// (Daniel, 2026-11-07): machining $1,600 / $100 USD, programming / engineering $1,000 /
// $50 USD, 20 pesos a dollar. Daniel changes them here; the quote's currency picks the rate.
import { createMutation, createQuery, useQueryClient } from '@tanstack/solid-query'
import { type JSX, Show, createEffect, createSignal } from 'solid-js'

import { Button } from '../ui/Button'
import { Card, CardContent } from '../ui/Card'
import { toast } from '../ui/Toast'
import { humanizeError } from '../../lib/api/client'
import * as quotesApi from '../../lib/api/quotes'

type Key = 'machining_rate_mxn' | 'machining_rate_usd' | 'engineering_rate_mxn' | 'engineering_rate_usd' | 'usd_mxn'
const FIELDS: { key: Key; label: string; fallback: number }[] = [
  { key: 'machining_rate_mxn', label: 'Maquinado MXN / h', fallback: 1600 },
  { key: 'machining_rate_usd', label: 'Maquinado USD / h', fallback: 100 },
  { key: 'engineering_rate_mxn', label: 'Programación MXN / h', fallback: 1000 },
  { key: 'engineering_rate_usd', label: 'Programación USD / h', fallback: 50 },
  { key: 'usd_mxn', label: 'Tipo de cambio (pesos por dólar)', fallback: 20 },
]
/** The saved value, or the agreed default when the settings do not have it yet. */
const rateOf = (s: quotesApi.QuoteSettings, f: (typeof FIELDS)[number]) => (s[f.key] as number | undefined) ?? f.fallback

export function QuoteRates(): JSX.Element {
  const qc = useQueryClient()
  const settings = createQuery(() => ({ queryKey: ['quote-settings'], queryFn: quotesApi.getQuoteSettings }))
  const [values, setValues] = createSignal<Record<Key, string>>({
    machining_rate_mxn: '', machining_rate_usd: '', engineering_rate_mxn: '', engineering_rate_usd: '', usd_mxn: '',
  })
  createEffect(() => {
    const s = settings.data
    if (!s) return
    setValues(Object.fromEntries(FIELDS.map((f) => [f.key, String(rateOf(s, f))])) as Record<Key, string>)
  })
  const dirty = () => !!settings.data && FIELDS.some((f) => Number(values()[f.key]) !== rateOf(settings.data!, f))

  const save = createMutation(() => ({
    // The settings are saved whole: company data, taxes and logo stay as they are.
    mutationFn: () => {
      const v = values()
      return quotesApi.saveQuoteSettings({
        ...settings.data!,
        machining_rate_mxn: Number(v.machining_rate_mxn),
        machining_rate_usd: Number(v.machining_rate_usd),
        engineering_rate_mxn: Number(v.engineering_rate_mxn),
        engineering_rate_usd: Number(v.engineering_rate_usd),
        usd_mxn: Number(v.usd_mxn),
      })
    },
    onSuccess: () => {
      toast.success('Tarifas guardadas')
      void qc.invalidateQueries({ queryKey: ['quote-settings'] })
      void qc.invalidateQueries({ queryKey: ['quote-suggest'] })
    },
    onError: (err) => toast.error('No se pudieron guardar', humanizeError(err, 'Revisa las tarifas')),
  }))
  const submit = () => {
    if (FIELDS.some((f) => !(Number(values()[f.key]) > 0))) return toast.error('Revisa las tarifas', 'Cada una debe ser mayor a 0')
    save.mutate()
  }

  const field = 'h-9 w-full rounded-lg border border-border bg-background px-2 text-right text-sm tabular-nums text-foreground'
  return (
    <Card glass glow={false}>
      <CardContent class="space-y-3 p-4">
        <div class="flex flex-wrap items-baseline justify-between gap-2">
          <p class="text-sm font-semibold text-foreground">Tarifas para el sugerido por tiempo</p>
          <p class="text-xs text-muted-foreground">
            La moneda de la cotización escoge la tarifa. El material (en pesos) se convierte con el tipo de cambio.
          </p>
        </div>
        <Show when={settings.data} fallback={<p class="text-sm text-muted-foreground">Cargando…</p>}>
          <div class="grid gap-2 sm:grid-cols-5">
            {FIELDS.map((f) => (
              <label class="space-y-1 text-xs text-muted-foreground">
                {f.label}
                <input
                  class={field}
                  inputmode="decimal"
                  value={values()[f.key]}
                  onInput={(e) => setValues({ ...values(), [f.key]: e.currentTarget.value })}
                />
              </label>
            ))}
          </div>
          <Show when={dirty()}>
            <div class="flex justify-end">
              <Button disabled={save.isPending} onClick={submit}>
                {save.isPending ? 'Guardando…' : 'Guardar tarifas'}
              </Button>
            </div>
          </Show>
        </Show>
      </CardContent>
    </Card>
  )
}

// Inicio — landing reference page (design-approval gate #1). Faithful core:
// frontend/src/pages/dashboard.rs only renders a "Compañías" tenant-switch
// list from `Me` context — no API calls, no KPIs. That's preserved below
// ("Compañías" card). On top of it we surface the KPI/trend summary the spec
// calls for, computed client-side from the same transactions+accounts data
// the (not-yet-ported) Transactions page will use — same shape as
// `tx_charts` in frontend/src/pages/transactions.rs, ported to a Dashboard
// landing view. See docs/solid-migration/pages-part1.md "Dashboard" +
// "TransactionsPage".
import { createQuery } from '@tanstack/solid-query'
import { Landmark, Scale, TrendingDown, TrendingUp, Wallet } from 'lucide-solid'
import { Motion } from 'solid-motionone'
import { type JSX, Show, createMemo } from 'solid-js'

import { Donut } from '../components/charts/Donut'
import { LineArea } from '../components/charts/LineArea'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/Card'
import { Spinner } from '../components/ui/Spinner'
import * as financeApi from '../lib/api/finance'
import { money } from '../lib/format'
import { switchCompanyHref } from '../lib/tenant'
import { createCountUp, prefersReducedMotion } from '../lib/motion'
import { useAuth } from '../lib/auth/AuthContext'

interface KpiCardProps {
  label: string
  value: string
  icon: (props: { class?: string }) => JSX.Element
  tone: 'success' | 'danger' | 'primary' | 'neutral'
  /** Stagger offset (seconds) so the 4 KPI cards read left-to-right on mount. */
  delay?: number
}

const TONE_CLASSES: Record<KpiCardProps['tone'], string> = {
  success: 'bg-emerald-500/15 text-emerald-600',
  danger: 'bg-rose-500/15 text-rose-600',
  primary: 'bg-primary/15 text-primary',
  neutral: 'bg-muted text-muted-foreground',
}

function KpiCard(props: KpiCardProps): JSX.Element {
  const reduced = prefersReducedMotion()
  return (
    <Motion.div
      initial={reduced ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: reduced ? 0 : 0.32, delay: reduced ? 0 : (props.delay ?? 0), easing: 'ease-out' }}
    >
      <Card>
        <CardContent class="flex items-center gap-4 p-5">
          <div class={`flex h-11 w-11 shrink-0 items-center justify-center rounded-lg ${TONE_CLASSES[props.tone]}`}>
            <props.icon class="h-5 w-5" />
          </div>
          <div class="min-w-0">
            <p class="truncate text-sm text-muted-foreground">{props.label}</p>
            <p class="truncate text-xl font-semibold tabular-nums text-foreground">{props.value}</p>
          </div>
        </CardContent>
      </Card>
    </Motion.div>
  )
}

export default function Dashboard(): JSX.Element {
  const auth = useAuth()

  const accountsQuery = createQuery(() => ({
    queryKey: ['accounts'],
    queryFn: financeApi.listAccounts,
  }))
  const transactionsQuery = createQuery(() => ({
    queryKey: ['transactions'],
    queryFn: financeApi.listTransactions,
  }))

  const isLoading = () => accountsQuery.isLoading || transactionsQuery.isLoading
  const hasData = () => (transactionsQuery.data?.length ?? 0) > 0

  const totals = createMemo(() => {
    const data = transactionsQuery.data ?? []
    let income = 0
    let expense = 0
    for (const tx of data) {
      if (tx.tx_type === 'income') income += tx.amount
      else if (tx.tx_type === 'expense') expense += tx.amount
    }
    return { income, expense, net: income - expense }
  })

  const activeAccounts = createMemo(() => (accountsQuery.data ?? []).filter((a) => a.is_active).length)

  // Count-up tweens for the KPI row — reinforces "a number changed" on load
  // and on any later refetch, doubling as a subtle correctness signal.
  const incomeCountUp = createCountUp(() => totals().income)
  const expenseCountUp = createCountUp(() => totals().expense)
  const netCountUp = createCountUp(() => totals().net)
  const activeAccountsCountUp = createCountUp(() => activeAccounts())

  const monthly = createMemo(() => {
    const buckets = new Map<string, { income: number; expense: number }>()
    for (const tx of transactionsQuery.data ?? []) {
      if (tx.tx_type !== 'income' && tx.tx_type !== 'expense') continue
      const key = tx.date.slice(0, 7) || 'N/A'
      const bucket = buckets.get(key) ?? { income: 0, expense: 0 }
      if (tx.tx_type === 'income') bucket.income += tx.amount
      else bucket.expense += tx.amount
      buckets.set(key, bucket)
    }
    return [...buckets.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([label, v]) => ({ label, income: v.income, expense: v.expense }))
  })

  const companies = createMemo(() => auth.companies())

  return (
    <div class="space-y-6">
      <div>
        <h1 class="text-xl font-semibold text-foreground">Inicio</h1>
        <p class="mt-1 text-sm text-muted-foreground">
          Hola, <span class="font-medium text-foreground">{auth.user()}</span> — {auth.company()}
        </p>
      </div>

      <Show
        when={!isLoading()}
        fallback={
          <div class="flex items-center justify-center gap-2 py-16 text-muted-foreground">
            <Spinner />
            <span>Cargando…</span>
          </div>
        }
      >
        {/* KPI row — cards stagger in on mount, values count up via
            createCountUp (both gated on prefersReducedMotion()). */}
        <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <KpiCard label="Ingresos" value={money(incomeCountUp())} icon={TrendingUp} tone="success" delay={0} />
          <KpiCard label="Egresos" value={money(expenseCountUp())} icon={TrendingDown} tone="danger" delay={0.06} />
          <KpiCard
            label="Neto"
            value={money(netCountUp())}
            icon={Scale}
            tone={totals().net >= 0 ? 'primary' : 'danger'}
            delay={0.12}
          />
          <KpiCard
            label="Cuentas activas"
            value={String(Math.round(activeAccountsCountUp()))}
            icon={Wallet}
            tone="neutral"
            delay={0.18}
          />
        </div>

        {/* Charts */}
        <Show
          when={hasData()}
          fallback={
            <Card>
              <CardContent class="flex flex-col items-center gap-3 py-16 text-center">
                <Landmark class="h-8 w-8 text-muted-foreground" />
                <p class="text-sm text-muted-foreground">Sin movimientos todavía — el resumen aparecerá aquí.</p>
              </CardContent>
            </Card>
          }
        >
          <div class="grid gap-4 lg:grid-cols-3">
            <Card class="lg:col-span-2">
              <CardHeader>
                <CardTitle class="text-base">Ingresos vs. egresos</CardTitle>
              </CardHeader>
              <CardContent class="h-56">
                <LineArea data={monthly()} class="h-full w-full text-muted-foreground" />
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle class="text-base">Composición</CardTitle>
              </CardHeader>
              <CardContent class="flex items-center justify-center">
                <div class="h-40 w-40">
                  <Donut
                    segments={[
                      { label: 'Ingresos', value: totals().income, color: '#10b981' },
                      { label: 'Egresos', value: totals().expense, color: '#f43f5e' },
                    ]}
                    centerValue={money(totals().net)}
                    centerLabel="Neto"
                    class="text-foreground"
                  />
                </div>
              </CardContent>
            </Card>
          </div>
        </Show>
      </Show>

      {/* Faithful core behavior of dashboard.rs: tenant-switch list. */}
      <Card>
        <CardHeader>
          <CardTitle class="text-base">Compañías</CardTitle>
        </CardHeader>
        <CardContent>
          <ul class="space-y-1">
            {companies().map((c) => (
              <li>
                <a
                  href={switchCompanyHref(c.slug)}
                  class={
                    c.active
                      ? 'font-semibold text-foreground'
                      : 'text-muted-foreground transition-colors hover:text-foreground hover:underline'
                  }
                >
                  {c.name}
                  {c.active ? ' (activa)' : ''}
                </a>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  )
}

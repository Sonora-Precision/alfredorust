// DELETABLE — design-approval gate for Dashboard + Accounts (Fase A, GATE A
// in docs/solid-migration/PROGRESS.md). Public route `/preview/design`
// (registered in App.tsx), no backend required: installs a `window.fetch`
// mock (see mockFetch.ts) answering `/api/me` + the accounts/transactions
// endpoints with realistic sample data, then drives the REAL AuthContext
// (`auth.refresh()`) and the REAL solid-query cache so Dashboard.tsx and
// Accounts.tsx render completely unmodified, full CRUD included.
//
// To remove after design approval: delete this whole `src/preview/` folder
// and the one `<Route path="/preview/design" .../>` line in App.tsx.
import { useQueryClient } from '@tanstack/solid-query'
import { type JSX, Show, createSignal, onCleanup, onMount } from 'solid-js'

import { AppShell } from '../components/layout/AppShell'
import { Tabs } from '../components/ui/Tabs'
import { useAuth } from '../lib/auth/AuthContext'
import Accounts from '../pages/Accounts'
import Dashboard from '../pages/Dashboard'
import { installMockFetch, uninstallMockFetch } from './mockFetch'
import { SAMPLE_ACCOUNTS, SAMPLE_TRANSACTIONS, toListRow } from './sampleData'

export default function DesignPreview(): JSX.Element {
  const auth = useAuth()
  const qc = useQueryClient()
  const [ready, setReady] = createSignal(false)
  const params = new URLSearchParams(window.location.search)
  const [tab, setTab] = createSignal(params.get('tab') === 'accounts' ? 'accounts' : 'dashboard')

  onMount(() => {
    // Screenshot helper: force theme via ?theme=light|dark (preview-only).
    const t = params.get('theme')
    if (t === 'light') document.documentElement.setAttribute('data-theme', 'light')
    else if (t === 'dark') document.documentElement.removeAttribute('data-theme')
    installMockFetch()
    // Instant paint: seed the cache directly too, so there's no loading
    // flash even before the (now-mocked) fetch round-trip resolves.
    qc.setQueryData(['accounts'], SAMPLE_ACCOUNTS.map(toListRow))
    qc.setQueryData(['transactions'], SAMPLE_TRANSACTIONS)
    // Re-run the auth bootstrap now that /api/me is mocked, so useAuth()
    // reflects the sample admin/company everywhere (Sidebar, Topbar, both
    // pages) exactly like a real logged-in session would.
    void auth.refresh().then(() => setReady(true))
  })

  onCleanup(() => {
    uninstallMockFetch()
    void auth.refresh()
  })

  return (
    <Show
      when={ready()}
      fallback={
        <div class="flex min-h-screen items-center justify-center text-muted-foreground">Cargando preview…</div>
      }
    >
      <AppShell>
        <div class="mb-4 rounded-md border border-dashed border-amber-500/40 bg-amber-500/10 px-4 py-2 text-xs text-amber-600">
          Vista previa de diseño — datos de ejemplo, sin backend. Esta ruta (/preview/design) y src/preview/ son
          temporales: se eliminan tras la aprobación de look (GATE A).
        </div>
        <Tabs
          value={tab()}
          onChange={setTab}
          items={[
            { value: 'dashboard', label: 'Dashboard', content: <Dashboard /> },
            { value: 'accounts', label: 'Cuentas', content: <Accounts /> },
          ]}
        />
      </AppShell>
    </Show>
  )
}

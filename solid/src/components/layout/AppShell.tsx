// Authed layout shell: the fixed animated SpaceBackground (z-0) + fixed
// Sidebar, with the content column (`.app-shell`) padded to clear the sidebar
// — its padding tracks the collapse signal, and drops to 0 on mobile (CSS in
// styles/app-theme.css). The routed <main> is centered at max-w-[1400px] and
// keeps the ~160ms page cross-fade. CommandPalette mounts once, globally.
import { ErrorBoundary, Suspense, type JSX, type ParentProps } from 'solid-js'
import { Transition } from 'solid-transition-group'

import { useSidebarCollapsed } from '../../lib/layout'
import { Button } from '../ui/Button'
import { Spinner } from '../ui/Spinner'
import { CommandPalette } from './CommandPalette'
import { DemoBanner } from './DemoBanner'
import { Sidebar } from './Sidebar'
import { SpaceBackground } from './SpaceBackground'
import { Topbar } from './Topbar'

export function AppShell(props: ParentProps): JSX.Element {
  const collapsed = useSidebarCollapsed()
  return (
    <div class="min-h-screen">
      <SpaceBackground />
      <Sidebar />
      <div class="app-shell relative z-10 flex min-h-screen flex-col" classList={{ 'sidebar-collapsed': collapsed() }}>
        <DemoBanner />
        <Topbar />
        <main class="mx-auto w-full min-w-0 max-w-[1400px] flex-1 px-4 py-6 sm:px-6">
          {/* Never blank the content column: chunk-load failures already
              hard-reload (lazyWithReload); this catches any other runtime error
              with a friendly retry/reload, and Suspense shows a spinner while a
              route's chunk streams in — the shell (sidebar/topbar) stays put. */}
          <ErrorBoundary
            fallback={(err, reset) => (
              <div class="mx-auto max-w-md py-20 text-center">
                <p class="text-lg font-semibold">Algo salió mal al cargar esta página</p>
                <p class="mt-1 break-words text-sm text-muted-foreground">
                  {String((err as Error)?.message ?? err)}
                </p>
                <div class="mt-4 flex justify-center gap-2">
                  <Button variant="outline" onClick={reset}>
                    Reintentar
                  </Button>
                  <Button onClick={() => window.location.reload()}>Recargar</Button>
                </div>
              </div>
            )}
          >
            <Suspense
              fallback={
                <div class="flex justify-center py-24 text-muted-foreground">
                  <Spinner />
                </div>
              }
            >
              <Transition name="page" mode="outin">
                {props.children}
              </Transition>
            </Suspense>
          </ErrorBoundary>
        </main>
      </div>
      <CommandPalette />
    </div>
  )
}

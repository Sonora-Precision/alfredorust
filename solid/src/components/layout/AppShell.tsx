// Ported 1:1 from frontend/src/app.rs's `AuthedApp` layout shell: fixed-width
// Sidebar + flexible right column (Topbar + routed <main>). `min-w-0` is
// deliberate on both the content column and <main> to stop flex-item overflow
// from wide table content.
import type { JSX, ParentProps } from 'solid-js'
import { Transition } from 'solid-transition-group'

import { Sidebar } from './Sidebar'
import { Topbar } from './Topbar'

export function AppShell(props: ParentProps): JSX.Element {
  return (
    <div class="flex min-h-screen">
      <Sidebar />
      <div class="flex min-w-0 flex-1 flex-col">
        <Topbar />
        {/* Quick cross-fade between routed sections (mode="outin" so the old
            page fully fades out before the new one fades in — see
            .page-enter-active/.page-exit-active in index.css, ~160ms). */}
        <main class="min-w-0 flex-1 p-6">
          <Transition name="page" mode="outin">
            {props.children}
          </Transition>
        </main>
      </div>
    </div>
  )
}

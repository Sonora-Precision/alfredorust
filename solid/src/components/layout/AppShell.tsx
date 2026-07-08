// Authed layout shell: the fixed animated SpaceBackground (z-0) + fixed
// Sidebar, with the content column (`.app-shell`) padded to clear the sidebar
// — its padding tracks the collapse signal, and drops to 0 on mobile (CSS in
// styles/app-theme.css). The routed <main> is centered at max-w-[1400px] and
// keeps the ~160ms page cross-fade. CommandPalette mounts once, globally.
import type { JSX, ParentProps } from 'solid-js'
import { Transition } from 'solid-transition-group'

import { useSidebarCollapsed } from '../../lib/layout'
import { CommandPalette } from './CommandPalette'
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
        <Topbar />
        <main class="mx-auto w-full min-w-0 max-w-[1400px] flex-1 px-4 py-6 sm:px-6">
          <Transition name="page" mode="outin">
            {props.children}
          </Transition>
        </main>
      </div>
      <CommandPalette />
    </div>
  )
}

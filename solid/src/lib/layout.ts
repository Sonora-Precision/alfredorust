// Shared app-shell UI state (sidebar collapse, mobile nav drawer, command
// palette) as module-level signals, so AppShell / Sidebar / Topbar /
// CommandPalette share one source of truth without prop-drilling. Sidebar
// collapse is persisted; the transient overlays are not.
import { createSignal } from 'solid-js'

const COLLAPSE_KEY = 'alfredodev-sidebar-collapsed'

function store(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

const [sidebarCollapsed, setSidebarCollapsedSignal] = createSignal(store()?.getItem(COLLAPSE_KEY) === '1')

export function useSidebarCollapsed() {
  return sidebarCollapsed
}

export function toggleSidebarCollapsed(): void {
  const next = !sidebarCollapsed()
  store()?.setItem(COLLAPSE_KEY, next ? '1' : '0')
  setSidebarCollapsedSignal(next)
}

const [mobileNavOpen, setMobileNavOpen] = createSignal(false)
export { mobileNavOpen, setMobileNavOpen }

const [cmdkOpen, setCmdkOpen] = createSignal(false)
export { cmdkOpen, setCmdkOpen }

// Fixed "space glass" sidebar: brand, permission-gated nav groups (from
// lib/nav) with an active-item glow, collapse-to-icons, and an off-canvas
// drawer on mobile. Collapse/mobile state is shared via lib/layout so the
// AppShell content column can react to the width change.
import { A, useLocation } from '@solidjs/router'
import { ChevronRight, Landmark, PanelLeftClose, PanelLeftOpen } from 'lucide-solid'
import { For, Show, createSignal, type JSX } from 'solid-js'

import { useAuth } from '../../lib/auth/AuthContext'
import { mobileNavOpen, setMobileNavOpen, toggleSidebarCollapsed, useSidebarCollapsed } from '../../lib/layout'
import {
  NAV,
  canSeeSolo,
  isGroup,
  visibleChildren,
  type NavAuth,
  type NavEntry,
  type NavGroupDef,
  type NavSolo,
} from '../../lib/nav'

function icon(entry: NavEntry): JSX.Element {
  const Icon = entry.icon
  return <Icon class="h-[18px] w-[18px]" />
}

export function Sidebar(): JSX.Element {
  const auth = useAuth()
  const location = useLocation()
  const collapsed = useSidebarCollapsed()
  const navAuth: NavAuth = { role: () => auth.role(), hasPermission: (p) => auth.hasPermission(p) }

  const [manualOpen, setManualOpen] = createSignal<Set<string>>(new Set())
  // Current path (SPA is served at root now) — drives active-group auto-open and
  // current-item highlighting.
  const path = () => location.pathname || '/'
  const isActive = (href: string) => (href === '/' ? path() === '/' : path().startsWith(href))
  const groupOpen = (group: NavGroupDef, children: { href: string }[]) =>
    manualOpen().has(group.id) || children.some((c) => isActive(c.href))
  const toggleGroup = (id: string) =>
    setManualOpen((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  return (
    <>
      <aside
        id="appSidebar"
        classList={{ collapsed: collapsed(), 'mobile-open': mobileNavOpen() }}
        class="bg-glass fixed inset-y-0 left-0 z-30 flex flex-col border-r border-border"
      >
        <div class="flex h-16 shrink-0 items-center gap-2.5 px-3.5">
          <div class="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground shadow-sm">
            <Landmark class="h-5 w-5" />
          </div>
          <div class="sb-label leading-tight">
            <div class="text-[13px] font-semibold">alfredodev</div>
            <div class="text-[11px] text-muted-foreground">Gestión SAT</div>
          </div>
        </div>

        <nav class="flex-1 overflow-y-auto py-2" aria-label="Navegación principal">
          <For each={NAV}>
            {(entry) => (
              <Show
                when={isGroup(entry) ? entry : null}
                fallback={
                  <Show when={canSeeSolo(entry as NavSolo, navAuth)}>
                    <A
                      href={(entry as NavSolo).href}
                      class="sb-item"
                      classList={{ active: isActive((entry as NavSolo).href) }}
                      onClick={() => setMobileNavOpen(false)}
                    >
                      <span class="sb-icon">{icon(entry)}</span>
                      <span class="sb-label">{entry.label}</span>
                    </A>
                  </Show>
                }
              >
                {(group) => {
                  const children = visibleChildren(group(), navAuth)
                  return (
                    <Show when={children.length}>
                      <div>
                        <div
                          class="sb-item"
                          role="button"
                          tabindex="0"
                          aria-expanded={groupOpen(group(), children)}
                          onClick={() => toggleGroup(group().id)}
                        >
                          <span class="sb-icon">{icon(group())}</span>
                          <span class="sb-label">{group().label}</span>
                          <ChevronRight class="sb-chevron h-4 w-4" classList={{ open: groupOpen(group(), children) }} />
                        </div>
                        <div class="sb-children" classList={{ open: groupOpen(group(), children) }}>
                          <For each={children}>
                            {(child) => (
                              <A
                                href={child.href}
                                class="sb-item"
                                classList={{ active: isActive(child.href) }}
                                onClick={() => setMobileNavOpen(false)}
                              >
                                <span class="sb-label">{child.label}</span>
                              </A>
                            )}
                          </For>
                        </div>
                      </div>
                    </Show>
                  )
                }}
              </Show>
            )}
          </For>
        </nav>

        <div class="border-t border-border p-2">
          <button
            type="button"
            class="sb-item w-full"
            onClick={toggleSidebarCollapsed}
            aria-label={collapsed() ? 'Expandir menú' : 'Colapsar menú'}
          >
            <span class="sb-icon">
              {collapsed() ? <PanelLeftOpen class="h-[18px] w-[18px]" /> : <PanelLeftClose class="h-[18px] w-[18px]" />}
            </span>
            <span class="sb-label">Colapsar</span>
          </button>
        </div>
      </aside>

      {/* Mobile scrim */}
      <Show when={mobileNavOpen()}>
        <div class="fixed inset-0 z-20 bg-black/40 md:hidden" onClick={() => setMobileNavOpen(false)} />
      </Show>
    </>
  )
}

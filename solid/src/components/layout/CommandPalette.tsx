// ⌘K / Ctrl+K command palette: jump to any route the user can reach (from
// lib/nav) plus a couple of quick actions. Open state lives in lib/layout so
// the Topbar button and the global keyboard shortcut share it.
import { useNavigate } from '@solidjs/router'
import { ArrowRightCircle, Search } from 'lucide-solid'
import { For, Show, createMemo, createSignal, onCleanup, onMount } from 'solid-js'
import { Portal } from 'solid-js/web'

import { useAuth } from '../../lib/auth/AuthContext'
import { cmdkOpen, setCmdkOpen } from '../../lib/layout'
import { setMotionForced, useMotionForced } from '../../lib/motion'
import { flatRoutes } from '../../lib/nav'
import { toggleTheme } from '../../lib/theme'

interface Entry {
  label: string
  run: () => void
}

export function CommandPalette() {
  const auth = useAuth()
  const navigate = useNavigate()
  const forced = useMotionForced()
  const [query, setQuery] = createSignal('')
  const [selected, setSelected] = createSignal(0)

  const navAuth = { role: () => auth.role(), hasPermission: (p: string) => auth.hasPermission(p) }

  const entries = createMemo<Entry[]>(() => {
    const routes: Entry[] = flatRoutes(navAuth).map((r) => ({
      label: r.group ? `${r.group} → ${r.label}` : r.label,
      run: () => navigate(r.href),
    }))
    const actions: Entry[] = [
      { label: 'Cambiar tema (claro/oscuro)', run: () => toggleTheme() },
      { label: 'Forzar movimiento completo', run: () => setMotionForced(!forced()) },
    ]
    const q = query().trim().toLowerCase()
    const all = [...routes, ...actions]
    return q ? all.filter((e) => e.label.toLowerCase().includes(q)) : all
  })

  const close = () => {
    setCmdkOpen(false)
    setQuery('')
    setSelected(0)
  }
  const run = (entry?: Entry) => {
    if (!entry) return
    close()
    entry.run()
  }

  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setCmdkOpen((open) => !open)
        return
      }
      if (!cmdkOpen()) return
      if (e.key === 'Escape') close()
      else if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelected((s) => Math.min(s + 1, entries().length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelected((s) => Math.max(s - 1, 0))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        run(entries()[selected()])
      }
    }
    document.addEventListener('keydown', onKey)
    onCleanup(() => document.removeEventListener('keydown', onKey))
  })

  return (
    <Show when={cmdkOpen()}>
      <Portal>
        <div class="fixed inset-0 z-[60] flex items-start justify-center p-4 pt-[12vh]" onClick={close}>
          <div class="fade-enter absolute inset-0 bg-black/50 backdrop-blur-[2px]" />
          <div
            class="pop-enter relative w-full max-w-lg overflow-hidden rounded-xl border border-border bg-glass shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div class="flex items-center gap-2 border-b border-border px-3">
              <Search class="h-4 w-4 text-muted-foreground" />
              <input
                ref={(el) => queueMicrotask(() => el.focus())}
                value={query()}
                onInput={(e) => {
                  setQuery(e.currentTarget.value)
                  setSelected(0)
                }}
                placeholder="Buscar página o acción…"
                aria-label="Buscar página o acción"
                class="w-full bg-transparent py-3 text-[13px] outline-none placeholder:text-muted-foreground"
              />
              <kbd class="rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">esc</kbd>
            </div>
            <div class="max-h-[50vh] overflow-y-auto p-1.5">
              <Show
                when={entries().length}
                fallback={<div class="px-3 py-8 text-center text-[13px] text-muted-foreground">Sin resultados</div>}
              >
                <For each={entries()}>
                  {(entry, i) => (
                    <div
                      class="cmdk-item flex cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2.5 text-[13px]"
                      aria-selected={i() === selected()}
                      onMouseMove={() => setSelected(i())}
                      onClick={() => run(entry)}
                    >
                      <ArrowRightCircle class="cmdk-icon h-4 w-4 text-muted-foreground" />
                      {entry.label}
                    </div>
                  )}
                </For>
              </Show>
            </div>
          </div>
        </div>
      </Portal>
    </Show>
  )
}

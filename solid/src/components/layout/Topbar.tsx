// Sticky glass header: mobile menu button + company/user identity on the left;
// ⌘K search, notifications, motion/theme toggles, tenant switcher and logout on
// the right. Navigation itself lives in the Sidebar (+ command palette).
import { useNavigate } from '@solidjs/router'
import { Bell, ChevronDown, Menu, Search } from 'lucide-solid'
import type { JSX } from 'solid-js'

import { useAuth } from '../../lib/auth/AuthContext'
import { setCmdkOpen, setMobileNavOpen } from '../../lib/layout'
import { Badge, roleBadgeTone } from '../ui/Badge'
import { Dropdown } from '../ui/Dropdown'
import { CompanySwitcher } from './CompanySwitcher'
import { EffectsToggle } from './EffectsToggle'
import { ThemeToggle } from './ThemeToggle'

export function Topbar(): JSX.Element {
  const auth = useAuth()
  const navigate = useNavigate()

  const doLogout = async () => {
    await auth.logout()
    navigate('/login')
  }

  const initials = () => (auth.user() ?? '?').trim().slice(0, 2).toUpperCase()

  return (
    <header class="sticky top-0 z-30 border-b border-border bg-background/85 backdrop-blur-xl">
      <div class="mx-auto flex h-16 w-full max-w-[1400px] items-center gap-3 px-4 sm:px-6">
        <button
          type="button"
          class="grid h-9 w-9 place-items-center rounded-lg text-muted-foreground transition hover:bg-muted hover:text-foreground md:hidden"
          aria-label="Abrir menú"
          onClick={() => setMobileNavOpen(true)}
        >
          <Menu class="h-5 w-5" />
        </button>

        <div class="hidden items-center gap-3 sm:flex">
          <div class="leading-tight">
            <p class="text-[13px] font-semibold">{auth.company()}</p>
            <p class="text-[11px] text-muted-foreground">{auth.user()}</p>
          </div>
          <Badge tone={roleBadgeTone(auth.role() ?? '')}>{auth.role()}</Badge>
        </div>

        <div class="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            class="flex items-center gap-2 rounded-lg border border-border bg-glass px-2.5 py-1.5 text-[12px] text-muted-foreground transition hover:border-ring/50"
            aria-label="Buscar (Ctrl+K)"
            onClick={() => setCmdkOpen(true)}
          >
            <Search class="h-4 w-4" />
            <span class="hidden sm:inline">Buscar…</span>
            <kbd class="hidden rounded border border-border px-1.5 py-0.5 font-mono text-[10px] sm:inline">⌘K</kbd>
          </button>
          <button
            type="button"
            class="relative hidden h-9 w-9 place-items-center rounded-lg text-muted-foreground transition hover:bg-muted hover:text-foreground md:grid"
            aria-label="Notificaciones"
          >
            <Bell class="h-[18px] w-[18px]" />
            <span class="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-destructive ring-2 ring-background" />
          </button>
          <EffectsToggle />
          <ThemeToggle />
          <CompanySwitcher />
          <Dropdown
            items={[
              { label: 'Mi cuenta', onSelect: () => navigate('/account') },
              { label: 'Salir', onSelect: doLogout, destructive: true },
            ]}
          >
            <button
              type="button"
              class="flex items-center gap-1.5 rounded-lg px-1.5 py-1 text-muted-foreground transition hover:bg-muted hover:text-foreground"
              aria-label="Cuenta"
            >
              <span class="grid h-7 w-7 place-items-center rounded-full bg-muted text-[11px] font-semibold text-foreground">
                {initials()}
              </span>
              <ChevronDown class="h-4 w-4" />
            </button>
          </Dropdown>
        </div>
      </div>
    </header>
  )
}

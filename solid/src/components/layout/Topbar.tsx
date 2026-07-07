// Ported 1:1 from frontend/src/app.rs's `Topbar`: left = user + company +
// role badge; right = ThemeToggle + CompanySwitcher + logout.
import { useNavigate } from '@solidjs/router'
import type { JSX } from 'solid-js'

import { useAuth } from '../../lib/auth/AuthContext'
import { Badge, roleBadgeTone } from '../ui/Badge'
import { Button } from '../ui/Button'
import { CompanySwitcher } from './CompanySwitcher'
import { ThemeToggle } from './ThemeToggle'

export function Topbar(): JSX.Element {
  const auth = useAuth()
  const navigate = useNavigate()

  const doLogout = async () => {
    await auth.logout()
    navigate('/login')
  }

  return (
    <header class="flex items-center justify-between border-b border-border bg-card px-6 py-3">
      <div class="flex items-center gap-3">
        <div>
          <p class="text-sm text-muted-foreground">{auth.user()}</p>
          <p class="font-semibold">{auth.company()}</p>
        </div>
        <Badge tone={roleBadgeTone(auth.role() ?? '')}>{auth.role()}</Badge>
      </div>
      <div class="flex items-center gap-2">
        <ThemeToggle />
        <CompanySwitcher />
        <Button variant="outline" onClick={doLogout}>
          Salir
        </Button>
      </div>
    </header>
  )
}

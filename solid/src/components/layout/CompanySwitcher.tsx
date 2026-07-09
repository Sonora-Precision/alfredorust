// Tenant switcher: hidden when the user belongs to only one company.
// Switching is a full navigation to the target tenant subdomain (the session
// cookie is shared across subdomains) — ported from frontend/src/app.rs.
import type { JSX } from 'solid-js'
import { Show, For } from 'solid-js'

import { useAuth } from '../../lib/auth/AuthContext'
import { isDemo } from '../../lib/demo/mode'
import { switchCompanyHref } from '../../lib/tenant'
import { toast } from '../ui/Toast'
import { Select } from '../ui/Select'

export function CompanySwitcher(): JSX.Element {
  const auth = useAuth()

  const handleChange = (slug: string) => {
    if (slug === auth.companySlug()) return
    // In the demo, switching tenants would navigate off the sealed demo
    // subdomain into a real (auth-gated) tenant — block it and explain.
    if (isDemo()) {
      toast.info('Demo de solo lectura', 'El cambio de empresa está deshabilitado en la demo.')
      return
    }
    window.location.href = switchCompanyHref(slug)
  }

  return (
    <Show when={auth.companies().length > 1}>
      <div class="w-44">
        <Select
          value={auth.companySlug() ?? ''}
          onChange={handleChange}
          class="py-1.5 text-sm"
          aria-label="Cambiar de compañía"
        >
          <For each={auth.companies()}>{(c) => (
            <option value={c.slug}>{c.name}</option>
          )}</For>
        </Select>
      </div>
    </Show>
  )
}

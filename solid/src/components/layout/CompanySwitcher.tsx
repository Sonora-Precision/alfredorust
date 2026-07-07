// Tenant switcher: hidden when the user belongs to only one company.
// Switching is a full navigation to the target tenant subdomain (the session
// cookie is shared across subdomains) — ported from frontend/src/app.rs.
import type { JSX } from 'solid-js'
import { Show } from 'solid-js'

import { useAuth } from '../../lib/auth/AuthContext'
import { switchCompanyHref } from '../../lib/tenant'
import { Select } from '../ui/Select'

export function CompanySwitcher(): JSX.Element {
  const auth = useAuth()

  const handleChange = (slug: string) => {
    if (slug !== auth.companySlug()) {
      window.location.href = switchCompanyHref(slug)
    }
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
          {auth.companies().map((c) => (
            <option value={c.slug}>{c.name}</option>
          ))}
        </Select>
      </div>
    </Show>
  )
}

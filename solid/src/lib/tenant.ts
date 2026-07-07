// Tenant subdomain helpers. Ported from frontend/src/pages/mod.rs
// (`switch_company_href`). Company switching is a full page navigation, not
// an SPA route change — see docs/solid-migration/PLAN.md §6.
export function switchCompanyHref(slug: string): string {
  const loc = window.location
  const proto = loc.protocol
  const host = loc.host
  const dot = host.indexOf('.')
  const rest = dot >= 0 ? host.slice(dot + 1) : host
  // Land on the SPA (/v3) of the destination tenant.
  return `${proto}//${slug}.${rest}/v3/`
}

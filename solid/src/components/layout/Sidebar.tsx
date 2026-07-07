// Ported 1:1 from frontend/src/app.rs's `Sidebar`: static links (Inicio,
// Tiempo conditional, Mi cuenta) + permission-gated accordion groups
// (Finanzas/Operaciones/Fiscal/Administración for admin; a reduced
// Operaciones-only group for staff with specific permissions).
import { A } from '@solidjs/router'
import type { JSX } from 'solid-js'
import { Show } from 'solid-js'

import { useAuth } from '../../lib/auth/AuthContext'
import { NavGroup } from './NavGroup'

const LINK_CLASS =
  'block rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground aria-[current=page]:bg-muted aria-[current=page]:text-foreground aria-[current=page]:font-semibold'

export function Sidebar(): JSX.Element {
  const auth = useAuth()
  const isAdmin = () => auth.role() === 'admin'
  const canTimeline = () => isAdmin() || auth.hasPermission('view_timeline')
  const canProjects = () => isAdmin() || auth.hasPermission('view_projects')
  const canResourceUsage = () =>
    isAdmin() ||
    auth.hasPermission('edit_resource_usage_today') ||
    auth.hasPermission('view_resource_usage_history')

  return (
    <aside class="w-56 shrink-0 border-r border-border bg-card p-3">
      <p class="px-3 pb-3 text-sm font-semibold text-foreground">alfredodev</p>
      <nav class="space-y-1">
        <A href="/" end class={LINK_CLASS}>
          Inicio
        </A>
        <Show when={canTimeline()}>
          <A href="/tiempo" class={LINK_CLASS}>
            Tiempo
          </A>
        </Show>
        <A href="/account" class={LINK_CLASS}>
          Mi cuenta
        </A>

        {/* Staff see only the operations screens their permissions unlock. */}
        <Show when={!isAdmin() && (canProjects() || canResourceUsage())}>
          <NavGroup title="Operaciones">
            <Show when={canProjects()}>
              <A href="/projects" class={LINK_CLASS}>
                Proyectos
              </A>
            </Show>
            <Show when={canResourceUsage()}>
              <A href="/resource-usages" class={LINK_CLASS}>
                Uso de recursos (grid)
              </A>
            </Show>
          </NavGroup>
        </Show>

        {/* Admins get the full menu. */}
        <Show when={isAdmin()}>
          <NavGroup title="Finanzas">
            <A href="/accounts" class={LINK_CLASS}>
              Cuentas
            </A>
            <A href="/categories" class={LINK_CLASS}>
              Categorías
            </A>
            <A href="/contacts" class={LINK_CLASS}>
              Contactos
            </A>
            <A href="/transactions" class={LINK_CLASS}>
              Movimientos
            </A>
            <A href="/recurring-plans" class={LINK_CLASS}>
              Planes recurrentes
            </A>
            <A href="/planned-entries" class={LINK_CLASS}>
              Entradas planificadas
            </A>
            <A href="/forecasts" class={LINK_CLASS}>
              Pronósticos
            </A>
          </NavGroup>
          <NavGroup title="Operaciones">
            <A href="/orders" class={LINK_CLASS}>
              Órdenes
            </A>
            <A href="/projects" class={LINK_CLASS}>
              Proyectos
            </A>
            <A href="/concept-statuses" class={LINK_CLASS}>
              Estados de concepto
            </A>
            <A href="/resources" class={LINK_CLASS}>
              Recursos
            </A>
            <A href="/resource-logs" class={LINK_CLASS}>
              Registros de recursos
            </A>
            <A href="/resource-usages" class={LINK_CLASS}>
              Uso de recursos (grid)
            </A>
          </NavGroup>
          <NavGroup title="Fiscal">
            <A href="/cfdi" class={LINK_CLASS}>
              CFDIs
            </A>
            <A href="/sat-configs" class={LINK_CLASS}>
              Config. SAT
            </A>
          </NavGroup>
          <NavGroup title="Administración">
            <A href="/companies" class={LINK_CLASS}>
              Compañías
            </A>
            <A href="/users" class={LINK_CLASS}>
              Usuarios
            </A>
          </NavGroup>
        </Show>
      </nav>
    </aside>
  )
}

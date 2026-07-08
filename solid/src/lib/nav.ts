// Central navigation model — the single source of truth for both the Sidebar
// and the CommandPalette. Each entry carries its Lucide icon and an optional
// `can(auth)` gate; groups are shown only when at least one child is visible,
// which reproduces the admin/staff split the old Sidebar hard-coded.
import { Boxes, Clock, Home, Landmark, ShieldCheck, Wallet, type LucideProps } from 'lucide-solid'
import type { Component } from 'solid-js'

export interface NavAuth {
  role(): string | null | undefined
  hasPermission(permission: string): boolean
}

type Gate = (auth: NavAuth) => boolean

export interface NavLeaf {
  href: string
  label: string
  can?: Gate
}

export interface NavSolo {
  id: string
  label: string
  icon: Component<LucideProps>
  href: string
  can?: Gate
}

export interface NavGroupDef {
  id: string
  label: string
  icon: Component<LucideProps>
  can?: Gate
  children: NavLeaf[]
}

export type NavEntry = NavSolo | NavGroupDef

export function isGroup(entry: NavEntry): entry is NavGroupDef {
  return 'children' in entry
}

const admin: Gate = (a) => a.role() === 'admin'
const adminOr =
  (permission: string): Gate =>
  (a) =>
    a.role() === 'admin' || a.hasPermission(permission)
const resourceUsage: Gate = (a) =>
  a.role() === 'admin' ||
  a.hasPermission('edit_resource_usage_today') ||
  a.hasPermission('view_resource_usage_history')

export const NAV: NavEntry[] = [
  { id: 'home', label: 'Inicio', icon: Home, href: '/' },
  { id: 'tiempo', label: 'Tiempo', icon: Clock, href: '/tiempo', can: adminOr('view_timeline') },
  {
    id: 'finanzas',
    label: 'Finanzas',
    icon: Wallet,
    can: admin,
    children: [
      { href: '/accounts', label: 'Cuentas' },
      { href: '/categories', label: 'Categorías' },
      { href: '/contacts', label: 'Contactos' },
      { href: '/transactions', label: 'Movimientos' },
      { href: '/recurring-plans', label: 'Planes recurrentes' },
      { href: '/planned-entries', label: 'Entradas planificadas' },
      { href: '/forecasts', label: 'Pronósticos' },
    ],
  },
  {
    id: 'operaciones',
    label: 'Operaciones',
    icon: Boxes,
    children: [
      { href: '/orders', label: 'Órdenes', can: admin },
      { href: '/projects', label: 'Proyectos', can: adminOr('view_projects') },
      { href: '/concept-statuses', label: 'Estados de concepto', can: admin },
      { href: '/resources', label: 'Recursos', can: admin },
      { href: '/resource-logs', label: 'Registros de recursos', can: admin },
      { href: '/resource-usages', label: 'Uso de recursos (grid)', can: resourceUsage },
    ],
  },
  {
    id: 'fiscal',
    label: 'Fiscal',
    icon: Landmark,
    can: admin,
    children: [
      { href: '/cfdi', label: 'CFDIs' },
      { href: '/sat-configs', label: 'Config. SAT' },
    ],
  },
  {
    id: 'admin',
    label: 'Administración',
    icon: ShieldCheck,
    can: admin,
    children: [
      { href: '/companies', label: 'Compañías' },
      { href: '/users', label: 'Usuarios' },
    ],
  },
]

export function visibleChildren(group: NavGroupDef, auth: NavAuth): NavLeaf[] {
  if (group.can && !group.can(auth)) return []
  return group.children.filter((child) => !child.can || child.can(auth))
}

export function canSeeSolo(solo: NavSolo, auth: NavAuth): boolean {
  return !solo.can || solo.can(auth)
}

export interface FlatRoute {
  href: string
  label: string
  group?: string
}

/** All routes the current user can reach, flattened for the command palette. */
export function flatRoutes(auth: NavAuth): FlatRoute[] {
  const out: FlatRoute[] = []
  for (const entry of NAV) {
    if (isGroup(entry)) {
      for (const child of visibleChildren(entry, auth)) {
        out.push({ href: child.href, label: child.label, group: entry.label })
      }
    } else if (canSeeSolo(entry, auth)) {
      out.push({ href: entry.href, label: entry.label })
    }
  }
  return out
}

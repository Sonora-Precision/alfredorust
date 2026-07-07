// Ported 1:1 from frontend/src/components/badge.rs (classes verbatim) +
// docs/solid-migration/design-system.md tone mapping helpers
// (flow_badge/bool_badge/status_badge/priority_badge/role_badge/type_badge
// from frontend/src/pages/mod.rs).
import { type JSX, type ParentProps, splitProps } from 'solid-js'

import { cn } from '../../lib/cn'

export type BadgeTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info'

const TONE_CLASSES: Record<BadgeTone, string> = {
  neutral: 'bg-muted text-muted-foreground ring-border',
  success: 'bg-emerald-500/15 text-emerald-600 ring-emerald-500/30',
  warning: 'bg-amber-500/15 text-amber-600 ring-amber-500/30',
  danger: 'bg-rose-500/15 text-rose-600 ring-rose-500/30',
  info: 'bg-sky-500/15 text-sky-600 ring-sky-500/30',
}

const BADGE_BASE =
  'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ring-inset whitespace-nowrap'

interface BadgeProps extends ParentProps {
  tone?: BadgeTone
  class?: string
}

export function Badge(props: BadgeProps): JSX.Element {
  const [local, rest] = splitProps(props, ['tone', 'class', 'children'])
  return (
    <span class={cn(BADGE_BASE, TONE_CLASSES[local.tone ?? 'neutral'], local.class)} {...rest}>
      {local.children}
    </span>
  )
}

// --- tone/label helpers, ported from frontend/src/pages/mod.rs -----------------------

/** Income (green) / expense (rose) flow label + tone. */
export function flowBadgeProps(value: string): { tone: BadgeTone; label: string } {
  switch (value) {
    case 'income':
      return { tone: 'success', label: 'Ingreso' }
    case 'expense':
      return { tone: 'danger', label: 'Egreso' }
    default:
      return { tone: 'neutral', label: value }
  }
}

/** Transactions add a 3rd case (transfer) vs. the generic flow badge. */
export function txTypeBadgeTone(value: string): BadgeTone {
  switch (value) {
    case 'income':
      return 'success'
    case 'expense':
      return 'danger'
    case 'transfer':
      return 'info'
    default:
      return 'neutral'
  }
}

/** Boolean flag (active/confirmed/…): true -> success, false -> neutral. */
export function boolBadgeTone(on: boolean): BadgeTone {
  return on ? 'success' : 'neutral'
}

/** Workflow status (planned/order/project): tone inferred from Spanish keywords. */
export function statusBadgeTone(label: string): BadgeTone {
  const l = label.toLowerCase()
  if (l.includes('cancel')) return 'neutral'
  if (l.includes('vencid') || l.includes('atras') || l.includes('overdue')) return 'danger'
  if (l.includes('parcial') || l.includes('partial')) return 'warning'
  if (
    l.includes('cubiert') ||
    l.includes('pagad') ||
    l.includes('complet') ||
    l.includes('termin') ||
    l.includes('cerrad') ||
    l.includes('listo')
  )
    return 'success'
  if (l.includes('plan') || l.includes('pendiente') || l.includes('proceso')) return 'info'
  return 'neutral'
}

/** Project priority: tone from the canonical value. */
export function priorityBadgeTone(value: string): BadgeTone {
  switch (value) {
    case 'high':
    case 'urgent':
      return 'danger'
    case 'medium':
      return 'warning'
    case 'low':
      return 'neutral'
    default:
      return 'info'
  }
}

/** User role: admin highlighted (info), staff neutral. */
export function roleBadgeTone(role: string): BadgeTone {
  return role === 'admin' ? 'info' : 'neutral'
}

/** A non-status classifier (account type, etc.): always a subtle info pill. */
export const typeBadgeTone: BadgeTone = 'info'

// Minimal table primitives (plain HTML + Tailwind, no headless dep needed).
// Conventions follow the rest of the design system: text-sm body, muted
// header text, border-border hairlines.
import type { JSX, ParentProps } from 'solid-js'
import { splitProps } from 'solid-js'

import { cn } from '../../lib/cn'

interface TableProps extends ParentProps {
  class?: string
}

export function Table(props: TableProps): JSX.Element {
  const [local, rest] = splitProps(props, ['class', 'children'])
  return (
    <div class="w-full overflow-x-auto">
      <table class={cn('w-full border-collapse text-sm', local.class)} {...rest}>
        {local.children}
      </table>
    </div>
  )
}

export function TableHead(props: TableProps): JSX.Element {
  const [local, rest] = splitProps(props, ['class', 'children'])
  return (
    <thead class={cn('border-b border-border text-left text-muted-foreground', local.class)} {...rest}>
      {local.children}
    </thead>
  )
}

export function TableBody(props: TableProps): JSX.Element {
  const [local, rest] = splitProps(props, ['class', 'children'])
  return (
    <tbody class={local.class} {...rest}>
      {local.children}
    </tbody>
  )
}

export function TableRow(props: TableProps): JSX.Element {
  const [local, rest] = splitProps(props, ['class', 'children'])
  return (
    <tr class={cn('border-b border-border last:border-0 hover:bg-muted/40', local.class)} {...rest}>
      {local.children}
    </tr>
  )
}

export function TableHeadCell(props: TableProps): JSX.Element {
  const [local, rest] = splitProps(props, ['class', 'children'])
  return (
    <th class={cn('px-3 py-2 text-xs font-semibold uppercase tracking-wide', local.class)} {...rest}>
      {local.children}
    </th>
  )
}

export function TableCell(props: TableProps): JSX.Element {
  const [local, rest] = splitProps(props, ['class', 'children'])
  return (
    <td class={cn('px-3 py-2 align-middle', local.class)} {...rest}>
      {local.children}
    </td>
  )
}

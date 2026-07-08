// Ported 1:1 from frontend/src/components/card.rs (4 sub-parts, no
// CardFooter/CardDescription in this codebase).
import type { JSX, ParentProps } from 'solid-js'
import { splitProps } from 'solid-js'

import { cn } from '../../lib/cn'

interface DivProps extends ParentProps {
  class?: string
}

interface CardProps extends DivProps {
  /** Frosted "space glass" surface (`.card`) instead of the opaque default. */
  glass?: boolean
  /** Cursor-following edge glow (only meaningful with `glass`). */
  glow?: boolean
}

export function Card(props: CardProps): JSX.Element {
  const [local, rest] = splitProps(props, ['class', 'children', 'glass', 'glow'])
  return (
    <div
      class={cn(
        local.glass
          ? 'card rounded-xl text-card-foreground'
          : 'rounded-xl border border-border bg-card text-card-foreground shadow-sm',
        local.glow && 'glow-edge',
        local.class,
      )}
      {...rest}
    >
      {local.children}
    </div>
  )
}

export function CardHeader(props: DivProps): JSX.Element {
  const [local, rest] = splitProps(props, ['class', 'children'])
  return (
    <div class={cn('flex flex-col space-y-1.5 p-6', local.class)} {...rest}>
      {local.children}
    </div>
  )
}

export function CardTitle(props: DivProps): JSX.Element {
  const [local, rest] = splitProps(props, ['class', 'children'])
  return (
    <h3 class={cn('text-lg font-semibold leading-none tracking-tight', local.class)} {...rest}>
      {local.children}
    </h3>
  )
}

export function CardContent(props: DivProps): JSX.Element {
  const [local, rest] = splitProps(props, ['class', 'children'])
  return (
    <div class={cn('p-6 pt-0', local.class)} {...rest}>
      {local.children}
    </div>
  )
}

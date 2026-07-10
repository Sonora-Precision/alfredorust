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
  /**
   * Cursor-following edge glow (only meaningful with `glass`). Defaults to ON
   * for glass cards so the look is uniform across the app; pass `glow={false}`
   * to opt a specific card out.
   */
  glow?: boolean
}

export function Card(props: CardProps): JSX.Element {
  const [local, rest] = splitProps(props, ['class', 'children', 'glass', 'glow'])
  // Glow defaults to the card's glass state when not explicitly set.
  const showGlow = () => (local.glow ?? local.glass) === true
  return (
    <div
      class={cn(
        local.glass
          ? 'card rounded-xl text-card-foreground'
          : 'rounded-xl border border-border bg-card text-card-foreground shadow-sm',
        showGlow() && 'glow-edge',
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
    <h2 class={cn('text-lg font-semibold leading-none tracking-tight', local.class)} {...rest}>
      {local.children}
    </h2>
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

// The project's main assembly at a glance (Daniel, 2026-11-19): a small image beside the title
// that tells one project from another, and the assembly drawing large on hover, like in
// Seguimiento. Without an image it is a neutral box. No prices: anyone who sees projects.
import { Box } from 'lucide-solid'
import { type JSX, Show } from 'solid-js'

import { DrawingHover } from './DrawingHover'

export function ProjectThumb(props: {
  previewUrl?: string | null
  assemblyUrl?: string | null
  title: string
  size?: 'sm' | 'lg'
}): JSX.Element {
  const box = () => (props.size === 'lg' ? 'h-24 w-32' : 'h-10 w-14')
  return (
    <DrawingHover url={props.assemblyUrl ?? undefined} label={props.title} class="inline-block shrink-0 align-middle">
      <Show
        when={props.previewUrl}
        fallback={
          <span
            class={`${box()} flex items-center justify-center rounded border border-dashed border-border bg-muted/40 text-muted-foreground`}
            title={props.assemblyUrl ? 'Sin vista previa: pasa el mouse para ver el plano' : 'Sin vista previa'}
          >
            <Box class={props.size === 'lg' ? 'h-6 w-6' : 'h-4 w-4'} />
          </span>
        }
      >
        {(url) => (
          <img
            src={url()}
            alt={`Vista previa de ${props.title}`}
            loading="lazy"
            class={`${box()} rounded border border-border bg-white object-contain`}
          />
        )}
      </Show>
    </DrawingHover>
  )
}

// Slim top banner shown only in demo mode (demo.alfredorivera.dev). Makes it
// unmistakable that the data is fake and read-only, and offers a sales CTA.
import { Rocket } from 'lucide-solid'
import { Show, type JSX } from 'solid-js'

import { isDemo } from '../../lib/demo/mode'

export function DemoBanner(): JSX.Element {
  return (
    <Show when={isDemo()}>
      <div class="relative z-20 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 border-b border-border bg-primary/10 px-4 py-1.5 text-center text-[12px] backdrop-blur">
        <span class="inline-flex items-center gap-1.5 font-medium text-foreground">
          <Rocket class="h-3.5 w-3.5 text-primary" />
          Demo interactiva
        </span>
        <span class="text-muted-foreground">
          Datos de ejemplo — explora libremente; los cambios no se guardan.
        </span>
        <a
          href="https://alfredorivera.dev"
          class="font-medium text-primary underline-offset-2 hover:underline"
        >
          Solicita acceso →
        </a>
      </div>
    </Show>
  )
}

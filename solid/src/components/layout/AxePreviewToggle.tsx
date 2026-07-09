// Toggle between the current translucent glass look and an "Axe 100%" opaque
// variant, so you can compare live how much the design changes when surfaces are
// made measurable for automated contrast checkers.
import { Contrast } from 'lucide-solid'

import { setAxeMax, useAxeMax } from '../../lib/axe-preview'

export function AxePreviewToggle() {
  const on = useAxeMax()
  return (
    <button
      type="button"
      class="grid h-9 w-9 place-items-center rounded-lg text-muted-foreground transition hover:bg-muted hover:text-foreground aria-pressed:text-primary"
      aria-pressed={on()}
      aria-label="Comparar vista Axe 100% (superficies opacas)"
      title={
        on()
          ? 'Modo Axe 100% activo (superficies opacas) — clic para volver al vidrio'
          : 'Ver modo Axe 100% (opaco) para comparar el contraste'
      }
      onClick={() => setAxeMax(!on())}
    >
      <Contrast class="h-[18px] w-[18px]" />
    </button>
  )
}

// Single "visual effects" toggle (merges the old ⚡ motion + ◐ axe toggles).
// Pressed (default) = full space-glass experience: translucent glass, starfield,
// animations. Un-press it for calm mode (opaque surfaces, no starfield, no
// motion) — friendlier for contrast, motion sensitivity and low-power devices.
import { Sparkles } from 'lucide-solid'

import { setEffects, useEffects } from '../../lib/effects'

export function EffectsToggle() {
  const on = useEffects()
  return (
    <button
      type="button"
      class="grid h-9 w-9 place-items-center rounded-lg text-muted-foreground transition hover:bg-muted hover:text-foreground aria-pressed:text-primary"
      aria-pressed={on()}
      aria-label="Efectos visuales"
      title={
        on()
          ? 'Efectos visuales activos (vidrio + animaciones) — clic para modo calmado'
          : 'Modo calmado (opaco, sin animaciones) — clic para activar efectos'
      }
      onClick={() => setEffects(!on())}
    >
      <Sparkles class="h-[18px] w-[18px]" />
    </button>
  )
}

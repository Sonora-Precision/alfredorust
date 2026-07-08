// The ⚡ toggle: forces full motion even when the OS "reduce motion" preference
// is on (useful for demos). Backed by lib/motion's persisted motionForced state.
import { Zap } from 'lucide-solid'

import { setMotionForced, useMotionForced } from '../../lib/motion'

export function MotionToggle() {
  const forced = useMotionForced()
  return (
    <button
      type="button"
      class="grid h-9 w-9 place-items-center rounded-lg text-muted-foreground transition hover:bg-muted hover:text-foreground aria-pressed:text-primary"
      aria-pressed={forced()}
      aria-label="Forzar movimiento completo"
      title="Forzar movimiento completo (ignora 'Reducir movimiento' del sistema)"
      onClick={() => setMotionForced(!forced())}
    >
      <Zap class="h-[18px] w-[18px]" />
    </button>
  )
}

// Ported from frontend/src/app.rs's Topbar theme toggle button: icon shows
// the CURRENT theme (moon when dark, sun when light), not the theme you'd
// switch to.
import type { JSX } from 'solid-js'

import { toggleTheme, useTheme } from '../../lib/theme'
import { Button } from '../ui/Button'

export function ThemeToggle(): JSX.Element {
  const theme = useTheme()
  return (
    <Button
      variant="ghost"
      onClick={toggleTheme}
      aria-label="Cambiar tema"
      title="Cambiar tema claro/oscuro"
    >
      {theme() === 'dark' ? '🌙' : '☀️'}
    </Button>
  )
}

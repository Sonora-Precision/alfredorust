// Real login page — ported from frontend/src/app.rs's `LoginView`. Passwordless
// TOTP: username + 6-digit code. On success: if the server returns a
// redirect_url (different tenant subdomain), do a full page navigation there
// (the cookies for that origin were already pre-seeded by the login
// response); otherwise re-bootstrap /api/me in place and go to "/".
import { useNavigate } from '@solidjs/router'
import { Landmark } from 'lucide-solid'
import { type JSX, Show, createSignal } from 'solid-js'

import { login } from '../lib/api/auth'
import { ApiError } from '../lib/api/client'
import { useAuth } from '../lib/auth/AuthContext'
import { Button } from '../components/ui/Button'
import { Card } from '../components/ui/Card'
import { Input } from '../components/ui/Input'
import { SpaceBackground } from '../components/layout/SpaceBackground'

export default function Login(): JSX.Element {
  const auth = useAuth()
  const navigate = useNavigate()

  const [username, setUsername] = createSignal('')
  const [code, setCode] = createSignal('')
  const [error, setError] = createSignal<string | null>(null)
  const [pending, setPending] = createSignal(false)

  const submit = async (ev: SubmitEvent) => {
    ev.preventDefault()
    setError(null)
    setPending(true)
    try {
      const ok = await login(username(), code())
      if (ok.redirect_url) {
        window.location.href = ok.redirect_url
        return
      }
      await auth.refresh()
      navigate('/')
    } catch (err) {
      if (err instanceof ApiError && err.isUnauthorized) {
        // Generic message — never reveal whether the username exists.
        setError('Usuario o código inválido')
      } else {
        setError('Error de autenticación. Intenta de nuevo.')
      }
    } finally {
      setPending(false)
    }
  }

  return (
    <div class="min-h-screen">
      <SpaceBackground />
      <div class="relative z-10 flex min-h-screen items-center justify-center p-4">
        <Card glass glow class="w-full max-w-sm p-6 sm:p-7">
          <div class="mb-6 flex flex-col items-center gap-2.5 text-center">
            <div class="grid h-11 w-11 place-items-center rounded-xl bg-primary text-primary-foreground shadow-sm">
              <Landmark class="h-6 w-6" />
            </div>
            <div class="leading-tight">
              <h1 class="text-lg font-semibold tracking-tight">Iniciar sesión</h1>
              <p class="mt-0.5 text-[12px] text-muted-foreground">Accede con tu usuario y código</p>
            </div>
          </div>
          <form class="space-y-4" onSubmit={submit}>
            <div class="space-y-1">
              <label for="login-username" class="block text-sm font-medium text-foreground">Usuario</label>
              <Input
                id="login-username"
                aria-label="Usuario"
                value={username()}
                onInput={setUsername}
                autocomplete="username"
                placeholder="usuario"
                required
              />
            </div>

            <div class="space-y-1">
              <label for="login-code" class="block text-sm font-medium text-foreground">Código (6 dígitos)</label>
              <Input
                id="login-code"
                aria-label="Código de 6 dígitos"
                value={code()}
                onInput={setCode}
                inputmode="numeric"
                maxlength={6}
                class="tracking-widest"
                required
              />
            </div>

            <Show when={error()}>
              <p class="text-sm text-destructive">{error()}</p>
            </Show>

            <Button type="submit" disabled={pending()} class="magnetic w-full">
              {pending() ? 'Entrando…' : 'Entrar'}
            </Button>
          </form>
        </Card>
      </div>
    </div>
  )
}

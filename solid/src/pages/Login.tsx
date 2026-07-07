// Real login page — ported from frontend/src/app.rs's `LoginView`. Passwordless
// TOTP: username + 6-digit code. On success: if the server returns a
// redirect_url (different tenant subdomain), do a full page navigation there
// (the cookies for that origin were already pre-seeded by the login
// response); otherwise re-bootstrap /api/me in place and go to "/".
import { useNavigate } from '@solidjs/router'
import { type JSX, Show, createSignal } from 'solid-js'

import { login } from '../lib/api/auth'
import { ApiError } from '../lib/api/client'
import { useAuth } from '../lib/auth/AuthContext'
import { Button } from '../components/ui/Button'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/Card'
import { Input } from '../components/ui/Input'

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
    <div class="flex min-h-screen items-center justify-center p-4">
      <Card class="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Iniciar sesión</CardTitle>
        </CardHeader>
        <CardContent>
          <form class="space-y-4" onSubmit={submit}>
            <div class="space-y-1">
              <label class="block text-sm font-medium text-foreground">Usuario</label>
              <Input
                value={username()}
                onInput={setUsername}
                autocomplete="username"
                placeholder="usuario"
                required
              />
            </div>

            <div class="space-y-1">
              <label class="block text-sm font-medium text-foreground">Código (6 dígitos)</label>
              <Input
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

            <Button type="submit" disabled={pending()} class="w-full">
              {pending() ? 'Entrando…' : 'Entrar'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}

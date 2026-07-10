// Mi cuenta — the logged-in user's own profile: change username and
// optionally rotate the TOTP secret. Available to every authenticated user
// (no admin gating). Faithful port of frontend/src/pages/account.rs; see
// docs/solid-migration/pages-part1.md "AccountPage". Unlike the sibling list
// pages this is a single-entity settings form, so it renders straight into a
// Card (no Modal/Table). After a successful save we also refresh the auth
// context so the Topbar (which reads the username from `Me`) doesn't go
// stale — the Leptos original didn't need this because it never re-read
// `Me` after login.
import { createMutation, createQuery } from '@tanstack/solid-query'
import { type JSX, Show, createEffect, createSignal } from 'solid-js'

import { Button } from '../components/ui/Button'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/Card'
import { Input } from '../components/ui/Input'
import { PageHeader } from '../components/ui/PageHeader'
import { toast } from '../components/ui/Toast'
import * as adminApi from '../lib/api/admin'
import { humanizeError } from '../lib/api/client'
import type { ProfilePayload } from '../lib/api/types'
import { useAuth } from '../lib/auth/AuthContext'

export default function Account(): JSX.Element {
  const auth = useAuth()

  const profileQuery = createQuery(() => ({
    queryKey: ['account'],
    queryFn: adminApi.getAccountProfile,
  }))

  const [username, setUsername] = createSignal('')
  const [secret, setSecret] = createSignal('')
  const [formError, setFormError] = createSignal<string | null>(null)
  const [initialized, setInitialized] = createSignal(false)

  // Prefill once when the profile loads; don't stomp on in-progress edits on
  // a background refetch.
  createEffect(() => {
    const data = profileQuery.data
    if (data && !initialized()) {
      setUsername(data.username)
      setInitialized(true)
    }
  })

  const saveMutation = createMutation(() => ({
    mutationFn: (payload: ProfilePayload) => adminApi.updateAccountProfile(payload),
    onSuccess: () => {
      toast.success('Tu información se guardó correctamente')
      setSecret('')
      setFormError(null)
      void auth.refresh()
    },
    onError: (err) => {
      setFormError(humanizeError(err, 'No se pudo guardar la información'))
    },
  }))

  const submit = (ev: SubmitEvent) => {
    ev.preventDefault()
    if (username().trim() === '') {
      setFormError('El nombre de usuario es obligatorio')
      return
    }
    setFormError(null)
    saveMutation.mutate({
      username: username().trim(),
      // Empty string means "keep the current secret" per the backend
      // contract — never coerced to null, ProfilePayload.secret is required.
      secret: secret().trim(),
    })
  }

  return (
    <div class="space-y-6">
      <PageHeader title="Mi cuenta" subtitle="Actualiza los datos asociados a tu usuario." />

      <Card glass class="max-w-lg">
        <CardHeader>
          <CardTitle>Perfil</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} class="space-y-4">
            <div class="space-y-1.5">
              <label class="block text-sm font-medium text-foreground">Usuario</label>
              <Input
                value={username()}
                onInput={setUsername}
                autocomplete="username"
                aria-label="Usuario"
                required
                disabled={profileQuery.isLoading}
              />
            </div>
            <div class="space-y-1.5">
              <label class="block text-sm font-medium text-foreground">Secreto TOTP</label>
              <Input
                value={secret()}
                onInput={setSecret}
                class="font-mono"
                placeholder="Déjalo vacío para conservar el actual"
              />
              <p class="text-xs text-muted-foreground">
                Escribe un nuevo secreto solo si quieres reconfigurar tu autenticador.
              </p>
            </div>

            <Show when={formError()}>
              <p class="text-sm text-destructive">{formError()}</p>
            </Show>

            <div class="flex items-center gap-2">
              <Button type="submit" disabled={saveMutation.isPending || profileQuery.isLoading}>
                {saveMutation.isPending ? 'Guardando…' : 'Guardar cambios'}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}

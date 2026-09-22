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
import { type JSX, For, Show, createEffect, createSignal } from 'solid-js'

import { Button } from '../components/ui/Button'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/Card'
import { Input } from '../components/ui/Input'
import { Select } from '../components/ui/Select'
import { PageHeader } from '../components/ui/PageHeader'
import { toast } from '../components/ui/Toast'
import * as adminApi from '../lib/api/admin'
import { humanizeError } from '../lib/api/client'
import type { CreatedPersonalAccessToken, ProfilePayload } from '../lib/api/types'
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
  const [tokenName, setTokenName] = createSignal('spcli')
  const [tokenDays, setTokenDays] = createSignal('90')
  const [createdToken, setCreatedToken] = createSignal<CreatedPersonalAccessToken | null>(null)

  const tokensQuery = createQuery(() => ({
    queryKey: ['account', 'tokens'],
    queryFn: adminApi.listPersonalAccessTokens,
  }))

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

  const createTokenMutation = createMutation(() => ({
    mutationFn: adminApi.createPersonalAccessToken,
    onSuccess: (token) => {
      setCreatedToken(token)
      setTokenName('spcli')
      void tokensQuery.refetch()
    },
    onError: (err) => toast.error(humanizeError(err, 'No se pudo crear el token')),
  }))

  const revokeTokenMutation = createMutation(() => ({
    mutationFn: adminApi.revokePersonalAccessToken,
    onSuccess: () => {
      toast.success('Token revocado')
      void tokensQuery.refetch()
    },
    onError: (err) => toast.error(humanizeError(err, 'No se pudo revocar el token')),
  }))

  const createToken = (ev: SubmitEvent) => {
    ev.preventDefault()
    if (!tokenName().trim()) return
    setCreatedToken(null)
    createTokenMutation.mutate({
      name: tokenName().trim(),
      expires_in_days: Number(tokenDays()),
    })
  }

  const copyToken = async () => {
    const token = createdToken()?.token
    if (!token) return
    await navigator.clipboard.writeText(token)
    toast.success('Token copiado')
  }

  const formatDate = (value?: string | null) =>
    value ? new Intl.DateTimeFormat('es-MX', { dateStyle: 'medium' }).format(new Date(value)) : 'Nunca'

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

      <Card glass class="max-w-3xl">
        <CardHeader>
          <CardTitle>Tokens de acceso</CardTitle>
          <p class="text-sm text-muted-foreground">
            Conecta spcli y skills sin compartir tu secreto TOTP. Puedes revocar cada dispositivo por separado.
          </p>
        </CardHeader>
        <CardContent class="space-y-5">
          <form onSubmit={createToken} class="grid gap-3 sm:grid-cols-[1fr_10rem_auto] sm:items-end">
            <div class="space-y-1.5">
              <label class="block text-sm font-medium text-foreground">Nombre del dispositivo</label>
              <Input value={tokenName()} onInput={setTokenName} placeholder="Mac de oficina" required />
            </div>
            <div class="space-y-1.5">
              <label class="block text-sm font-medium text-foreground">Vigencia</label>
              <Select value={tokenDays()} onChange={setTokenDays}>
                <option value="30">30 días</option>
                <option value="90">90 días</option>
                <option value="365">1 año</option>
              </Select>
            </div>
            <Button type="submit" disabled={createTokenMutation.isPending}>
              {createTokenMutation.isPending ? 'Creando…' : 'Crear token'}
            </Button>
          </form>

          <Show when={createdToken()} keyed>
            {(created) => (
              <div class="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 space-y-3">
                <div>
                  <p class="text-sm font-semibold">Guárdalo ahora: solo se mostrará esta vez.</p>
                  <p class="text-xs text-muted-foreground">No lo pegues en el repositorio ni en archivos del skill.</p>
                </div>
                <div class="flex flex-col gap-2 sm:flex-row">
                  <Input value={created.token} onInput={() => {}} readonly class="font-mono text-xs" aria-label="Token nuevo" />
                  <Button variant="outline" onClick={() => void copyToken()}>Copiar</Button>
                </div>
                <code class="block rounded bg-background/70 p-2 text-xs break-all">
                  {`spcli auth token --base-url ${window.location.origin} --stdin`}
                </code>
              </div>
            )}
          </Show>

          <div class="divide-y divide-border rounded-lg border border-border">
            <Show
              when={(tokensQuery.data?.length ?? 0) > 0}
              fallback={<p class="p-4 text-sm text-muted-foreground">No hay tokens creados.</p>}
            >
              <For each={tokensQuery.data}>
                {(token) => (
                  <div class="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <div class="flex items-center gap-2">
                        <span class="font-medium">{token.name}</span>
                        <code class="text-xs text-muted-foreground">{token.token_prefix}…</code>
                        <Show when={token.revoked_at}>
                          <span class="rounded-full bg-destructive/10 px-2 py-0.5 text-xs text-destructive">Revocado</span>
                        </Show>
                      </div>
                      <p class="mt-1 text-xs text-muted-foreground">
                        Expira {formatDate(token.expires_at)} · Último uso: {formatDate(token.last_used_at)}
                      </p>
                    </div>
                    <Show when={!token.revoked_at}>
                      <Button
                        variant="outline"
                        disabled={revokeTokenMutation.isPending}
                        onClick={() => revokeTokenMutation.mutate(token.id)}
                      >
                        Revocar
                      </Button>
                    </Show>
                  </div>
                )}
              </For>
            </Show>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

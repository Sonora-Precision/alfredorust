// Wraps protected routes: shows a loading state while /api/me resolves,
// redirects to /login on anon, renders children once authed. Permissions from
// /api/me are UX-only — the server remains the authorization boundary.
import { Navigate } from '@solidjs/router'
import { type JSX, Match, type ParentProps, Switch } from 'solid-js'

import { useAuth } from './AuthContext'

export function RequireAuth(props: ParentProps): JSX.Element {
  const auth = useAuth()

  return (
    <Switch>
      <Match when={auth.status() === 'loading'}>
        <div class="flex min-h-screen items-center justify-center">
          <p class="text-muted-foreground">Cargando…</p>
        </div>
      </Match>
      <Match when={auth.status() === 'anon'}>
        <Navigate href="/login" />
      </Match>
      <Match when={auth.status() === 'authed'}>{props.children}</Match>
    </Switch>
  )
}

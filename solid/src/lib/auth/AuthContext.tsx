// Auth bootstrap + context. Mirrors frontend/src/app.rs's `Auth` state
// machine (Loading/Anon/Authed) but as a Solid context provider instead of a
// top-level enum match, so RequireAuth + pages can consume it independently.
import { type JSX, type ParentProps, createContext, createSignal, onMount, useContext } from 'solid-js'

import { me as fetchMe, logout as apiLogout } from '../api/auth'
import { setUnauthorizedHandler } from '../api/client'
import type { CompanySummary, MeResponse } from '../api/types'

export type AuthStatus = 'loading' | 'anon' | 'authed'

export interface AuthState {
  status: () => AuthStatus
  user: () => string | null
  company: () => string | null
  companySlug: () => string | null
  role: () => 'admin' | 'staff' | null
  permissions: () => string[]
  companies: () => CompanySummary[]
  hasPermission: (key: string) => boolean
  isAdmin: () => boolean
  refresh: () => Promise<void>
  logout: () => Promise<void>
}

const AuthContext = createContext<AuthState>()

export function AuthProvider(props: ParentProps): JSX.Element {
  const [me, setMe] = createSignal<MeResponse | null>(null)
  const [status, setStatus] = createSignal<AuthStatus>('loading')

  const load = async () => {
    // On the public /login page there's no session yet; skip the bootstrap
    // /api/me call so its expected 401 doesn't get logged as a console error
    // (Lighthouse "Browser errors were logged to the console").
    if (typeof window !== 'undefined' && window.location.pathname === '/login') {
      setMe(null)
      setStatus('anon')
      return
    }
    try {
      const profile = await fetchMe()
      setMe(profile)
      setStatus('authed')
    } catch {
      // 401 (not logged in) and any other bootstrap failure both resolve to
      // "anon" — RequireAuth sends the user to /login either way.
      setMe(null)
      setStatus('anon')
    }
  }

  onMount(() => {
    // Registered so the low-level client can clear auth state on a 401 from
    // any call, not just the bootstrap one.
    setUnauthorizedHandler(() => {
      setMe(null)
      setStatus('anon')
    })
    void load()
  })

  const state: AuthState = {
    status,
    user: () => me()?.username ?? null,
    company: () => me()?.company ?? null,
    companySlug: () => me()?.company_slug ?? null,
    role: () => me()?.role ?? null,
    permissions: () => me()?.permissions ?? [],
    companies: () => me()?.companies ?? [],
    hasPermission: (key: string) => {
      const current = me()
      if (!current) return false
      return current.role === 'admin' || current.permissions.includes(key)
    },
    isAdmin: () => me()?.role === 'admin',
    refresh: load,
    logout: async () => {
      try {
        await apiLogout()
      } finally {
        setMe(null)
        setStatus('anon')
      }
    },
  }

  return <AuthContext.Provider value={state}>{props.children}</AuthContext.Provider>
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider')
  return ctx
}

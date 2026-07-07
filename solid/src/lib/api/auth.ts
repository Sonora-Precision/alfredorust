import { apiGet, apiPost } from './client'
import type { LoginOk, MeResponse } from './types'

/** Bootstrap the current session. Throws `ApiError` (unauthorized) if anonymous. */
export function me(): Promise<MeResponse> {
  return apiGet<MeResponse>('/api/me')
}

/** Passwordless TOTP login. The server sets the session cookie on success. */
export function login(username: string, code: string): Promise<LoginOk> {
  return apiPost<LoginOk>('/login', { username, code })
}

/** End the session server-side. */
export function logout(): Promise<{ ok: boolean }> {
  return apiPost<{ ok: boolean }>('/logout')
}

// Typed fetch client over the existing JSON API. Ported from
// frontend/src/api/mod.rs. All requests are same-origin (or proxied
// same-origin in dev) so the HttpOnly session cookie is sent automatically.
//
// Contract (frozen — see docs/solid-migration/PLAN.md §5):
//   apiGet<T>(path, params?)        -> T
//   apiPost<T>(path, body?)         -> T
//   apiPostForm<T>(path, form)      -> T   (multipart, no JSON content-type)
//   apiGetBlob(path)                -> Blob (raw image/png QR)
// All use credentials:'include', absolute paths, Accept: application/json.
// 401 -> clear auth + redirect to /v3/login. Non-ok -> throw ApiError.

/** Mirrors the 4-way error taxonomy from the Leptos client's `ApiError`. */
export class ApiError extends Error {
  readonly kind: 'unauthorized' | 'forbidden' | 'status' | 'transport'
  readonly status?: number

  constructor(
    kind: 'unauthorized' | 'forbidden' | 'status' | 'transport',
    message: string,
    status?: number,
  ) {
    super(message)
    this.name = 'ApiError'
    this.kind = kind
    this.status = status
  }

  get isUnauthorized(): boolean {
    return this.kind === 'unauthorized'
  }

  get isForbidden(): boolean {
    return this.kind === 'forbidden'
  }
}

/** Decide what to show the user for an error, mirroring `humanize()`. */
export function humanizeError(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    switch (err.kind) {
      case 'forbidden':
        return 'No tienes permiso para esta acción'
      case 'unauthorized':
        return 'Tu sesión expiró. Vuelve a iniciar sesión.'
      case 'transport':
        return 'Error de conexión. Intenta de nuevo.'
      case 'status':
        return err.message.trim() !== '' ? err.message : fallback
    }
  }
  return fallback
}

let onUnauthorized: (() => void) | null = null

/** Registered once by the AuthProvider so the client can clear auth state. */
export function setUnauthorizedHandler(handler: (() => void) | null): void {
  onUnauthorized = handler
}

function redirectToLogin(): void {
  onUnauthorized?.()
  if (typeof window !== 'undefined') {
    window.location.href = '/login'
  }
}

async function errorFromResponse(resp: Response): Promise<ApiError> {
  if (resp.status === 401) return new ApiError('unauthorized', 'unauthorized', 401)
  if (resp.status === 403) return new ApiError('forbidden', 'forbidden', 403)
  let message = ''
  try {
    const body = await resp.text()
    const parsed = JSON.parse(body) as { error?: string }
    if (typeof parsed.error === 'string') message = parsed.error
  } catch {
    // body wasn't JSON / was empty — leave message blank, caller falls back.
  }
  return new ApiError('status', message, resp.status)
}

function isSuccess(status: number): boolean {
  return status === 200 || status === 201 || status === 202 || status === 204
}

function buildUrl(path: string, params?: Record<string, string | number>): string {
  if (!params) return path
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) qs.set(k, String(v))
  const query = qs.toString()
  return query ? `${path}?${query}` : path
}

async function handle<T>(promise: Promise<Response>): Promise<T> {
  let resp: Response
  try {
    resp = await promise
  } catch (e) {
    throw new ApiError('transport', e instanceof Error ? e.message : String(e))
  }
  if (resp.status === 401) {
    redirectToLogin()
    throw new ApiError('unauthorized', 'unauthorized', 401)
  }
  if (!isSuccess(resp.status)) {
    throw await errorFromResponse(resp)
  }
  if (resp.status === 204) return undefined as T
  const text = await resp.text()
  if (text === '') return undefined as T
  return JSON.parse(text) as T
}

export async function apiGet<T>(
  path: string,
  params?: Record<string, string | number>,
): Promise<T> {
  return handle<T>(
    fetch(buildUrl(path, params), {
      method: 'GET',
      credentials: 'include',
      headers: { Accept: 'application/json' },
    }),
  )
}

export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  return handle<T>(
    fetch(path, {
      method: 'POST',
      credentials: 'include',
      headers: {
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
  )
}

export async function apiPostForm<T>(path: string, form: FormData): Promise<T> {
  // Do not set Content-Type manually — the browser sets the multipart
  // boundary automatically for a FormData body.
  return handle<T>(
    fetch(path, {
      method: 'POST',
      credentials: 'include',
      headers: { Accept: 'application/json' },
      body: form,
    }),
  )
}

export async function apiGetBlob(path: string): Promise<Blob> {
  let resp: Response
  try {
    resp = await fetch(path, { method: 'GET', credentials: 'include' })
  } catch (e) {
    throw new ApiError('transport', e instanceof Error ? e.message : String(e))
  }
  if (resp.status === 401) {
    redirectToLogin()
    throw new ApiError('unauthorized', 'unauthorized', 401)
  }
  if (!isSuccess(resp.status)) {
    throw await errorFromResponse(resp)
  }
  return resp.blob()
}

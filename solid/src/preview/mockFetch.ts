// DELETABLE — design-approval gate only (see src/preview/DesignPreview.tsx).
// Installs a `window.fetch` interceptor that answers exactly the endpoints
// Dashboard/Accounts (and the auth bootstrap) call, backed by an in-memory
// store seeded from sampleData.ts. This lets the real page components + real
// AuthContext/solid-query code paths run completely unmodified with NO
// backend process — including live create/update/delete on the Accounts
// page. Anything unmatched falls through to the real `fetch`.
import type { Account, AccountPayload } from '../lib/api/types'
import { SAMPLE_ACCOUNTS, SAMPLE_ME, SAMPLE_TRANSACTIONS, type SampleAccountRow, toAccountDetail, toListRow } from './sampleData'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(body === undefined ? '' : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function parseBody(init?: RequestInit): unknown {
  if (!init?.body) return undefined
  try {
    return JSON.parse(String(init.body))
  } catch {
    return undefined
  }
}

/** Mutable — the Accounts page's real create/update/delete mutations act on
 * this, so the CRUD demo is genuinely live in the preview. */
const store: SampleAccountRow[] = SAMPLE_ACCOUNTS.map((a) => ({ ...a }))

let installed = false
let original: typeof window.fetch | null = null

export function installMockFetch(): void {
  if (installed) return
  installed = true
  original = window.fetch.bind(window)

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const path = new URL(rawUrl, window.location.origin).pathname
    const method = (init?.method ?? 'GET').toUpperCase()

    if (method === 'GET' && path === '/api/me') {
      return jsonResponse(SAMPLE_ME)
    }

    if (method === 'GET' && path === '/api/admin/accounts') {
      return jsonResponse(store.map(toListRow) satisfies Account[])
    }

    if (method === 'GET' && path === '/api/admin/transactions/data') {
      return jsonResponse(SAMPLE_TRANSACTIONS)
    }

    const detailMatch = method === 'GET' && /^\/api\/admin\/accounts\/([^/]+)$/.exec(path)
    if (detailMatch) {
      const row = store.find((a) => a.id === detailMatch[1])
      if (!row) return jsonResponse({ error: 'not found' }, 404)
      return jsonResponse(toAccountDetail(row))
    }

    if (method === 'POST' && path === '/api/admin/accounts') {
      const payload = parseBody(init) as AccountPayload
      const id = `acc-${Math.random().toString(36).slice(2, 9)}`
      store.push({
        id,
        company: SAMPLE_ME.company,
        name: payload.name,
        account_type: payload.account_type,
        currency: payload.currency ?? 'MXN',
        is_active: payload.is_active,
        notes: payload.notes ?? null,
      })
      return jsonResponse(undefined, 201)
    }

    const updateMatch = method === 'POST' && /^\/api\/admin\/accounts\/([^/]+)\/update$/.exec(path)
    if (updateMatch) {
      const payload = parseBody(init) as AccountPayload
      const row = store.find((a) => a.id === updateMatch[1])
      if (!row) return jsonResponse({ error: 'not found' }, 404)
      row.name = payload.name
      row.account_type = payload.account_type
      row.currency = payload.currency ?? row.currency
      row.is_active = payload.is_active
      row.notes = payload.notes ?? null
      return jsonResponse(undefined, 200)
    }

    const deleteMatch = method === 'POST' && /^\/api\/admin\/accounts\/([^/]+)\/delete$/.exec(path)
    if (deleteMatch) {
      const idx = store.findIndex((a) => a.id === deleteMatch[1])
      if (idx >= 0) store.splice(idx, 1)
      return jsonResponse(undefined, 200)
    }

    return original!(input as RequestInfo, init)
  }
}

/** Restores the real `window.fetch` and resets the in-memory store — called
 * when DesignPreview unmounts so the mock doesn't leak into the rest of the
 * (real) app if the user navigates away without a full page reload. */
export function uninstallMockFetch(): void {
  if (!installed || !original) return
  window.fetch = original
  installed = false
  original = null
  store.length = 0
  store.push(...SAMPLE_ACCOUNTS.map((a) => ({ ...a })))
}

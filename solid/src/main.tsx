/* @refresh reload */
import { QueryClient, QueryClientProvider } from '@tanstack/solid-query'
import { Router } from '@solidjs/router'
import { ErrorBoundary } from 'solid-js'
import { render } from 'solid-js/web'

import App from './App.tsx'
import { Toaster } from './components/ui/Toast'
import { AuthProvider } from './lib/auth/AuthContext'
// Self-hosted IBM Plex (was render-blocking Google Fonts). Same-origin + hashed
// + immutable-cached, no external round-trip, keeps font-display: swap. The
// family names match the --font-sans / --font-mono tokens in index.css.
import '@fontsource/ibm-plex-sans/latin-400.css'
import '@fontsource/ibm-plex-sans/latin-500.css'
import '@fontsource/ibm-plex-sans/latin-600.css'
import '@fontsource/ibm-plex-sans/latin-700.css'
import '@fontsource/ibm-plex-mono/latin-400.css'
import '@fontsource/ibm-plex-mono/latin-500.css'
import '@fontsource/ibm-plex-mono/latin-600.css'
import './index.css'
import './styles/space-theme.css'
import './styles/app-theme.css'

const root = document.getElementById('root')

// One shared query client for the whole app; domain modules key their
// queries as [domain, companySlug?, ...] so switching tenants (a full page
// nav) naturally starts from a clean cache.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
})

// IMPORTANT: <Router>'s children must resolve to nothing but <Route> defs
// (solid-router walks that tree to build its route table) — AuthProvider and
// Toaster sit OUTSIDE <Router> so they don't get mixed into that resolution.
// Context still reaches every route: AuthProvider is an ancestor of Router.
render(
  () => (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        {/* Last-resort net: if routing itself throws (before the in-shell
            ErrorBoundary), show a full-screen recover instead of a blank page. */}
        <ErrorBoundary
          fallback={(err) => (
            <div class="grid min-h-screen place-items-center p-6 text-center">
              <div>
                <p class="text-lg font-semibold">La aplicación tuvo un problema</p>
                <p class="mt-1 text-sm text-muted-foreground">{String((err as Error)?.message ?? err)}</p>
                <button
                  class="mt-4 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
                  onClick={() => window.location.reload()}
                >
                  Recargar
                </button>
              </div>
            </div>
          )}
        >
          <Router base="/">
            <App />
          </Router>
        </ErrorBoundary>
        <Toaster />
      </AuthProvider>
    </QueryClientProvider>
  ),
  root!,
)

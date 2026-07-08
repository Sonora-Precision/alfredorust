/* @refresh reload */
import { QueryClient, QueryClientProvider } from '@tanstack/solid-query'
import { Router } from '@solidjs/router'
import { render } from 'solid-js/web'

import App from './App.tsx'
import { Toaster } from './components/ui/Toast'
import { AuthProvider } from './lib/auth/AuthContext'
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
        <Router base="/v3">
          <App />
        </Router>
        <Toaster />
      </AuthProvider>
    </QueryClientProvider>
  ),
  root!,
)

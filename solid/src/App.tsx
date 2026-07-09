// All routes for the Solid SPA (base "/v3", set on <Router> in main.tsx).
// Every authed route is nested under a shared layout route that applies
// RequireAuth + AppShell once; `/login` is the only public route. Route ->
// page file mapping mirrors frontend/src/app.rs's <Routes> block 1:1.
//
// Frozen contract (docs/solid-migration/PLAN.md §4): this file, lib/api/*,
// components/ui/*, components/layout/* are read-only for page agents — they
// only fill in their placeholder under src/pages/.
import { Route } from '@solidjs/router'
import { type JSX, lazy } from 'solid-js'

import { AppShell } from './components/layout/AppShell'
import { RequireAuth } from './lib/auth/RequireAuth'

// DELETABLE — design-approval gate only, see src/preview/DesignPreview.tsx.
// Remove this import + the <Route path="/preview/design" .../> below when
// Dashboard/Accounts are approved (GATE A in docs/solid-migration/PROGRESS.md).
const DesignPreview = lazy(() => import('./preview/DesignPreview'))

const Login = lazy(() => import('./pages/Login'))
const Dashboard = lazy(() => import('./pages/Dashboard'))
const Onboarding = lazy(() => import('./pages/Onboarding'))
const Accounts = lazy(() => import('./pages/Accounts'))
const Categories = lazy(() => import('./pages/Categories'))
const Contacts = lazy(() => import('./pages/Contacts'))
const Transactions = lazy(() => import('./pages/Transactions'))
const RecurringPlans = lazy(() => import('./pages/RecurringPlans'))
const PlannedEntries = lazy(() => import('./pages/PlannedEntries'))
const Forecasts = lazy(() => import('./pages/Forecasts'))
const Cfdi = lazy(() => import('./pages/Cfdi'))
const SatConfigs = lazy(() => import('./pages/SatConfigs'))
const Account = lazy(() => import('./pages/Account'))
const Companies = lazy(() => import('./pages/Companies'))
const Users = lazy(() => import('./pages/Users'))
const Orders = lazy(() => import('./pages/Orders'))
const Projects = lazy(() => import('./pages/Projects'))
const ProjectDetail = lazy(() => import('./pages/ProjectDetail'))
const ConceptStatuses = lazy(() => import('./pages/ConceptStatuses'))
const Resources = lazy(() => import('./pages/Resources'))
const ResourceLogs = lazy(() => import('./pages/ResourceLogs'))
const ResourceUsages = lazy(() => import('./pages/ResourceUsages'))
const Tiempo = lazy(() => import('./pages/Tiempo'))

function ProtectedLayout(props: { children?: JSX.Element }): JSX.Element {
  return (
    <RequireAuth>
      <AppShell>{props.children}</AppShell>
    </RequireAuth>
  )
}

export default function App(): JSX.Element {
  return (
    <>
      <Route path="/login" component={Login} />
      {/* DELETABLE — design-approval gate only, see src/preview/DesignPreview.tsx. */}
      <Route path="/preview/design" component={DesignPreview} />
      <Route path="/" component={ProtectedLayout}>
        <Route path="/" component={Dashboard} />
        <Route path="/onboarding" component={Onboarding} />
        <Route path="/accounts" component={Accounts} />
        <Route path="/categories" component={Categories} />
        <Route path="/contacts" component={Contacts} />
        <Route path="/transactions" component={Transactions} />
        <Route path="/recurring-plans" component={RecurringPlans} />
        <Route path="/planned-entries" component={PlannedEntries} />
        <Route path="/forecasts" component={Forecasts} />
        <Route path="/cfdi" component={Cfdi} />
        <Route path="/sat-configs" component={SatConfigs} />
        <Route path="/account" component={Account} />
        <Route path="/companies" component={Companies} />
        <Route path="/users" component={Users} />
        <Route path="/orders" component={Orders} />
        <Route path="/projects" component={Projects} />
        <Route path="/projects/:id" component={ProjectDetail} />
        <Route path="/concept-statuses" component={ConceptStatuses} />
        <Route path="/resources" component={Resources} />
        <Route path="/resource-logs" component={ResourceLogs} />
        <Route path="/resource-usages" component={ResourceUsages} />
        <Route path="/tiempo" component={Tiempo} />
      </Route>
    </>
  )
}

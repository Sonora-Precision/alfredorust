// Tenant onboarding readiness. Single source of truth lives in the backend
// (`GET /api/onboarding/status`, src/routes/admin/onboarding.rs); the setup
// wizard and the `spcli onboarding status` command both consume it so the
// checklist never drifts.
import { apiGet } from './client'

export interface OnboardingStep {
  /** Stable machine key: company | accounts | categories | concept_statuses | contacts | sat_config | users */
  key: string
  label: string
  required: boolean
  done: boolean
  count: number
  detail: string
  unlocks: string
  /** SPA route whose create form fills this step. */
  route: string
  cta: string
}

export interface OnboardingStatus {
  ready: boolean
  required_done: number
  required_total: number
  steps: OnboardingStep[]
}

export const getOnboardingStatus = () => apiGet<OnboardingStatus>('/api/onboarding/status')

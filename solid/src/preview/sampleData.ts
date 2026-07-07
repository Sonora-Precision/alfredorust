// DELETABLE — design-approval gate only (see src/preview/DesignPreview.tsx).
// Realistic canned data for the mock backend in mockFetch.ts. Shapes mirror
// ../lib/api/types.ts exactly so the real pages (Dashboard/Accounts) render
// as they would against a live API.
import type { Account, AccountDetail, MeResponse, Transaction } from '../lib/api/types'

export const SAMPLE_ME: MeResponse = {
  username: 'alfredo',
  company: 'Sonora Precision',
  company_slug: 'sonora',
  role: 'admin',
  permissions: [
    'view_timeline',
    'view_projects',
    'edit_resource_usage_today',
    'view_resource_usage_history',
  ],
  companies: [
    { id: 'c1', name: 'Sonora Precision', slug: 'sonora', active: true },
    { id: 'c2', name: 'Maquinados del Norte', slug: 'maquinados-norte', active: false },
    { id: 'c3', name: 'Alfredo Rivera Consultoría', slug: 'consultoria', active: false },
  ],
}

export interface SampleAccountRow extends Account {
  notes: string | null
}

export const SAMPLE_ACCOUNTS: SampleAccountRow[] = [
  {
    id: 'acc-1',
    name: 'BBVA Empresarial',
    company: SAMPLE_ME.company,
    account_type: 'bank',
    currency: 'MXN',
    is_active: true,
    notes: 'Cuenta principal de operación.',
  },
  {
    id: 'acc-2',
    name: 'Caja chica taller',
    company: SAMPLE_ME.company,
    account_type: 'cash',
    currency: 'MXN',
    is_active: true,
    notes: null,
  },
  {
    id: 'acc-3',
    name: 'Amex Platinum Negocios',
    company: SAMPLE_ME.company,
    account_type: 'credit_card',
    currency: 'MXN',
    is_active: true,
    notes: 'Pago automático fin de mes.',
  },
  {
    id: 'acc-4',
    name: 'GBM Inversión',
    company: SAMPLE_ME.company,
    account_type: 'investment',
    currency: 'MXN',
    is_active: true,
    notes: null,
  },
  {
    id: 'acc-5',
    name: 'Santander USD',
    company: SAMPLE_ME.company,
    account_type: 'bank',
    currency: 'USD',
    is_active: true,
    notes: 'Cobros de clientes en el extranjero.',
  },
  {
    id: 'acc-6',
    name: 'Tarjeta combustible',
    company: SAMPLE_ME.company,
    account_type: 'other',
    currency: 'MXN',
    is_active: false,
    notes: 'Cancelada — reemplazada por caja chica.',
  },
]

export function toAccountDetail(row: SampleAccountRow): AccountDetail {
  return {
    name: row.name,
    account_type: row.account_type,
    currency: row.currency,
    is_active: row.is_active,
    notes: row.notes,
  }
}

/** List-row shape (matches what `GET /api/admin/accounts` actually returns —
 * no `notes` field, see Account in ../lib/api/types.ts). */
export function toListRow(row: SampleAccountRow): Account {
  const { notes: _notes, ...rest } = row
  return rest
}

const CATEGORIES_INCOME = ['Ventas', 'Servicios de maquinado', 'Consultoría'] as const
const CATEGORIES_EXPENSE = ['Nómina', 'Materia prima', 'Renta taller', 'Mantenimiento', 'Combustible'] as const

function monthLabel(monthsAgo: number): string {
  const d = new Date()
  d.setDate(1)
  d.setMonth(d.getMonth() - monthsAgo)
  return d.toISOString().slice(0, 7)
}

function seededAmount(seed: number, min: number, max: number): number {
  const x = Math.sin(seed * 999) * 10000
  const frac = x - Math.floor(x)
  return Math.round((min + frac * (max - min)) * 100) / 100
}

/** 6 months of income/expense transactions, generated deterministically so
 * the sample looks realistic without hand-writing every row. */
export const SAMPLE_TRANSACTIONS: Transaction[] = (() => {
  const rows: Transaction[] = []
  let seed = 1
  for (let m = 5; m >= 0; m--) {
    const ym = monthLabel(m)
    const incomeCount = 3 + (m % 2)
    const expenseCount = 4 + (m % 3)
    for (let i = 0; i < incomeCount; i++) {
      seed += 1
      rows.push({
        id: `tx-${seed}`,
        date: `${ym}-${String(5 + i * 6).padStart(2, '0')}T12:00:00Z`,
        description: `${CATEGORIES_INCOME[i % CATEGORIES_INCOME.length]} — cliente ${i + 1}`,
        tx_type: 'income',
        amount: seededAmount(seed, 8000, 65000),
        category: CATEGORIES_INCOME[i % CATEGORIES_INCOME.length],
        account_to: 'BBVA Empresarial',
        is_confirmed: true,
      })
    }
    for (let i = 0; i < expenseCount; i++) {
      seed += 1
      rows.push({
        id: `tx-${seed}`,
        date: `${ym}-${String(3 + i * 5).padStart(2, '0')}T12:00:00Z`,
        description: `${CATEGORIES_EXPENSE[i % CATEGORIES_EXPENSE.length]}`,
        tx_type: 'expense',
        amount: seededAmount(seed, 1500, 32000),
        category: CATEGORIES_EXPENSE[i % CATEGORIES_EXPENSE.length],
        account_from: 'BBVA Empresarial',
        is_confirmed: i % 4 !== 0,
      })
    }
  }
  return rows
})()

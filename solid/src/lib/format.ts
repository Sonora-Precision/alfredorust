// Money/date formatting helpers. Ported from frontend/src/pages/mod.rs.
// IMPORTANT: `localDtToRfc3339` replicates the current (buggy) behavior of
// treating a `datetime-local` value as UTC by appending "Z" — see
// docs/solid-migration/PLAN.md §13. Do NOT "fix" the timezone handling here;
// changing it alters stored data semantics. Flagged as known debt.

const MONEY_FORMATTER = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

/** Format a currency/value amount for display: `$1,232,543.90`. */
export function money(n: number): string {
  const neg = n < 0
  const formatted = MONEY_FORMATTER.format(Math.abs(n))
  return `${neg ? '-' : ''}$${formatted}`
}

/**
 * Backend datetime fields are parsed as RFC3339. `<input type="date">` yields
 * `YYYY-MM-DD`, so append a midnight-UTC time when needed.
 */
export function dateToRfc3339(date: string): string {
  const d = date.trim()
  if (d === '' || d.includes('T')) return d
  return `${d}T00:00:00Z`
}

/**
 * Inverse for edit forms: take the `YYYY-MM-DD` prefix of an RFC3339 datetime
 * so it fits an `<input type="date">`.
 */
export function rfc3339ToDate(value: string): string {
  return value.slice(0, 10)
}

/**
 * `<input type="datetime-local">` yields `YYYY-MM-DDTHH:MM` (no zone). Make it
 * RFC3339 by appending "Z" — replicates current (not-quite-correct) behavior
 * of treating the local wall-clock value as UTC. See module doc above.
 */
export function localDtToRfc3339(value: string): string {
  const v = value.trim()
  if (v === '' || v.endsWith('Z')) return v
  if (v.length === 16) return `${v}:00Z`
  return `${v}Z`
}

/** Inverse: RFC3339 -> `YYYY-MM-DDTHH:MM` for a datetime-local input. */
export function rfc3339ToLocalDt(value: string): string {
  return value.slice(0, 16)
}

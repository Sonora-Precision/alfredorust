// Comparing supplier quotes material by material (Daniel, 2026-11-08): a supplier may quote
// only some materials (Delrin to one, 4140 to two); each offer is read against our estimate
// of what it quoted.
import type { MaterialQuote } from '../../lib/api/quoting'
import type { CostLine } from './MaterialCost'

/** One row per material ("Acero 4140 (todo)"), summing its lines. */
export function byMaterial(lines: CostLine[]): CostLine[] {
  const out = new Map<string, CostLine>()
  for (const l of lines) {
    const m = l.material ?? 'Sin material'
    const cur = out.get(m)
    if (!cur) {
      out.set(m, { ...l, stock: m, material: l.material, pricedAs: null })
      continue
    }
    cur.kg = cur.kg != null && l.kg != null ? cur.kg + l.kg : null
    cur.estimate = cur.estimate != null && l.estimate != null ? cur.estimate + l.estimate : null
    cur.missing = cur.missing ?? l.missing
    if (cur.pricePerKg !== l.pricePerKg) cur.pricePerKg = null
  }
  return [...out.values()]
}

/** What one supplier offers for one material. */
export interface Offer {
  supplier: string
  quoted: number
  /** Our estimate of the lines it quoted. */
  estimate: number
  /** It quoted only some of the material's lines. */
  partial: boolean
}

/** Every quote's offer for each material of the project, cheapest first. A line saved before
 * materials were recorded finds its material by its stock. */
export function offersByMaterial(quotes: MaterialQuote[], project: CostLine[]): Map<string, Offer[]> {
  const materialOf = new Map(project.map((l) => [l.stock, l.material]))
  const stocksOf = new Map<string, number>()
  for (const l of project) if (l.material) stocksOf.set(l.material, (stocksOf.get(l.material) ?? 0) + 1)
  const out = new Map<string, Offer[]>()
  for (const q of quotes) {
    const mine = new Map<string, { quoted: number; estimate: number; lines: number; whole: boolean }>()
    for (const l of q.lines) {
      if (l.quoted == null) continue
      const m = l.material ?? materialOf.get(l.stock) ?? null
      if (!m) continue
      const cur = mine.get(m) ?? { quoted: 0, estimate: 0, lines: 0, whole: false }
      cur.quoted += l.quoted
      cur.estimate += l.estimate ?? 0
      cur.lines += 1
      // Captured by material: the row stands for all of it.
      cur.whole ||= l.stock === m
      mine.set(m, cur)
    }
    for (const [m, o] of mine) {
      const list = out.get(m) ?? []
      list.push({ supplier: q.supplier, quoted: o.quoted, estimate: o.estimate, partial: !o.whole && o.lines < (stocksOf.get(m) ?? 0) })
      out.set(m, list)
    }
  }
  const ratio = (o: Offer) => (o.estimate > 0 ? o.quoted / o.estimate : Infinity)
  for (const list of out.values()) list.sort((a, b) => ratio(a) - ratio(b) || a.quoted - b.quoted)
  return out
}

export interface Best {
  /** Cheapest offer per material, plus our estimate for whatever nobody quoted. */
  total: number
  /** Materials (or the rest of one) still at our estimate. */
  pending: string[]
}

/** The cheapest supplier per material, added up; null when no quote has a breakdown. */
export function bestCombination(materials: CostLine[], offers: Map<string, Offer[]>): Best | null {
  if (!offers.size) return null
  let total = 0
  const pending: string[] = []
  for (const m of materials) {
    const top = m.material ? offers.get(m.material)?.[0] : undefined
    const expected = m.estimate ?? 0
    if (!top) {
      total += expected
      pending.push(m.stock)
    } else if (top.partial) {
      total += top.quoted + Math.max(0, expected - top.estimate)
      pending.push(`resto de ${m.stock}`)
    } else total += top.quoted
  }
  return { total, pending }
}


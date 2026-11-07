// Nesting of rectangular blanks on whole sheets (Daniel, 2026-11-06: G10 comes in 12 × 24
// sheets of a given thickness; the blanks are laid out and cut in the shop with a band saw,
// jigsaw, water jet or laser). MaxRects with best-short-side fit and 90° rotation: good
// layouts for the few hundred pieces a project has, computed in the browser.

export interface NestItem {
  /** Who the piece belongs to (part id). */
  id: string
  label: string
  /** Blank in inches, as cut (without kerf). */
  width: number
  length: number
  quantity: number
}

export interface NestSheet {
  width: number
  length: number
  /** What the cut takes, inches. */
  kerf: number
  /** Unused edge all around, inches. */
  margin: number
}

export interface Placement {
  id: string
  label: string
  /** Position of the blank on the sheet, inches from the top-left corner. */
  x: number
  y: number
  /** Size as placed (swapped when rotated). */
  w: number
  h: number
  rotated: boolean
}

export interface NestResult {
  sheets: Placement[][]
  /** Pieces that do not fit on an empty sheet at all. */
  tooBig: { id: string; label: string; quantity: number }[]
  /** Blank area over sheet area, all sheets. */
  usage: number
}

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

const EPS = 1e-9

/** Places what fits on one sheet; returns the placements and leaves the rest in `todo`. */
type Rule = 'short' | 'long' | 'area' | 'corner'
const RULES: Rule[] = ['short', 'long', 'area', 'corner']

function fillSheet(
  todo: { item: NestItem; w: number; h: number }[],
  W: number,
  H: number,
  sheet: NestSheet,
  rule: Rule,
): Placement[] {
  let free: Rect[] = [{ x: 0, y: 0, w: W, h: H }]
  const placed: Placement[] = []
  for (let i = 0; i < todo.length; ) {
    const p = todo[i]!
    let best: { r: Rect; rot: boolean; score: number; long: number } | null = null
    for (const r of free) {
      for (const rot of [false, true]) {
        const w = rot ? p.h : p.w
        const h = rot ? p.w : p.h
        if (w > r.w + EPS || h > r.h + EPS) continue
        const short = Math.min(r.w - w, r.h - h)
        const longSide = Math.max(r.w - w, r.h - h)
        const score =
          rule === 'short' ? short : rule === 'long' ? longSide : rule === 'area' ? r.w * r.h - w * h : r.y + h + r.x / (W + 1)
        const long = rule === 'short' ? longSide : short
        if (!best || score < best.score - EPS || (Math.abs(score - best.score) < EPS && long < best.long)) {
          best = { r, rot, score, long }
        }
      }
    }
    if (!best) {
      i++
      continue
    }
    const w = best.rot ? p.h : p.w
    const h = best.rot ? p.w : p.h
    const used: Rect = { x: best.r.x, y: best.r.y, w, h }
    placed.push({
      id: p.item.id,
      label: p.item.label,
      x: used.x + sheet.margin,
      y: used.y + sheet.margin,
      // The kerf belongs to the cut, not the blank.
      w: w - sheet.kerf,
      h: h - sheet.kerf,
      rotated: best.rot,
    })
    todo.splice(i, 1)
    // Split every free rectangle the new one overlaps, then drop those inside others.
    const next: Rect[] = []
    for (const r of free) {
      if (used.x >= r.x + r.w - EPS || used.x + used.w <= r.x + EPS || used.y >= r.y + r.h - EPS || used.y + used.h <= r.y + EPS) {
        next.push(r)
        continue
      }
      if (used.x > r.x + EPS) next.push({ x: r.x, y: r.y, w: used.x - r.x, h: r.h })
      if (used.x + used.w < r.x + r.w - EPS) next.push({ x: used.x + used.w, y: r.y, w: r.x + r.w - used.x - used.w, h: r.h })
      if (used.y > r.y + EPS) next.push({ x: r.x, y: r.y, w: r.w, h: used.y - r.y })
      if (used.y + used.h < r.y + r.h - EPS) next.push({ x: r.x, y: used.y + used.h, w: r.w, h: r.y + r.h - used.y - used.h })
    }
    free = next.filter(
      (a, ai) =>
        !next.some(
          (b, bi) =>
            ai !== bi &&
            a.x >= b.x - EPS &&
            a.y >= b.y - EPS &&
            a.x + a.w <= b.x + b.w + EPS &&
            a.y + a.h <= b.y + b.h + EPS &&
            (ai > bi || a.w !== b.w || a.h !== b.h || a.x !== b.x || a.y !== b.y),
        ),
    )
  }
  return placed
}

/** Lays out every piece on as few sheets as it can. */
/** Rows across the sheet, each cut through from edge to edge, then the pieces in it: what a
 * band saw or jigsaw can follow. Tries both directions of the sheet. */
function shelfSheet(todo: { item: NestItem; w: number; h: number }[], W: number, H: number, sheet: NestSheet): Placement[] {
  const run = (across: number, along: number) => {
    const left = todo.slice()
    const placed: { x: number; y: number; w: number; h: number; p: (typeof todo)[number]; rot: boolean }[] = []
    let y = 0
    for (;;) {
      // Try every row height a remaining piece offers; keep the row that fills best.
      let best: { h: number; picks: { i: number; rot: boolean; w: number; h: number }[]; score: number } | null = null
      const heights = new Set<number>()
      for (const p of left) for (const hh of [p.h, p.w]) if (hh <= along - y + EPS) heights.add(hh)
      for (const rowH of heights) {
        let x = 0
        const picks: { i: number; rot: boolean; w: number; h: number }[] = []
        left.forEach((p, i) => {
          // The orientation that fits the row and takes the least width.
          const opts = [
            { rot: false, w: p.w, h: p.h },
            { rot: true, w: p.h, h: p.w },
          ].filter((o) => o.h <= rowH + EPS && o.w <= across - x + EPS)
          if (!opts.length) return
          const o = opts.sort((a, b) => a.w - b.w || b.h - a.h)[0]!
          picks.push({ i, ...o })
          x += o.w
        })
        if (!picks.length) continue
        const score = picks.reduce((s, k) => s + k.w * k.h, 0) / (rowH * across)
        if (!best || score > best.score + EPS) best = { h: rowH, picks, score }
      }
      if (!best) break
      let x = 0
      for (const k of best.picks) {
        placed.push({ x, y, w: k.w, h: k.h, p: left[k.i]!, rot: k.rot })
        x += k.w
      }
      const taken = new Set(best.picks.map((k) => k.i))
      for (let i = left.length - 1; i >= 0; i--) if (taken.has(i)) left.splice(i, 1)
      y += best.h
    }
    return { placed, left }
  }
  const a = run(W, H)
  const b = run(H, W)
  const area = (r: typeof a) => r.placed.reduce((s, q) => s + q.w * q.h, 0)
  const flip = area(b) > area(a) + EPS
  const r = flip ? b : a
  todo.splice(0, todo.length, ...r.left)
  return r.placed.map((q) => {
    // Rows run across the sheet width (a) or its length (b, drawn back on the sheet).
    const x = flip ? q.y : q.x
    const y = flip ? q.x : q.y
    const w = flip ? q.h : q.w
    const h = flip ? q.w : q.h
    return {
      id: q.p.item.id,
      label: q.p.item.label,
      x: x + sheet.margin,
      y: y + sheet.margin,
      w: w - sheet.kerf,
      h: h - sheet.kerf,
      rotated: q.rot !== flip,
    }
  })
}

export interface NestOptions {
  /** Only straight cuts from edge to edge (band saw, jigsaw). */
  guillotine?: boolean
  maxSheets?: number
}

export function nest(items: NestItem[], sheet: NestSheet, opts: NestOptions = {}): NestResult {
  const maxSheets = opts.maxSheets ?? 200
  // Each blank takes its kerf on one side; the usable area gains one kerf so the last
  // blank of a row needs no cut beyond the edge.
  const W = sheet.width - 2 * sheet.margin + sheet.kerf
  const H = sheet.length - 2 * sheet.margin + sheet.kerf
  const tooBig: NestResult['tooBig'] = []
  const todo: { item: NestItem; w: number; h: number }[] = []
  for (const item of items) {
    const w = item.width + sheet.kerf
    const h = item.length + sheet.kerf
    const n = Math.max(0, Math.ceil(item.quantity))
    if (!(w > 0 && h > 0) || n === 0) continue
    const fits = (w <= W + EPS && h <= H + EPS) || (h <= W + EPS && w <= H + EPS)
    if (!fits) {
      tooBig.push({ id: item.id, label: item.label, quantity: n })
      continue
    }
    for (let k = 0; k < n; k++) todo.push({ item, w, h })
  }
  // Big pieces first.
  todo.sort((a, b) => b.w * b.h - a.w * a.h || Math.max(b.w, b.h) - Math.max(a.w, a.h))
  const sheets: Placement[][] = []
  while (todo.length && sheets.length < maxSheets) {
    if (opts.guillotine) {
      const placed = shelfSheet(todo, W, H, sheet)
      if (!placed.length) break
      sheets.push(placed)
      continue
    }
    // Every rule on a copy; the sheet keeps the layout that places the most blank area.
    let best: { placed: Placement[]; left: typeof todo } | null = null
    for (const rule of RULES) {
      const left = todo.slice()
      const placed = fillSheet(left, W, H, sheet, rule)
      const area = placed.reduce((s, p) => s + p.w * p.h, 0)
      const bestArea = best ? best.placed.reduce((s, p) => s + p.w * p.h, 0) : -1
      if (area > bestArea + EPS) best = { placed, left }
    }
    if (!best || !best.placed.length) break
    sheets.push(best.placed)
    todo.splice(0, todo.length, ...best.left)
  }
  const blanks = sheets.flat().reduce((s, p) => s + p.w * p.h, 0)
  const area = sheets.length * sheet.width * sheet.length
  return { sheets, tooBig, usage: area > 0 ? blanks / area : 0 }
}

/** Common sheet sizes (inches) and what each cutting process takes. */
export const SHEET_SIZES: [number, number][] = [
  [12, 12],
  [12, 24],
  [24, 24],
  [24, 48],
  [48, 48],
  [48, 96],
]

export const CUT_PROCESSES: { name: string; kerf: number; guillotine: boolean }[] = [
  { name: 'Sierra cinta vertical', kerf: 0.125, guillotine: true },
  { name: 'Caladora', kerf: 0.125, guillotine: true },
  { name: 'Water jet', kerf: 0.04, guillotine: false },
  { name: 'Láser', kerf: 0.015, guillotine: false },
]

/** Saws and jigsaws need straight cuts through; water jet and laser follow any layout. */
export const isGuillotine = (process: string | null | undefined) =>
  CUT_PROCESSES.find((c) => c.name === process)?.guillotine ?? true

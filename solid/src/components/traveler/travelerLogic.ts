// Where each part is (Daniel, 2026-11-08). A part runs Material → Corte → Setup 1… →
// acabados → Calidad; it shows in every stage with its count, and it sits in the first stage
// it has not finished (its bucket), which is what holds it. Progress weighs pieces × stages,
// so a part of 30 pieces weighs more than one of 2. Finished = released by quality.
import type { PartStep, ProcessOperation, ProjectConcept } from '../../lib/api/types'

const norm = (s: string) => s.trim().toLowerCase()
const isMaterialOp = (n: string) => norm(n) === 'material'
const isCutOp = (n: string) => norm(n) === 'material habilitado'
const isProgramOp = (n: string) => norm(n) === 'programa'
const isSetupOp = (n: string) => norm(n).startsWith('setup')

export type StageState = 'done' | 'active' | 'waiting' | 'pending' | 'blocked'

export interface Stage {
  key: string
  label: string
  pieces: number
  total: number
  state: StageState
  /** "sin programa", "pedido", the reason it is held up… */
  note?: string
}

export type Bucket = 'material' | 'corte' | 'programa' | 'maquina' | 'acabados' | 'calidad' | 'terminada'

export const BUCKETS: { key: Bucket; label: string }[] = [
  { key: 'material', label: 'Esperando material' },
  { key: 'corte', label: 'En corte' },
  { key: 'programa', label: 'Esperando programa' },
  { key: 'maquina', label: 'En máquina' },
  { key: 'acabados', label: 'Acabados' },
  { key: 'calidad', label: 'En calidad' },
  { key: 'terminada', label: 'Terminadas' },
]

const READY_MATERIAL = new Set(['recibido', 'cortado', 'en_taller', 'surtido_por_cliente'])
const MATERIAL_NOTE: Record<string, string> = {
  pendiente: 'sin pedir',
  pedido: 'pedido',
  buscar: 'buscar en taller',
}

export interface PartView {
  part: ProjectConcept
  stages: Stage[]
  bucket: Bucket
  /** Steps held up, with what holds them. */
  blocked: { name: string; note: string | null }[]
  /** Pieces × stages done, and their total. */
  done: number
  total: number
}

function stepOf(c: ProjectConcept, op: ProcessOperation): PartStep | undefined {
  return c.process_steps.find((s) => s.operation_id === op.id)
}

export function partView(c: ProjectConcept, ops: ProcessOperation[]): PartView {
  const q = c.quantity
  const active = ops.filter((o) => o.is_active).sort((a, b) => a.position - b.position)
  const programaDone = active.some((o) => isProgramOp(o.name) && stepOf(c, o)?.state === 'done')
  const stages: Stage[] = []
  const blocked: PartView['blocked'] = []
  const piecesOf = (s: PartStep | undefined) => (s?.state === 'done' ? q : Math.min(q, s?.pieces ?? 0))

  // Material: ready when it arrived (or the client brings it) or its step is ✔.
  const matOp = active.find((o) => isMaterialOp(o.name))
  const matStep = matOp ? stepOf(c, matOp) : undefined
  if (matStep?.state !== 'not_applicable') {
    const ready = matStep?.state === 'done' || (c.material_status != null && READY_MATERIAL.has(c.material_status)) || !!c.material?.customer_supplied
    stages.push({
      key: 'material',
      label: 'Material',
      pieces: ready ? q : 0,
      total: q,
      state: ready ? 'done' : 'waiting',
      note: ready ? undefined : (c.material_status && MATERIAL_NOTE[c.material_status]) || 'sin material',
    })
  }

  // The catalog has Setup 1…4 and most parts take one or two: a setup nobody touched counts
  // only when it is the first one (the programmer adds the others in "Avance por setup").
  const setupOps = active.filter((o) => isSetupOp(o.name))
  const touched = setupOps.filter((o) => stepOf(c, o))
  const shownSetups = new Set((touched.length ? touched : setupOps.slice(0, 1)).map((o) => o.id))
  for (const op of active) {
    if (isMaterialOp(op.name) || isProgramOp(op.name)) continue
    if (isSetupOp(op.name) && !shownSetups.has(op.id)) continue
    const s = stepOf(c, op)
    if (s?.state === 'not_applicable') continue
    if (s?.state === 'blocked') blocked.push({ name: op.name, note: s.note ?? null })
    const pieces = piecesOf(s)
    const setup = isSetupOp(op.name)
    const programmed = setup && (programaDone || !!s?.programmed)
    const state: StageState =
      pieces >= q ? 'done' : s?.state === 'blocked' ? 'blocked' : pieces > 0 ? 'active' : setup && !programmed ? 'waiting' : 'pending'
    stages.push({
      key: op.id,
      label: isCutOp(op.name) ? 'Corte' : op.name,
      pieces,
      total: q,
      state,
      note: s?.state === 'blocked' ? s.note ?? 'detenido' : setup && !programmed && pieces < q ? 'sin programa' : undefined,
    })
  }

  const released = Math.min(q, c.released_quantity ?? 0)
  stages.push({ key: 'calidad', label: 'Calidad', pieces: released, total: q, state: released >= q ? 'done' : released > 0 ? 'active' : 'pending' })

  // A piece through a later stage went through the earlier ones (the checklist may never
  // have counted the cut): carry the count back.
  let carry = 0
  for (let i = stages.length - 1; i >= 0; i--) {
    const st = stages[i]
    if (st.key === 'material') {
      if (carry > 0 && st.state !== 'done') Object.assign(st, { pieces: q, state: 'done', note: undefined })
      continue
    }
    if (carry > st.pieces) {
      st.pieces = carry
      if (st.pieces >= q) Object.assign(st, { state: 'done', note: undefined })
      else if (st.state === 'pending' || st.state === 'waiting') st.state = 'active'
    }
    carry = Math.max(carry, st.pieces)
    // Pieces produced (every step ✔) went through every production stage.
    if (st.key === 'calidad') carry = Math.max(carry, Math.min(q, c.completed_quantity ?? 0))
  }

  // The first stage not finished is where the part waits.
  let bucket: Bucket = 'terminada'
  for (const st of stages) {
    if (st.state === 'done') continue
    if (st.key === 'material') bucket = 'material'
    else if (st.key === 'calidad') bucket = 'calidad'
    else if (st.label === 'Corte') bucket = 'corte'
    else if (/^setup/i.test(st.label)) bucket = st.note === 'sin programa' ? 'programa' : 'maquina'
    else bucket = 'acabados'
    break
  }

  const total = stages.reduce((s, st) => s + st.total, 0)
  const done = stages.reduce((s, st) => s + st.pieces, 0)
  return { part: c, stages, bucket, blocked, done, total }
}

export interface ProjectSummary {
  pieces: number
  done: number
  total: number
  /** Pieces released by quality. */
  released: number
  byBucket: Record<Bucket, number>
  blocked: number
}

export function summarize(views: PartView[]): ProjectSummary {
  const byBucket = Object.fromEntries(BUCKETS.map((b) => [b.key, 0])) as Record<Bucket, number>
  let pieces = 0
  let done = 0
  let total = 0
  let released = 0
  let blocked = 0
  for (const v of views) {
    byBucket[v.bucket]++
    pieces += v.part.quantity
    done += v.done
    total += v.total
    released += Math.min(v.part.quantity, v.part.released_quantity ?? 0)
    if (v.blocked.length) blocked++
  }
  return { pieces, done, total, released, byBucket, blocked }
}

/** Days until the delivery date (negative: late); null without one. */
export function daysLeft(iso: string | null | undefined, now = new Date()): number | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  // The date is stored as UTC midnight: read its calendar day in UTC, today in local time.
  const due = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())
  return Math.round((due - today) / 86_400_000)
}

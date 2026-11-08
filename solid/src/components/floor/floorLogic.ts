// Shop right now (Daniel, 2026-11-08): what each machine runs and who runs it, what each
// person is doing, and what is held up. Pure, so it runs against real data without a browser.
import type { FloorPerson, PlantMachine } from '../../lib/api/types'

/** A state set by hand this old, with no DNC to confirm it, is asked about ("¿sigue así?"). */
export const STALE_HOURS = 12
const SHOP_OFFSET_MS = -7 * 3_600_000

export const hoursSince = (iso: string | null, now: number): number | null =>
  iso ? Math.max(0, (now - new Date(iso).getTime()) / 3_600_000) : null

export function agoText(hours: number | null): string {
  if (hours == null) return ''
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min`
  if (hours < 24) return `${Math.round(hours)} h`
  const d = Math.round(hours / 24)
  return `${d} ${d === 1 ? 'día' : 'días'}`
}

export type MachineKind = 'working' | 'setup' | 'stopped' | 'none'

export interface MachineRow {
  m: PlantMachine
  kind: MachineKind
  hours: number | null
  /** Set by hand long ago as running: probably nobody changed it. */
  stale: boolean
  /** Not running while work waits in its queue. */
  idleWithQueue: boolean
}

export function machineRow(m: PlantMachine, now: number): MachineRow {
  const kind: MachineKind = m.status ?? 'none'
  const hours = hoursSince(m.since, now)
  const running = kind === 'working' || kind === 'setup'
  return {
    m,
    kind,
    hours,
    stale: running && m.source === 'manual' && hours != null && hours > STALE_HOURS,
    idleWithQueue: !running && m.queue.length > 0,
  }
}

export type PersonKind =
  | 'machine' // runs a machine
  | 'assigned' // holds work orders
  | 'idle' // in the shop with nothing
  | 'not_in' // their shift started and they have not checked in
  | 'later' // their shift starts later today
  | 'left' // checked out
  | 'absent' // their shift ended without a check
  | 'off' // not a work day
  | 'unknown' // nothing assigned, and we cannot tell whether they are here

export interface PersonRow {
  p: FloorPerson
  kind: PersonKind
  machines: PlantMachine[]
  /** "entró 6:55", "salió 14:30", "entra 14:00"… */
  clock: string | null
}

/** Minutes since shop midnight (Hermosillo, UTC-7 all year). */
export const shopMinute = (now: number) => Math.floor((((now + SHOP_OFFSET_MS) % 86_400_000) + 86_400_000) % 86_400_000 / 60_000)
const minuteOf = (hm: string) => {
  const [h, m] = hm.split(':').map(Number)
  return h * 60 + (m || 0)
}

export function personRow(p: FloorPerson, machines: PlantMachine[], withAttendance: boolean, now: number): PersonRow {
  const mine = p.user_id
    ? machines.filter((m) => m.running_by?.id === p.user_id && (m.status === 'working' || m.status === 'setup'))
    : []
  const a = withAttendance && p.in_clock ? p.attendance : null
  const checks = a?.checks ?? []
  const start = a?.window?.split('–')[0] ?? null
  let clock: string | null = null
  let presence: PersonKind | null = null // what the clock says, when it says something
  let inside: boolean | null = null
  if (withAttendance && p.in_clock) {
    if (checks.length > 0) {
      inside = checks.length % 2 === 1
      clock = inside
        ? `entró ${checks[0]}${a?.late_min ? ` · ${a.late_min} min tarde` : ''}`
        : `salió ${checks[checks.length - 1]}`
      if (!inside) presence = 'left'
    } else if (a?.status === 'falta') {
      presence = 'absent'
      clock = 'no vino'
    } else if (a?.status === 'descanso') {
      presence = 'off'
      clock = 'descansa hoy'
    } else if (start) {
      const late = shopMinute(now) > minuteOf(start)
      presence = late ? 'not_in' : 'later'
      clock = late ? `no ha checado (entra ${start})` : `entra ${start}`
      inside = false
    } else {
      clock = 'sin checadas hoy'
    }
  }
  let kind: PersonKind
  if (mine.length) kind = 'machine'
  else if (presence) kind = presence
  else if (p.orders.length) kind = 'assigned'
  else if (inside) kind = 'idle'
  else kind = 'unknown'
  return { p, kind, machines: mine, clock }
}

/** Order on screen: what needs a look first. */
export const PERSON_ORDER: PersonKind[] = ['idle', 'not_in', 'machine', 'assigned', 'unknown', 'later', 'left', 'absent', 'off']

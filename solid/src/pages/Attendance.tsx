// Asistencia — the shop's time clock (Hikvision fingerprint terminal). The agent on the shop PC
// pushes the checks; here the admin sees, per week, each person's entry and exit, lateness, hours
// and absences, and registers who is in the clock and their shift. Admins only: it says who came
// and when. The clock does not mark in/out: first check = entry, last = exit.
import { createMutation, createQuery, useQueryClient } from '@tanstack/solid-query'
import { ChevronLeft, ChevronRight, Pencil, Plus, Trash2 } from 'lucide-solid'
import { type JSX, For, Show, createMemo, createSignal } from 'solid-js'

import { Button } from '../components/ui/Button'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/Card'
import { Checkbox } from '../components/ui/Checkbox'
import { Input } from '../components/ui/Input'
import { Modal } from '../components/ui/Modal'
import { PageHeader } from '../components/ui/PageHeader'
import { Select } from '../components/ui/Select'
import { Spinner } from '../components/ui/Spinner'
import { Table, TableBody, TableCell, TableHead, TableHeadCell, TableRow } from '../components/ui/Table'
import { toast } from '../components/ui/Toast'
import { listUsers } from '../lib/api/admin'
import {
  type AttendanceDay,
  type AttendanceEmployee,
  type AttendanceShift,
  type AttendanceStatus,
  type ShiftWindow,
  addManualCheck,
  deleteAttendanceEmployee,
  deleteManualCheck,
  getAttendanceReport,
  listAttendanceEmployees,
  saveAttendanceEmployee,
  saveCorrection,
} from '../lib/api/attendance'
import { humanizeError } from '../lib/api/client'

const STATUS: Record<AttendanceStatus, { label: string; class: string }> = {
  ok: { label: 'A tiempo', class: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' },
  retardo: { label: 'Retardo', class: 'bg-amber-500/15 text-amber-700 dark:text-amber-300' },
  falta: { label: 'Falta', class: 'bg-red-500/15 text-red-700 dark:text-red-300' },
  incompleto: { label: 'Sin salida', class: 'bg-orange-500/15 text-orange-700 dark:text-orange-300' },
  pendiente: { label: 'En turno', class: 'bg-sky-500/15 text-sky-700 dark:text-sky-300' },
  extra: { label: 'Día extra', class: 'bg-violet-500/15 text-violet-700 dark:text-violet-300' },
  descanso: { label: 'Descanso', class: 'text-muted-foreground' },
  sin_horario: { label: '', class: '' },
  antes_alta: { label: 'Aún no entraba', class: 'text-muted-foreground' },
}

const DAYS = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom']

// The shop's two shifts (Daniel, 2026-11-07).
const SHIFT_PRESETS: Record<'manana' | 'tarde', AttendanceShift> = {
  manana: { start: '07:00', end: '15:00', days: [1, 2, 3, 4, 5], tolerance_min: 10, other: [{ days: [6], start: '07:00', end: '12:00' }] },
  tarde: { start: '14:00', end: '22:00', days: [1, 2, 3, 4, 5], tolerance_min: 10, other: [{ days: [6], start: '12:00', end: '17:00' }] },
}

const horas = (min: number): string => {
  const m = Math.round(min)
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`
}

/** YYYY-MM-DD of a local Date (the browser is in the shop's time zone). */
const ymd = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

const mondayOf = (d: Date): Date => {
  const out = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  out.setDate(out.getDate() - ((out.getDay() + 6) % 7))
  return out
}

const addDays = (s: string, n: number): string => {
  const d = new Date(`${s}T12:00:00`)
  d.setDate(d.getDate() + n)
  return ymd(d)
}

const diaCorto = (s: string): string =>
  new Date(`${s}T12:00:00`).toLocaleDateString('es-MX', { weekday: 'short', day: 'numeric' })

const rango = (from: string, to: string): string => {
  const f = new Date(`${from}T12:00:00`)
  const t = new Date(`${to}T12:00:00`)
  const opt: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' }
  return `${f.toLocaleDateString('es-MX', opt)} – ${t.toLocaleDateString('es-MX', { ...opt, year: 'numeric' })}`
}

const dias = (days: number[]): string =>
  days.length === 5 && days.every((d, i) => d === i + 1) ? 'L–V' : days.map((d) => DAYS[d - 1]).join(', ')

/** "L–V 14:00–22:00 · Sáb 12:00–17:00" */
const ventanas = (s: AttendanceShift): string =>
  [{ days: s.days, start: s.start, end: s.end }, ...(s.other ?? [])].map((w) => `${dias(w.days)} ${w.start}–${w.end}`).join(' · ')

/** "Mañana" / "Tarde" when the shift is one of the shop's, else its windows. */
const nombreTurno = (s: AttendanceShift): string => {
  const same = (p: AttendanceShift) => ventanas(p) === ventanas(s)
  return same(SHIFT_PRESETS.manana) ? 'Mañana' : same(SHIFT_PRESETS.tarde) ? 'Tarde' : ventanas(s)
}

const turno = (e: AttendanceEmployee): string => {
  if (!e.shift) return 'Sin horario fijo'
  const flex = (e.alternates ?? []).map(nombreTurno)
  return `${ventanas(e.shift)} · tolerancia ${e.shift.tolerance_min} min${flex.length ? ` · también puede: ${flex.join(', ')}` : ''}`
}

const pesos = (v: number): string =>
  v.toLocaleString('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 2, maximumFractionDigits: 2 })

function InternBadge(): JSX.Element {
  return (
    <span class="ml-2 rounded-full bg-sky-500/15 px-2 py-0.5 align-middle text-[11px] font-medium text-sky-700 dark:text-sky-300">
      Practicante
    </span>
  )
}

function DayCell(props: { day: AttendanceDay; onDeleteManual: (id: string) => void; onCorrect: () => void }): JSX.Element {
  const st = () => STATUS[props.day.status]
  const fix = () => props.day.correction
  return (
    <TableCell class="group align-top">
      <div class="space-y-0.5 text-xs">
        <div class="flex items-start justify-between gap-1">
          <Show when={props.day.entry} fallback={<span />}>
            <p class="tnum text-foreground">
              {props.day.entry} – {props.day.exit ?? '¿?'}
              <Show when={props.day.overnight}>
                <span class="ml-1 text-[11px] text-muted-foreground" title="Salió después de medianoche">
                  (+1 día)
                </span>
              </Show>
            </p>
          </Show>
          <button
            type="button"
            class="rounded p-0.5 text-muted-foreground opacity-40 hover:bg-muted hover:text-foreground hover:opacity-100 focus:opacity-100 group-hover:opacity-100"
            aria-label={`Corregir entrada o salida del ${props.day.date}`}
            title="Corregir entrada / salida"
            onClick={() => props.onCorrect()}
          >
            <Pencil class="h-3 w-3" />
          </button>
        </div>
        <Show when={fix()}>
          {(c) => (
            <p
              class="text-violet-700 dark:text-violet-300"
              title={[c().note, `por ${c().author}`, props.day.checks.length ? `checador: ${props.day.checks.join(', ')}` : 'sin checadas'].filter(Boolean).join(' · ')}
            >
              corregido{c().note ? ` · ${c().note}` : ''}
            </p>
          )}
        </Show>
        <Show when={props.day.alternate && props.day.window}>
          <p class="text-muted-foreground">turno {props.day.window}</p>
        </Show>
        <For each={props.day.manual ?? []}>
          {(m) => (
            <p class="flex items-center gap-1 text-violet-700 dark:text-violet-300" title={[m.note, m.author && `por ${m.author}`].filter(Boolean).join(' · ')}>
              <span class="tnum">{m.time}</span>
              <span>manual</span>
              <button
                type="button"
                class="rounded px-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label={`Borrar checada manual de las ${m.time}`}
                onClick={() => {
                  if (confirm(`¿Borrar la checada manual de las ${m.time}?`)) props.onDeleteManual(m.id)
                }}
              >
                ×
              </button>
            </p>
          )}
        </For>
        <Show when={props.day.worked_min > 0}>
          <p class="tnum text-muted-foreground">{horas(props.day.worked_min)}</p>
        </Show>
        <Show when={st().label}>
          <span class={`inline-block rounded px-1.5 py-px font-medium ${st().class}`}>
            {st().label}
            {props.day.late_min > 0 ? ` +${props.day.late_min} min` : ''}
          </span>
        </Show>
        <Show when={props.day.checks.length > 2}>
          <p class="text-muted-foreground" title={props.day.checks.join(', ')}>
            {props.day.checks.length} checadas
          </p>
        </Show>
      </div>
    </TableCell>
  )
}

export default function Attendance(): JSX.Element {
  const qc = useQueryClient()
  const [from, setFrom] = createSignal(ymd(mondayOf(new Date())))
  const to = () => addDays(from(), 6)
  const report = createQuery(() => ({
    queryKey: ['attendance-report', from()],
    queryFn: () => getAttendanceReport(from(), to()),
    refetchInterval: 300_000,
  }))
  const employees = createQuery(() => ({ queryKey: ['attendance-employees'], queryFn: listAttendanceEmployees }))
  const [editing, setEditing] = createSignal<AttendanceEmployee | null>(null)
  const thisWeek = () => from() === ymd(mondayOf(new Date()))

  const remove = createMutation(() => ({
    mutationFn: (no: string) => deleteAttendanceEmployee(no),
    onSuccess: () => {
      toast.success('Empleado quitado', 'Sus checadas se conservan')
      void qc.invalidateQueries({ queryKey: ['attendance-employees'] })
      void qc.invalidateQueries({ queryKey: ['attendance-report'] })
    },
    onError: (err) => toast.error('No se pudo quitar', humanizeError(err, '')),
  }))
  const [manualOpen, setManualOpen] = createSignal(false)
  const [correcting, setCorrecting] = createSignal<{ employee_no: string; name: string; day: AttendanceDay } | null>(null)
  const removeManual = createMutation(() => ({
    mutationFn: (id: string) => deleteManualCheck(id),
    onSuccess: () => {
      toast.success('Checada manual borrada')
      void qc.invalidateQueries({ queryKey: ['attendance-report'] })
    },
    onError: (err) => toast.error('No se pudo borrar', humanizeError(err, '')),
  }))

  return (
    <div class="space-y-6">
      <PageHeader
        title="Asistencia"
        subtitle="Checadas del checador del taller: entrada, salida, retardos y horas"
        breadcrumb={['Operaciones']}
        actions={
          <div class="flex items-center gap-1">
            <Button variant="outline" aria-label="Semana anterior" onClick={() => setFrom(addDays(from(), -7))}>
              <ChevronLeft class="h-4 w-4" />
            </Button>
            <span class="tnum min-w-44 text-center text-sm text-foreground">{rango(from(), to())}</span>
            <Button variant="outline" aria-label="Semana siguiente" onClick={() => setFrom(addDays(from(), 7))}>
              <ChevronRight class="h-4 w-4" />
            </Button>
            <Show when={!thisWeek()}>
              <Button variant="ghost" onClick={() => setFrom(ymd(mondayOf(new Date())))}>
                Esta semana
              </Button>
            </Show>
            <Button variant="outline" onClick={() => setManualOpen(true)}>
              <Plus class="mr-1.5 h-4 w-4" />
              Checada manual
            </Button>
          </div>
        }
      />

      <Show
        when={!report.isLoading}
        fallback={
          <div class="flex items-center justify-center gap-2 py-16 text-muted-foreground">
            <Spinner />
            <span>Cargando…</span>
          </div>
        }
      >
        <Card glass>
          <CardHeader>
            <CardTitle>Semana</CardTitle>
          </CardHeader>
          <Show
            when={(report.data?.employees ?? []).length > 0}
            fallback={
              <CardContent class="py-8 text-center text-sm text-muted-foreground">
                Registra abajo a las personas del checador para ver su asistencia.
              </CardContent>
            }
          >
            <div class="overflow-x-auto">
              <Table>
                <TableHead>
                  <TableRow>
                    <TableHeadCell>Persona</TableHeadCell>
                    <For each={report.data?.employees[0]?.days ?? []}>{(d) => <TableHeadCell>{diaCorto(d.date)}</TableHeadCell>}</For>
                    <TableHeadCell>Horas</TableHeadCell>
                    <TableHeadCell>Retardos</TableHeadCell>
                    <TableHeadCell>Faltas</TableHeadCell>
                    <Show when={(report.data?.employees ?? []).some((e) => e.earned != null)}>
                      <TableHeadCell>Acumulado</TableHeadCell>
                    </Show>
                  </TableRow>
                </TableHead>
                <TableBody>
                  <For each={report.data?.employees ?? []}>
                    {(e) => (
                      <TableRow>
                        <TableCell class="align-top">
                          <p class="font-medium text-foreground">
                            {e.name}
                            <Show when={e.intern}>
                              <InternBadge />
                            </Show>
                          </p>
                          <p class="text-xs text-muted-foreground">
                            #{e.employee_no}
                            {e.shift ? ` · ${ventanas(e.shift)}` : ''}
                          </p>
                        </TableCell>
                        <For each={e.days}>
                          {(d) => (
                            <DayCell
                              day={d}
                              onDeleteManual={(id) => removeManual.mutate(id)}
                              onCorrect={() => setCorrecting({ employee_no: e.employee_no, name: e.name, day: d })}
                            />
                          )}
                        </For>
                        <TableCell class="tnum align-top font-medium">{horas(e.totals.worked_min)}</TableCell>
                        <TableCell class="tnum align-top">
                          {e.totals.late_days > 0 ? `${e.totals.late_days} (${e.totals.late_min} min)` : e.shift ? '0' : '—'}
                        </TableCell>
                        <TableCell class="tnum align-top">
                          {e.shift ? e.totals.absences + (e.totals.incomplete ? ` · ${e.totals.incomplete} sin salida` : '') : '—'}
                        </TableCell>
                        <Show when={(report.data?.employees ?? []).some((x) => x.earned != null)}>
                          <TableCell class="tnum align-top whitespace-nowrap">
                            <Show when={e.earned != null} fallback="—">
                              <p class="font-medium text-foreground">{pesos(e.earned ?? 0)}</p>
                              <p class="text-xs text-muted-foreground">
                                {pesos(e.hourly_rate ?? 0)}/h
                                {e.overtime_min ? ` · ${horas(e.overtime_min)} extra al doble` : ''}
                              </p>
                            </Show>
                          </TableCell>
                        </Show>
                      </TableRow>
                    )}
                  </For>
                </TableBody>
              </Table>
            </div>
          </Show>
          <Show when={(report.data?.unknown ?? []).length > 0}>
            <CardContent class="text-xs text-amber-700 dark:text-amber-300">
              Checadas de números que no están registrados aquí:{' '}
              {report.data?.unknown.map((u) => `#${u.employee_no} (${u.checks})`).join(', ')}
            </CardContent>
          </Show>
        </Card>
      </Show>

      <Card glass>
        <CardHeader class="flex flex-row items-center justify-between">
          <CardTitle>Personas en el checador</CardTitle>
          <Button
            variant="outline"
            onClick={() =>
              setEditing({
                employee_no: '',
                name: '',
                user_id: null,
                shift: SHIFT_PRESETS.tarde,
                active: true,
                start_date: ymd(new Date()),
              })
            }
          >
            <Plus class="mr-1.5 h-4 w-4" />
            Agregar
          </Button>
        </CardHeader>
        <Show when={!employees.isLoading} fallback={<Spinner />}>
          <Table>
            <TableHead>
              <TableRow>
                <TableHeadCell>No.</TableHeadCell>
                <TableHeadCell>Nombre</TableHeadCell>
                <TableHeadCell>Horario</TableHeadCell>
                <TableHeadCell>
                  <span class="sr-only">Acciones</span>
                </TableHeadCell>
              </TableRow>
            </TableHead>
            <TableBody>
              <For each={employees.data ?? []}>
                {(e) => (
                  <TableRow>
                    <TableCell class="tnum">{e.employee_no}</TableCell>
                    <TableCell class={e.active ? 'font-medium text-foreground' : 'text-muted-foreground line-through'}>
                      {e.name}
                      <Show when={e.intern}>
                        <InternBadge />
                      </Show>
                    </TableCell>
                    <TableCell class="text-sm">{turno(e)}</TableCell>
                    <TableCell class="whitespace-nowrap text-right">
                      <Button variant="ghost" aria-label={`Editar a ${e.name}`} onClick={() => setEditing({ ...e })}>
                        <Pencil class="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        aria-label={`Quitar a ${e.name}`}
                        disabled={remove.isPending}
                        onClick={() => {
                          if (confirm(`¿Quitar a ${e.name} de la asistencia? Sus checadas se conservan.`)) remove.mutate(e.employee_no)
                        }}
                      >
                        <Trash2 class="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                )}
              </For>
            </TableBody>
          </Table>
        </Show>
      </Card>

      <Show when={editing()}>{(e) => <EmployeeForm initial={e()} onClose={() => setEditing(null)} />}</Show>
      <Show when={manualOpen()}>
        <ManualCheckForm employees={(employees.data ?? []).filter((e) => e.active)} onClose={() => setManualOpen(false)} />
      </Show>
      <Show when={correcting()}>{(c) => <CorrectionForm {...c()} onClose={() => setCorrecting(null)} />}</Show>
    </div>
  )
}

/** Fix one day's entry and/or exit (Daniel, 2026-11-09). The real checks stay; empty = use the clock's. */
function CorrectionForm(props: { employee_no: string; name: string; day: AttendanceDay; onClose: () => void }): JSX.Element {
  const qc = useQueryClient()
  const fix = props.day.correction
  const [entry, setEntry] = createSignal(fix?.entry ?? '')
  const [exit, setExit] = createSignal(fix?.exit ?? '')
  const [note, setNote] = createSignal(fix?.note ?? '')
  // an exit before 06:00 is the next morning (overnight)
  const nextMorning = () => exit() !== '' && exit() < '06:00'
  const valid = () => (entry() !== '' || exit() !== '') && (!entry() || !exit() || nextMorning() || entry() < exit())

  const save = createMutation(() => ({
    mutationFn: (clear: boolean) =>
      saveCorrection({
        employee_no: props.employee_no,
        date: props.day.date,
        entry: clear ? null : entry() || null,
        exit: clear ? null : exit() || null,
        note: clear ? null : note().trim() || null,
      }),
    onSuccess: (_d, clear) => {
      toast.success(clear ? 'Corrección quitada' : 'Día corregido')
      void qc.invalidateQueries({ queryKey: ['attendance-report'] })
      props.onClose()
    },
    onError: (err) => toast.error('No se pudo guardar', humanizeError(err, 'Revisa los datos')),
  }))

  return (
    <Modal open onOpenChange={(o) => !o && props.onClose()} title={`Corregir ${diaCorto(props.day.date)} · ${props.name}`}>
      <form
        class="space-y-4"
        onSubmit={(ev) => {
          ev.preventDefault()
          if (valid()) save.mutate(false)
        }}
      >
        <p class="text-sm text-muted-foreground">
          Checador: {props.day.checks.length ? props.day.checks.join(', ') : 'sin checadas'}. Las checadas no se borran; el reporte usa la hora que pongas aquí.
        </p>
        <div class="grid grid-cols-2 gap-2">
          <label class="space-y-1">
            <span class="text-sm font-medium text-foreground">Entrada</span>
            <Input type="time" value={entry()} onInput={setEntry} />
          </label>
          <label class="space-y-1">
            <span class="text-sm font-medium text-foreground">Salida</span>
            <Input type="time" value={exit()} onInput={setExit} />
          </label>
        </div>
        <p class="text-xs text-muted-foreground">
          Deja vacía la que esté bien: se toma la del checador. Una salida antes de las 6:00 es la madrugada siguiente (se quedaron
          de noche).
        </p>
        <Show when={nextMorning()}>
          <p class="text-xs text-sky-700 dark:text-sky-300">Salida al día siguiente a las {exit()}.</p>
        </Show>
        <Show when={entry() && exit() && !nextMorning() && entry() >= exit()}>
          <p class="text-xs text-red-600">La salida debe ser después de la entrada.</p>
        </Show>
        <label class="block space-y-1">
          <span class="text-sm font-medium text-foreground">Nota</span>
          <Input value={note()} onInput={setNote} maxLength={200} placeholder="Ej. llegó a las 7, todavía no tenía huella" />
        </label>
        <div class="flex items-center justify-between gap-2">
          <div>
            <Show when={fix}>
              <Button type="button" variant="ghost" disabled={save.isPending} onClick={() => save.mutate(true)}>
                Quitar corrección
              </Button>
            </Show>
          </div>
          <div class="flex gap-2">
            <Button type="button" variant="ghost" onClick={() => props.onClose()}>
              Cancelar
            </Button>
            <Button type="submit" disabled={!valid() || save.isPending}>
              {save.isPending ? 'Guardando…' : 'Guardar'}
            </Button>
          </div>
        </div>
      </form>
    </Modal>
  )
}

/** Entry (and optional exit) typed by the admin: forgotten check, no fingerprint yet… */
function ManualCheckForm(props: { employees: AttendanceEmployee[]; onClose: () => void }): JSX.Element {
  const qc = useQueryClient()
  const [no, setNo] = createSignal(props.employees[0]?.employee_no ?? '')
  const [date, setDate] = createSignal(ymd(new Date()))
  const [entry, setEntry] = createSignal('')
  const [exit, setExit] = createSignal('')
  const [note, setNote] = createSignal('')
  const valid = () => no() !== '' && date() !== '' && (entry() !== '' || exit() !== '') && (!entry() || !exit() || entry() < exit())

  const save = createMutation(() => ({
    mutationFn: async () => {
      for (const time of [entry(), exit()].filter(Boolean)) {
        await addManualCheck({ employee_no: no(), date: date(), time, note: note().trim() || null })
      }
    },
    onSuccess: () => {
      toast.success('Checada guardada')
      void qc.invalidateQueries({ queryKey: ['attendance-report'] })
      props.onClose()
    },
    onError: (err) => {
      void qc.invalidateQueries({ queryKey: ['attendance-report'] })
      toast.error('No se pudo guardar', humanizeError(err, 'Revisa los datos'))
    },
  }))

  return (
    <Modal open onOpenChange={(o) => !o && props.onClose()} title="Checada manual">
      <form
        class="space-y-4"
        onSubmit={(ev) => {
          ev.preventDefault()
          if (valid()) save.mutate()
        }}
      >
        <p class="text-sm text-muted-foreground">
          Para cuando alguien olvidó checar o todavía no tiene huella. Queda marcada como manual, con tu nombre y la nota.
        </p>
        <label class="block space-y-1">
          <span class="text-sm font-medium text-foreground">Persona</span>
          <Select value={no()} onChange={setNo}>
            <For each={props.employees}>{(e) => <option value={e.employee_no}>{`${e.name} (#${e.employee_no})`}</option>}</For>
          </Select>
        </label>
        <label class="block space-y-1">
          <span class="text-sm font-medium text-foreground">Día</span>
          <Input type="date" value={date()} onInput={setDate} />
        </label>
        <div class="grid grid-cols-2 gap-2">
          <label class="space-y-1">
            <span class="text-sm font-medium text-foreground">Entrada</span>
            <Input type="time" value={entry()} onInput={setEntry} />
          </label>
          <label class="space-y-1">
            <span class="text-sm font-medium text-foreground">Salida</span>
            <Input type="time" value={exit()} onInput={setExit} />
          </label>
        </div>
        <Show when={entry() && exit() && entry() >= exit()}>
          <p class="text-xs text-red-600">La salida debe ser después de la entrada.</p>
        </Show>
        <label class="block space-y-1">
          <span class="text-sm font-medium text-foreground">Nota</span>
          <Input value={note()} onInput={setNote} maxLength={200} placeholder="Ej. vino 7–12, todavía sin huella" />
        </label>
        <div class="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => props.onClose()}>
            Cancelar
          </Button>
          <Button type="submit" disabled={!valid() || save.isPending}>
            {save.isPending ? 'Guardando…' : 'Guardar'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}

function EmployeeForm(props: { initial: AttendanceEmployee; onClose: () => void }): JSX.Element {
  const qc = useQueryClient()
  const isNew = props.initial.employee_no === ''
  const users = createQuery(() => ({ queryKey: ['users'], queryFn: listUsers }))
  const [no, setNo] = createSignal(props.initial.employee_no)
  const [name, setName] = createSignal(props.initial.name)
  const [userId, setUserId] = createSignal(props.initial.user_id ?? '')
  const [hasShift, setHasShift] = createSignal(!!props.initial.shift)
  const [start, setStart] = createSignal(props.initial.shift?.start ?? '14:00')
  const [end, setEnd] = createSignal(props.initial.shift?.end ?? '22:00')
  const [days, setDays] = createSignal<number[]>(props.initial.shift?.days ?? [1, 2, 3, 4, 5])
  const [tolerance, setTolerance] = createSignal(String(props.initial.shift?.tolerance_min ?? 10))
  const [others, setOthers] = createSignal<ShiftWindow[]>(props.initial.shift?.other ?? [])
  // Flexibility: the shop shifts (by preset key) they may also work.
  const [flex, setFlex] = createSignal<('manana' | 'tarde')[]>(
    (props.initial.alternates ?? []).flatMap((a) => {
      const n = nombreTurno(a)
      return n === 'Mañana' ? ['manana' as const] : n === 'Tarde' ? ['tarde' as const] : []
    }),
  )
  const toggleFlex = (k: 'manana' | 'tarde', on: boolean) => setFlex(on ? [...flex().filter((x) => x !== k), k] : flex().filter((x) => x !== k))
  const [active, setActive] = createSignal(props.initial.active)
  const [startDate, setStartDate] = createSignal(props.initial.start_date ?? '')
  const [intern, setIntern] = createSignal(props.initial.intern ?? false)
  const [weeklyPay, setWeeklyPay] = createSignal(props.initial.weekly_pay != null ? String(props.initial.weekly_pay) : '')
  const [weeklyHours, setWeeklyHours] = createSignal(props.initial.weekly_hours != null ? String(props.initial.weekly_hours) : '45')
  const num = (v: string): number | null => (v.trim() === '' || !Number.isFinite(Number(v)) ? null : Number(v))

  const valid = createMemo(
    () =>
      no().trim() !== '' &&
      name().trim() !== '' &&
      (!hasShift() || (days().length > 0 && start() < end() && others().every((w) => w.days.length > 0 && w.start < w.end))),
  )

  const applyPreset = (p: AttendanceShift) => {
    setStart(p.start)
    setEnd(p.end)
    setDays(p.days)
    setOthers(p.other ?? [])
  }
  /** A day belongs to one schedule only: picking it in one removes it from the others. */
  const toggleMain = (d: number) => {
    if (days().includes(d)) setDays(days().filter((x) => x !== d))
    else {
      setDays([...days(), d])
      setOthers(others().map((w) => ({ ...w, days: w.days.filter((x) => x !== d) })))
    }
  }
  const toggleOther = (i: number, d: number) => {
    const w = others()[i]
    if (w.days.includes(d)) {
      setOthers(others().map((o, j) => (j === i ? { ...o, days: o.days.filter((x) => x !== d) } : o)))
    } else {
      setDays(days().filter((x) => x !== d))
      setOthers(others().map((o, j) => (j === i ? { ...o, days: [...o.days, d] } : { ...o, days: o.days.filter((x) => x !== d) })))
    }
  }
  const setOther = (i: number, patch: Partial<ShiftWindow>) => setOthers(others().map((o, j) => (j === i ? { ...o, ...patch } : o)))

  const save = createMutation(() => ({
    mutationFn: () =>
      saveAttendanceEmployee({
        employee_no: no().trim(),
        name: name().trim(),
        user_id: userId() || null,
        shift: hasShift()
          ? {
              start: start(),
              end: end(),
              days: [...days()].sort(),
              tolerance_min: Math.max(0, Number(tolerance()) || 0),
              other: others()
                .filter((w) => w.days.length > 0)
                .map((w) => ({ ...w, days: [...w.days].sort() })),
            }
          : null,
        alternates: hasShift() ? flex().map((k) => ({ ...SHIFT_PRESETS[k], tolerance_min: Math.max(0, Number(tolerance()) || 0) })) : [],
        active: active(),
        start_date: startDate(),
        intern: intern(),
        weekly_pay: num(weeklyPay()),
        weekly_hours: num(weeklyHours()),
      }),
    onSuccess: () => {
      toast.success('Guardado')
      void qc.invalidateQueries({ queryKey: ['attendance-employees'] })
      void qc.invalidateQueries({ queryKey: ['attendance-report'] })
      props.onClose()
    },
    onError: (err) => toast.error('No se pudo guardar', humanizeError(err, 'Revisa los datos')),
  }))

  const chip =(on: boolean) =>
    `h-8 w-11 rounded-md border text-xs ${on ? 'border-primary bg-primary/15 text-foreground' : 'border-border text-muted-foreground hover:bg-muted'}`

  return (
    <Modal open onOpenChange={(o) => !o && props.onClose()} title={isNew ? 'Agregar persona al checador' : `Editar a ${props.initial.name}`}>
      <form
        class="space-y-4"
        onSubmit={(ev) => {
          ev.preventDefault()
          if (valid()) save.mutate()
        }}
      >
        <label class="block space-y-1">
          <span class="text-sm font-medium text-foreground">Número en el checador</span>
          <Input value={no()} onInput={setNo} disabled={!isNew} placeholder="0004" inputmode="numeric" />
          <span class="text-xs text-muted-foreground">El mismo "Employee No." que tiene en el aparato.</span>
        </label>
        <label class="block space-y-1">
          <span class="text-sm font-medium text-foreground">Nombre</span>
          <Input value={name()} onInput={setName} placeholder="José Manuel Márquez Valle" />
        </label>
        <label class="block space-y-1">
          <span class="text-sm font-medium text-foreground">Usuario de la plataforma (opcional)</span>
          <Select value={userId()} onChange={setUserId}>
            <option value="">— Ninguno —</option>
            <For each={users.data ?? []}>{(u) => <option value={u.id}>{u.display_name || u.username}</option>}</For>
          </Select>
        </label>

        <Checkbox checked={hasShift()} onChange={setHasShift} label="Tiene horario fijo (cuenta retardos y faltas)" />
        <Show when={hasShift()}>
          <div class="space-y-3 rounded-lg border border-border p-3">
            <div class="flex flex-wrap items-center gap-2">
              <span class="text-xs text-muted-foreground">Turnos del taller:</span>
              <Button type="button" variant="outline" onClick={() => applyPreset(SHIFT_PRESETS.manana)}>
                Mañana
              </Button>
              <Button type="button" variant="outline" onClick={() => applyPreset(SHIFT_PRESETS.tarde)}>
                Tarde
              </Button>
            </div>
            <div class="grid grid-cols-3 gap-2">
              <label class="space-y-1">
                <span class="text-xs text-muted-foreground">Entrada</span>
                <Input type="time" value={start()} onInput={setStart} />
              </label>
              <label class="space-y-1">
                <span class="text-xs text-muted-foreground">Salida</span>
                <Input type="time" value={end()} onInput={setEnd} />
              </label>
              <label class="space-y-1">
                <span class="text-xs text-muted-foreground">Tolerancia (min)</span>
                <Input type="number" min="0" max="240" value={tolerance()} onInput={setTolerance} />
              </label>
            </div>
            <div class="space-y-1">
              <span class="text-xs text-muted-foreground">Días que trabaja</span>
              <div class="flex flex-wrap gap-1">
                <For each={DAYS}>
                  {(label, i) => (
                    <button type="button" class={chip(days().includes(i() + 1))} onClick={() => toggleMain(i() + 1)}>
                      {label}
                    </button>
                  )}
                </For>
              </div>
            </div>
            <Show when={start() >= end()}>
              <p class="text-xs text-red-600">La salida debe ser después de la entrada.</p>
            </Show>

            <For each={others()}>
              {(w, i) => (
                <div class="space-y-2 border-t border-border pt-3">
                  <div class="flex items-center justify-between">
                    <span class="text-xs font-medium text-foreground">Horario distinto</span>
                    <Button
                      type="button"
                      variant="ghost"
                      aria-label="Quitar este horario"
                      onClick={() => setOthers(others().filter((_, j) => j !== i()))}
                    >
                      <Trash2 class="h-4 w-4" />
                    </Button>
                  </div>
                  <div class="flex flex-wrap gap-1">
                    <For each={DAYS}>
                      {(label, d) => (
                        <button type="button" class={chip(w.days.includes(d() + 1))} onClick={() => toggleOther(i(), d() + 1)}>
                          {label}
                        </button>
                      )}
                    </For>
                  </div>
                  <div class="grid grid-cols-2 gap-2">
                    <label class="space-y-1">
                      <span class="text-xs text-muted-foreground">Entrada</span>
                      <Input type="time" value={w.start} onInput={(v) => setOther(i(), { start: v })} />
                    </label>
                    <label class="space-y-1">
                      <span class="text-xs text-muted-foreground">Salida</span>
                      <Input type="time" value={w.end} onInput={(v) => setOther(i(), { end: v })} />
                    </label>
                  </div>
                  <Show when={w.start >= w.end}>
                    <p class="text-xs text-red-600">La salida debe ser después de la entrada.</p>
                  </Show>
                </div>
              )}
            </For>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setDays(days().filter((d) => d !== 6))
                setOthers([...others().filter((w) => !w.days.includes(6)), { days: [6], start: '07:00', end: '12:00' }])
              }}
            >
              <Plus class="mr-1.5 h-4 w-4" />
              Horario distinto para otros días (ej. sábado)
            </Button>

            <div class="space-y-1 border-t border-border pt-3">
              <span class="text-xs font-medium text-foreground">Turno flexible: también puede venir en</span>
              <div class="flex flex-wrap gap-4">
                <Checkbox checked={flex().includes('manana')} onChange={(on) => toggleFlex('manana', on)} label="Mañana" />
                <Checkbox checked={flex().includes('tarde')} onChange={(on) => toggleFlex('tarde', on)} label="Tarde" />
              </div>
              <p class="text-xs text-muted-foreground">Cada día se mide contra el turno más cercano a su hora de entrada.</p>
            </div>
          </div>
        </Show>

        <label class="block space-y-1">
          <span class="text-sm font-medium text-foreground">Fecha de ingreso</span>
          <Input type="date" value={startDate()} onInput={setStartDate} />
          <span class="block text-xs text-muted-foreground">Los días antes de esta fecha no cuentan como falta. Vacío = cuentan todos.</span>
        </label>

        <Checkbox checked={intern()} onChange={setIntern} label="Practicante (sin sueldo; aparte de la nómina)" />

        <Show when={!intern()}>
          <div class="grid grid-cols-2 gap-2">
            <label class="space-y-1">
              <span class="text-sm font-medium text-foreground">Sueldo semanal</span>
              <Input type="number" min="0" step="0.01" value={weeklyPay()} onInput={setWeeklyPay} placeholder="3110.38" />
            </label>
            <label class="space-y-1">
              <span class="text-sm font-medium text-foreground">Por cuántas horas</span>
              <Input type="number" min="1" max="120" step="0.5" value={weeklyHours()} onInput={setWeeklyHours} />
            </label>
          </div>
          <span class="block text-xs text-muted-foreground">
            Antes de impuestos (sueldo + séptimo día). Con esto la semana muestra cuánto lleva acumulado; las horas que pasen de estas se
            pagan al doble. Vacío = no se calcula.
          </span>
        </Show>

        <Show when={!isNew}>
          <Checkbox checked={active()} onChange={setActive} label="Activo (sale en el reporte)" />
        </Show>

        <div class="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => props.onClose()}>
            Cancelar
          </Button>
          <Button type="submit" disabled={!valid() || save.isPending}>
            {save.isPending ? 'Guardando…' : 'Guardar'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}

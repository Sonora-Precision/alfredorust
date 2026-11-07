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
  type AttendanceStatus,
  deleteAttendanceEmployee,
  getAttendanceReport,
  listAttendanceEmployees,
  saveAttendanceEmployee,
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
}

const DAYS = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom']

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

const turno = (e: AttendanceEmployee): string => {
  const s = e.shift
  if (!s) return 'Sin horario fijo'
  const dias = s.days.length === 5 && s.days.every((d, i) => d === i + 1) ? 'L–V' : s.days.map((d) => DAYS[d - 1]).join(', ')
  return `${s.start}–${s.end} · ${dias} · tolerancia ${s.tolerance_min} min`
}

function DayCell(props: { day: AttendanceDay }): JSX.Element {
  const st = () => STATUS[props.day.status]
  return (
    <TableCell class="align-top">
      <div class="space-y-0.5 text-xs">
        <Show when={props.day.entry}>
          <p class="tnum text-foreground">
            {props.day.entry} – {props.day.exit ?? '¿?'}
          </p>
        </Show>
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
                  </TableRow>
                </TableHead>
                <TableBody>
                  <For each={report.data?.employees ?? []}>
                    {(e) => (
                      <TableRow>
                        <TableCell class="align-top">
                          <p class="font-medium text-foreground">{e.name}</p>
                          <p class="text-xs text-muted-foreground">
                            #{e.employee_no}
                            {e.shift ? ` · ${e.shift.start}–${e.shift.end}` : ''}
                          </p>
                        </TableCell>
                        <For each={e.days}>{(d) => <DayCell day={d} />}</For>
                        <TableCell class="tnum align-top font-medium">{horas(e.totals.worked_min)}</TableCell>
                        <TableCell class="tnum align-top">
                          {e.totals.late_days > 0 ? `${e.totals.late_days} (${e.totals.late_min} min)` : e.shift ? '0' : '—'}
                        </TableCell>
                        <TableCell class="tnum align-top">
                          {e.shift ? e.totals.absences + (e.totals.incomplete ? ` · ${e.totals.incomplete} sin salida` : '') : '—'}
                        </TableCell>
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
                shift: { start: '14:00', end: '22:00', days: [1, 2, 3, 4, 5], tolerance_min: 10 },
                active: true,
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
                    <TableCell class={e.active ? 'font-medium text-foreground' : 'text-muted-foreground line-through'}>{e.name}</TableCell>
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
    </div>
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
  const [active, setActive] = createSignal(props.initial.active)

  const valid = createMemo(() => no().trim() !== '' && name().trim() !== '' && (!hasShift() || (days().length > 0 && start() < end())))

  const save = createMutation(() => ({
    mutationFn: () =>
      saveAttendanceEmployee({
        employee_no: no().trim(),
        name: name().trim(),
        user_id: userId() || null,
        shift: hasShift()
          ? { start: start(), end: end(), days: [...days()].sort(), tolerance_min: Math.max(0, Number(tolerance()) || 0) }
          : null,
        active: active(),
      }),
    onSuccess: () => {
      toast.success('Guardado')
      void qc.invalidateQueries({ queryKey: ['attendance-employees'] })
      void qc.invalidateQueries({ queryKey: ['attendance-report'] })
      props.onClose()
    },
    onError: (err) => toast.error('No se pudo guardar', humanizeError(err, 'Revisa los datos')),
  }))

  const toggleDay = (d: number) => setDays((cur) => (cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d]))
  const chip = (on: boolean) =>
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
                    <button type="button" class={chip(days().includes(i() + 1))} onClick={() => toggleDay(i() + 1)}>
                      {label}
                    </button>
                  )}
                </For>
              </div>
            </div>
            <Show when={start() >= end()}>
              <p class="text-xs text-red-600">La salida debe ser después de la entrada.</p>
            </Show>
          </div>
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

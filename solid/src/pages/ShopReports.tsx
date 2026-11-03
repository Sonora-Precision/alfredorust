// Reportes del taller: el reporte completo de cada día que manda el monitor de la Mac del taller
// (taller-vision), sólo para admins (dice quién estuvo en qué máquina y cuándo). Sólo números.
import { createQuery } from '@tanstack/solid-query'
import { type JSX, For, Show, createEffect, createSignal } from 'solid-js'

import { Badge } from '../components/ui/Badge'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/Card'
import { PageHeader } from '../components/ui/PageHeader'
import { Select } from '../components/ui/Select'
import { Spinner } from '../components/ui/Spinner'
import { Table, TableBody, TableCell, TableHead, TableHeadCell, TableRow } from '../components/ui/Table'
import { getShopReport, listShopReports } from '../lib/api/operations'
import type { ShopRun, ShopZone } from '../lib/api/types'

const horas = (min?: number | null): string => {
  const m = Math.round(min ?? 0)
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`
}
const reloj = (min?: number | null): string =>
  min == null ? '—' : `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(Math.floor(min % 60)).padStart(2, '0')}`
const hora = (iso: string): string => new Date(iso).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })
const fecha = (iso: string): string => new Date(iso).toLocaleDateString('es-MX', { day: 'numeric', month: 'short' })
const diaLargo = (day: string): string =>
  new Date(`${day}T12:00:00`).toLocaleDateString('es-MX', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })

function Stat(props: { label: string; value: string; hint?: string }): JSX.Element {
  return (
    <Card glass>
      <CardContent class="py-3">
        <p class="text-xs text-muted-foreground">{props.label}</p>
        <p class="tnum text-lg font-semibold text-foreground">{props.value}</p>
        <Show when={props.hint}>
          <p class="text-xs text-muted-foreground">{props.hint}</p>
        </Show>
      </CardContent>
    </Card>
  )
}

export default function ShopReports(): JSX.Element {
  const list = createQuery(() => ({ queryKey: ['shop-reports'], queryFn: listShopReports, refetchInterval: 600_000 }))
  const [day, setDay] = createSignal('')
  createEffect(() => {
    const first = list.data?.[0]?.day
    if (first && !day()) setDay(first)
  })
  const detail = createQuery(() => ({
    queryKey: ['shop-report', day()],
    queryFn: () => getShopReport(day()),
    enabled: day() !== '',
    refetchInterval: 600_000,
  }))
  const rep = () => detail.data?.report
  const kpis = () => detail.data?.kpis
  const runs = () => rep()?.corridas ?? []
  const machineName = (z: ShopZone): string =>
    z.dnc?.nombre ?? rep()?.maquinas?.find((m) => m.ref === z.maquina)?.name ?? z.name
  const estimated = (z: ShopZone): number =>
    runs().filter((r) => r.inferred && r.machine === z.dnc?.nombre).reduce((sum, r) => sum + r.minutes, 0)
  const runName = (r: ShopRun): string => r.part_number ?? r.nombre_cabecera ?? 'Sin nombre'

  return (
    <div class="space-y-6">
      <PageHeader
        title="Reportes del taller"
        breadcrumb={['Operaciones']}
        actions={
          <Select value={day()} onChange={setDay}>
            <For each={list.data ?? []}>{(r) => <option value={r.day}>{diaLargo(r.day)}</option>}</For>
          </Select>
        }
      />
      <Show
        when={!list.isLoading && !(day() && detail.isLoading)}
        fallback={
          <div class="flex items-center justify-center gap-2 py-16 text-muted-foreground">
            <Spinner />
            <span>Cargando…</span>
          </div>
        }
      >
        <Show
          when={rep()}
          fallback={<p class="py-16 text-center text-sm text-muted-foreground">Todavía no hay reportes del taller.</p>}
        >
          <div class="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <Stat label="Jornada" value={`${reloj(kpis()?.inicio_min)} – ${reloj(kpis()?.fin_min)}`} />
            <Stat label="Con gente en el taller" value={horas(kpis()?.gente_min)} />
            <Stat label="Gente en máquinas" value={horas(kpis()?.trabajo_maquinas_min)} />
            <Stat label="Medido por DNC" value={horas(kpis()?.medido_min)} hint={`cortando ${horas(kpis()?.cortando_min)}`} />
            <Stat label="≈ Estimado" value={horas(kpis()?.estimado_min)} hint="actividad sin DNC" />
          </div>

          <Show when={detail.data?.summary}>
            <Card glass>
              <CardHeader>
                <CardTitle>Resumen del día</CardTitle>
              </CardHeader>
              <CardContent class="whitespace-pre-wrap text-sm text-foreground">{detail.data?.summary}</CardContent>
            </Card>
          </Show>

          <Card glass>
            <CardHeader>
              <CardTitle>Máquinas</CardTitle>
            </CardHeader>
            <Table>
              <TableHead>
                <TableRow>
                  <TableHeadCell>Máquina</TableHeadCell>
                  <TableHeadCell>Gente en la zona</TableHeadCell>
                  <TableHeadCell>Sesiones</TableHeadCell>
                  <TableHeadCell>Cortando (DNC)</TableHeadCell>
                  <TableHeadCell>Ciclos</TableHeadCell>
                  <TableHeadCell>≈ Estimado</TableHeadCell>
                </TableRow>
              </TableHead>
              <TableBody>
                <For each={rep()?.zonas ?? []}>
                  {(z) => (
                    <TableRow>
                      <TableCell class="font-medium text-foreground">{machineName(z)}</TableCell>
                      <TableCell class="tnum">{horas(z.trabajo_min)}</TableCell>
                      <TableCell class="tnum">{z.sesiones?.n ?? 0}</TableCell>
                      <TableCell class="tnum">{z.dnc ? horas(z.dnc.cortando_min) : 'sin DNC'}</TableCell>
                      <TableCell class="tnum">{z.dnc?.ciclos ?? ''}</TableCell>
                      <TableCell class="tnum">{estimated(z) > 0 ? horas(estimated(z)) : ''}</TableCell>
                    </TableRow>
                  )}
                </For>
              </TableBody>
            </Table>
          </Card>

          <Card glass>
            <CardHeader>
              <CardTitle>Corridas de programas</CardTitle>
            </CardHeader>
            <Show
              when={runs().length > 0}
              fallback={<CardContent class="py-8 text-center text-sm text-muted-foreground">Sin corridas este día.</CardContent>}
            >
              <Table>
                <TableHead>
                  <TableRow>
                    <TableHeadCell>Hora</TableHeadCell>
                    <TableHeadCell>Máquina</TableHeadCell>
                    <TableHeadCell>Programa</TableHeadCell>
                    <TableHeadCell>Pieza / cabecera</TableHeadCell>
                    <TableHeadCell>Tiempo</TableHeadCell>
                    <TableHeadCell>Ciclos</TableHeadCell>
                    <TableHeadCell>Fuente</TableHeadCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  <For each={runs()}>
                    {(r) => (
                      <TableRow>
                        <TableCell class="tnum whitespace-nowrap">
                          {hora(r.started_at)} – {hora(r.ended_at)}
                        </TableCell>
                        <TableCell>{r.machine}</TableCell>
                        <TableCell>{r.program}</TableCell>
                        <TableCell class={r.part_number ? 'font-medium text-foreground' : 'text-muted-foreground'}>{runName(r)}</TableCell>
                        <TableCell class="tnum">
                          {r.inferred ? '≈ ' : ''}
                          {horas(r.minutes)}
                        </TableCell>
                        <TableCell class="tnum">{r.cycles || ''}</TableCell>
                        <TableCell>
                          <Show
                            when={r.inferred}
                            fallback={<Badge tone="success">DNC</Badge>}
                          >
                            <span class="text-xs text-muted-foreground">
                              Estimado: último programa subido{r.program_loaded_at ? ` el ${fecha(r.program_loaded_at)}` : ''}
                            </span>
                          </Show>
                        </TableCell>
                      </TableRow>
                    )}
                  </For>
                </TableBody>
              </Table>
            </Show>
          </Card>

          <Show when={(rep()?.alarmas ?? []).length > 0}>
            <Card glass>
              <CardHeader>
                <CardTitle>Alarmas (torreta en rojo)</CardTitle>
              </CardHeader>
              <CardContent class="space-y-1 text-sm">
                <For each={rep()?.alarmas ?? []}>
                  {(a) => (
                    <p>
                      {a.inicio} · {a.maquina ?? a.name ?? a.cam}
                    </p>
                  )}
                </For>
              </CardContent>
            </Card>
          </Show>
        </Show>
      </Show>
    </div>
  )
}

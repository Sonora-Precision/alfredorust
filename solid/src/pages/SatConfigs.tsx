// SAT fiscal configs for the active company: list stored certificates, upload
// a new one (.cer + .key + password via multipart), and delete. Faithful port
// of frontend/src/pages/sat_configs.rs — see
// docs/solid-migration/pages-part1.md "SatConfigsPage". Editing the stored
// certificate files isn't exposed here — re-upload instead, matching v1.
//
// Multipart quirk: this is a genuine two-file upload (cer_file + key_file)
// plus text fields. `fiscalApi.uploadSatConfig` builds the FormData and posts
// via `apiPostForm`. File inputs are left uncontrolled (native <input
// type=file> + a plain ref) since Solid, like the DOM, can't set `.value` on
// a file input to anything but empty string — clearing after a successful
// upload uses that same trick (`el.value = ''`), same as the NodeRef
// `set_value("")` in the Leptos version.
import { createMutation, createQuery, useQueryClient } from '@tanstack/solid-query'
import { FileKey, Trash2 } from 'lucide-solid'
import { type JSX, Show, createSignal, For } from 'solid-js'

import { Button } from '../components/ui/Button'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/Card'
import { Input } from '../components/ui/Input'
import { PageHeader } from '../components/ui/PageHeader'
import { Spinner } from '../components/ui/Spinner'
import { Table, TableBody, TableCell, TableHead, TableHeadCell, TableRow } from '../components/ui/Table'
import { toast } from '../components/ui/Toast'
import { humanizeError } from '../lib/api/client'
import * as fiscalApi from '../lib/api/fiscal'
import { rfc3339ToDate } from '../lib/format'

const FILE_INPUT_CLASS =
  'block w-full text-sm text-foreground file:mr-3 file:rounded-md file:border-0 file:bg-muted file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-foreground'

interface UploadArgs {
  rfc: string
  label: string
  password: string
  cerFile: File
  keyFile: File
}

export default function SatConfigs(): JSX.Element {
  const qc = useQueryClient()

  const configsQuery = createQuery(() => ({
    queryKey: ['sat-configs'],
    queryFn: fiscalApi.listSatConfigs,
  }))

  // --- upload form state -------------------------------------------------
  const [label, setLabel] = createSignal('')
  const [rfc, setRfc] = createSignal('')
  const [password, setPassword] = createSignal('')
  const [formError, setFormError] = createSignal<string | null>(null)

  let cerInput: HTMLInputElement | undefined
  let keyInput: HTMLInputElement | undefined

  const resetForm = () => {
    setLabel('')
    setRfc('')
    setPassword('')
    if (cerInput) cerInput.value = ''
    if (keyInput) keyInput.value = ''
  }

  const uploadMutation = createMutation(() => ({
    mutationFn: (args: UploadArgs) =>
      fiscalApi.uploadSatConfig(args.rfc, args.label, args.password, args.cerFile, args.keyFile),
    onSuccess: () => {
      resetForm()
      setFormError(null)
      toast.success('Configuración SAT guardada')
      void qc.invalidateQueries({ queryKey: ['sat-configs'] })
    },
    onError: (err) => {
      setFormError(humanizeError(err, 'No se pudo subir la configuración'))
    },
  }))

  const submit = (ev: SubmitEvent) => {
    ev.preventDefault()
    const cerFile = cerInput?.files?.[0]
    const keyFile = keyInput?.files?.[0]
    if (!cerFile || !keyFile) {
      setFormError('Selecciona los archivos .cer y .key')
      return
    }
    if (rfc().trim() === '' || password().trim() === '') {
      setFormError('RFC, contraseña y ambos archivos son obligatorios')
      return
    }
    setFormError(null)
    uploadMutation.mutate({
      rfc: rfc().trim(),
      label: label().trim(),
      password: password(),
      cerFile,
      keyFile,
    })
  }

  const deleteMutation = createMutation(() => ({
    mutationFn: (id: string) => fiscalApi.deleteSatConfig(id),
    onSuccess: () => {
      toast.success('Configuración eliminada')
      void qc.invalidateQueries({ queryKey: ['sat-configs'] })
    },
    onError: (err) => {
      toast.error('No se pudo eliminar la configuración', humanizeError(err, ''))
    },
  }))

  return (
    <div class="space-y-6">
      <PageHeader
        title="Config. SAT"
        breadcrumb={['Fiscal', 'Config. SAT']}
        subtitle="Firmas (CSD) de la compañía actual para timbrado y descarga de CFDIs."
      />

      <Card glass class="max-w-2xl">
        <CardHeader>
          <CardTitle>Agregar configuración</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} class="grid gap-3 sm:grid-cols-2">
            <div class="space-y-1">
              <label class="block text-sm font-medium text-foreground">Etiqueta</label>
              <Input value={label()} onInput={setLabel} placeholder="Ej. Principal, Persona Moral…" />
              <p class="text-xs text-muted-foreground">Útil para identificar esta firma cuando hay varias.</p>
            </div>
            <div class="space-y-1">
              <label class="block text-sm font-medium text-foreground">RFC</label>
              <Input value={rfc()} onInput={setRfc} class="uppercase" placeholder="XAXX010101000" required />
            </div>
            <div class="space-y-1">
              <label class="block text-sm font-medium text-foreground">Certificado (.cer)</label>
              <input type="file" accept=".cer" ref={cerInput} class={FILE_INPUT_CLASS} />
            </div>
            <div class="space-y-1">
              <label class="block text-sm font-medium text-foreground">Llave privada (.key)</label>
              <input type="file" accept=".key" ref={keyInput} class={FILE_INPUT_CLASS} />
            </div>
            <div class="space-y-1 sm:col-span-2">
              <label class="block text-sm font-medium text-foreground">Contraseña de la llave privada</label>
              <Input value={password()} onInput={setPassword} type="password" required />
            </div>
            <div class="flex items-end gap-2 sm:col-span-2">
              <Button type="submit" disabled={uploadMutation.isPending}>
                {uploadMutation.isPending ? 'Subiendo…' : 'Guardar configuración'}
              </Button>
            </div>
            <Show when={formError()}>
              <p class="text-sm text-destructive sm:col-span-2">{formError()}</p>
            </Show>
          </form>
        </CardContent>
      </Card>

      <Card glass>
        <Show
          when={!configsQuery.isLoading}
          fallback={
            <CardContent class="flex items-center justify-center gap-2 py-16 text-muted-foreground">
              <Spinner />
              <span>Cargando…</span>
            </CardContent>
          }
        >
          <Show
            when={!configsQuery.isError}
            fallback={
              <CardContent class="py-16 text-center text-sm text-destructive">
                No se pudieron cargar las configuraciones.
              </CardContent>
            }
          >
            <Show
              when={configsQuery.data && configsQuery.data.length > 0}
              fallback={
                <CardContent class="flex flex-col items-center gap-3 py-16 text-center">
                  <FileKey class="h-8 w-8 text-muted-foreground" />
                  <p class="text-sm text-muted-foreground">Sin configuraciones todavía.</p>
                </CardContent>
              }
            >
              <Table>
                <TableHead>
                  <TableRow>
                    <TableHeadCell>RFC</TableHeadCell>
                    <TableHeadCell>Etiqueta</TableHeadCell>
                    <TableHeadCell>Creada</TableHeadCell>
                    <TableHeadCell class="text-right">Acciones</TableHeadCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  <For each={configsQuery.data ?? []}>{(s) => (
                    <TableRow>
                      <TableCell class="font-medium text-foreground">{s.rfc}</TableCell>
                      <TableCell class="text-muted-foreground">{s.label ?? ''}</TableCell>
                      <TableCell class="tnum text-muted-foreground">{rfc3339ToDate(s.created_at)}</TableCell>
                      <TableCell class="text-right">
                        <Button
                          variant="ghost"
                          class="text-destructive hover:bg-destructive/10"
                          disabled={deleteMutation.isPending}
                          onClick={() => deleteMutation.mutate(s.id)}
                          aria-label="Eliminar"
                        >
                          <Trash2 class="h-4 w-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  )}</For>
                </TableBody>
              </Table>
            </Show>
          </Show>
        </Show>
      </Card>
    </div>
  )
}

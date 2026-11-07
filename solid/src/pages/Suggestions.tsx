// Sugerencias — everyone tells the admin how to improve the system and sees the answer to
// theirs; the admin sees them all, marks where each stands and answers (Daniel, 2026-11-06).
import { createMutation, createQuery, useQueryClient } from '@tanstack/solid-query'
import { Lightbulb } from 'lucide-solid'
import { type JSX, For, Show, createMemo, createSignal } from 'solid-js'

import { Button } from '../components/ui/Button'
import { PageHeader } from '../components/ui/PageHeader'
import { Spinner } from '../components/ui/Spinner'
import { toast } from '../components/ui/Toast'
import { humanizeError } from '../lib/api/client'
import { createSuggestion, listSuggestions, updateSuggestion } from '../lib/api/notes'
import type { Suggestion, SuggestionStatus } from '../lib/api/types'
import { useAuth } from '../lib/auth/AuthContext'

const STATUS: Record<SuggestionStatus, { label: string; class: string }> = {
  nueva: { label: 'Nueva', class: 'bg-sky-500/15 text-sky-700 dark:text-sky-300' },
  en_revision: { label: 'En revisión', class: 'bg-amber-500/15 text-amber-700 dark:text-amber-300' },
  hecha: { label: 'Hecha', class: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' },
  descartada: { label: 'Descartada', class: 'bg-muted text-muted-foreground' },
}

const fecha = (iso: string) => new Date(iso).toLocaleDateString('es-MX', { day: 'numeric', month: 'short', year: 'numeric' })

export default function Suggestions(): JSX.Element {
  const auth = useAuth()
  const qc = useQueryClient()
  const list = createQuery(() => ({ queryKey: ['suggestions'], queryFn: listSuggestions }))
  const [text, setText] = createSignal('')
  const [filter, setFilter] = createSignal<SuggestionStatus | 'todas'>('todas')
  const shown = createMemo(() => (list.data ?? []).filter((s) => filter() === 'todas' || s.status === filter()))

  const send = createMutation(() => ({
    mutationFn: () => createSuggestion(text().trim()),
    onSuccess: () => {
      toast.success('¡Gracias!', 'Tu sugerencia le llegó a Daniel')
      setText('')
      void qc.invalidateQueries({ queryKey: ['suggestions'] })
    },
    onError: (err) => toast.error('No se pudo enviar', humanizeError(err, 'Intenta de nuevo')),
  }))

  const chip = (active: boolean) =>
    `rounded-full border px-3 py-1 text-xs ${active ? 'border-primary bg-primary/15 text-foreground' : 'border-border text-muted-foreground hover:bg-muted'}`

  return (
    <div class="space-y-5">
      <PageHeader
        title="Sugerencias"
        subtitle={auth.isAdmin() ? 'Lo que los usuarios proponen para mejorar el sistema' : '¿Qué mejorarías del sistema? Cuéntale a Daniel'}
      />

      <form
        class="space-y-2 rounded-xl border border-border bg-card p-4"
        onSubmit={(e) => {
          e.preventDefault()
          if (text().trim()) send.mutate()
        }}
      >
        <label class="block space-y-1">
          <span class="text-sm font-medium text-foreground">Nueva sugerencia</span>
          <textarea
            class="h-24 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
            placeholder="Por ejemplo: que la lista de cortes se pueda imprimir"
            value={text()}
            onInput={(e) => setText(e.currentTarget.value)}
          />
        </label>
        <div class="flex justify-end">
          <Button type="submit" disabled={send.isPending || !text().trim()}>
            <Lightbulb class="mr-1.5 h-4 w-4" />
            {send.isPending ? 'Enviando…' : 'Enviar sugerencia'}
          </Button>
        </div>
      </form>

      <div class="flex flex-wrap items-center gap-2">
        <span class="text-sm font-semibold text-foreground">{auth.isAdmin() ? 'Todas las sugerencias' : 'Mis sugerencias'}</span>
        <button type="button" class={chip(filter() === 'todas')} onClick={() => setFilter('todas')}>
          Todas ({(list.data ?? []).length})
        </button>
        <For each={Object.keys(STATUS) as SuggestionStatus[]}>
          {(s) => (
            <button type="button" class={chip(filter() === s)} onClick={() => setFilter(s)}>
              {STATUS[s].label} ({(list.data ?? []).filter((x) => x.status === s).length})
            </button>
          )}
        </For>
      </div>

      <Show when={!list.isLoading} fallback={<Spinner />}>
        <Show when={shown().length} fallback={<p class="text-sm text-muted-foreground">No hay sugerencias aquí todavía.</p>}>
          <ul class="space-y-2">
            <For each={shown()}>{(s) => <SuggestionCard s={s} admin={auth.isAdmin()} />}</For>
          </ul>
        </Show>
      </Show>
    </div>
  )
}

function SuggestionCard(props: { s: Suggestion; admin: boolean }): JSX.Element {
  const qc = useQueryClient()
  const [reply, setReply] = createSignal(props.s.reply ?? '')
  const save = createMutation(() => ({
    mutationFn: (u: { status?: SuggestionStatus; reply?: string | null }) => updateSuggestion(props.s.id, u),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['suggestions'] }),
    onError: (err) => toast.error('No se pudo guardar', humanizeError(err, '')),
  }))
  return (
    <li class="rounded-xl border border-border bg-card p-4">
      <div class="flex flex-wrap items-center gap-2 text-xs">
        <span class={`rounded px-1.5 py-px font-medium ${STATUS[props.s.status].class}`}>{STATUS[props.s.status].label}</span>
        <span class="text-muted-foreground">
          {props.s.mine ? 'Tú' : props.s.author} · {fecha(props.s.created_at)}
        </span>
        <Show when={props.admin}>
          <select
            class="ml-auto h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground"
            aria-label="Estado de la sugerencia"
            disabled={save.isPending}
            onChange={(e) => save.mutate({ status: e.currentTarget.value as SuggestionStatus })}
          >
            <For each={Object.keys(STATUS) as SuggestionStatus[]}>
              {(st) => (
                <option value={st} selected={props.s.status === st}>
                  {STATUS[st].label}
                </option>
              )}
            </For>
          </select>
        </Show>
      </div>
      <p class="mt-2 whitespace-pre-wrap text-sm text-foreground">{props.s.text}</p>
      <Show
        when={props.admin}
        fallback={
          <Show when={props.s.reply}>
            <p class="mt-2 rounded-lg bg-muted/50 px-3 py-2 text-sm text-foreground">
              <span class="font-medium">Respuesta:</span> {props.s.reply}
            </p>
          </Show>
        }
      >
        <form
          class="mt-2 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            save.mutate({ reply: reply().trim() || null })
            toast.success('Respuesta guardada')
          }}
        >
          <input
            class="h-9 flex-1 rounded-lg border border-border bg-background px-2 text-sm text-foreground"
            placeholder="Responder…"
            value={reply()}
            onInput={(e) => setReply(e.currentTarget.value)}
          />
          <Button type="submit" variant="outline" disabled={save.isPending || reply().trim() === (props.s.reply ?? '')}>
            Responder
          </Button>
        </form>
      </Show>
    </li>
  )
}

// Setup wizard with embedded create forms. Reads readiness from the backend
// (getOnboardingStatus — the same source `spcli onboarding status` uses) and
// lets an admin fill each missing piece without leaving the page. Each step's
// form calls the existing create API, then invalidates ['onboarding'] so the
// checklist and progress update live.
import { A } from '@solidjs/router'
import { createMutation, createQuery, useQueryClient } from '@tanstack/solid-query'
import { ArrowRight, Check, ExternalLink, Rocket } from 'lucide-solid'
import { For, Show, type JSX, createEffect, createMemo, createSignal } from 'solid-js'

import { Button } from '../components/ui/Button'
import { Card } from '../components/ui/Card'
import { Input } from '../components/ui/Input'
import { PageHeader } from '../components/ui/PageHeader'
import { Select } from '../components/ui/Select'
import { Spinner } from '../components/ui/Spinner'
import { toast } from '../components/ui/Toast'
import { humanizeError } from '../lib/api/client'
import { getOnboardingStatus, type OnboardingStep } from '../lib/api/onboarding'
import { createAccount, createCategory, createContact } from '../lib/api/finance'
import { uploadSatConfig } from '../lib/api/fiscal'
import { createConceptStatus } from '../lib/api/operations'
import { createUser } from '../lib/api/admin'
import type { AccountType, ContactType } from '../lib/api/types'
import { useAuth } from '../lib/auth/AuthContext'

// Standard shop-floor status flow (mirrors the boot-seed default set). Offered
// as a one-click for the concept-statuses step so a fresh tenant gets a valid
// initial→terminal chain instantly.
const DEFAULT_STATUSES: { name: string; color: string; is_initial?: boolean; is_terminal?: boolean; is_cancelled?: boolean }[] = [
  { name: 'Pedido', color: 'slate', is_initial: true },
  { name: 'Ingeniería', color: 'sky' },
  { name: 'CNC', color: 'amber' },
  { name: 'Calidad', color: 'violet' },
  { name: 'Entrega', color: 'emerald' },
  { name: 'Terminado', color: 'green', is_terminal: true },
  { name: 'Cancelado', color: 'rose', is_cancelled: true },
]

export default function Onboarding(): JSX.Element {
  const qc = useQueryClient()
  const auth = useAuth()

  const statusQuery = createQuery(() => ({
    queryKey: ['onboarding'],
    queryFn: getOnboardingStatus,
  }))

  const steps = createMemo<OnboardingStep[]>(() => statusQuery.data?.steps ?? [])
  const [activeKey, setActiveKey] = createSignal<string>('company')

  // Land on the first unfinished step once data loads (only before the user
  // has manually navigated — we key off whether the current step still exists).
  createEffect(() => {
    const all = steps()
    if (all.length === 0) return
    if (!all.some((s) => s.key === activeKey())) {
      const firstPending = all.find((s) => !s.done) ?? all[0]
      setActiveKey(firstPending.key)
    }
  })

  const activeStep = createMemo(() => steps().find((s) => s.key === activeKey()))

  const refresh = () => qc.invalidateQueries({ queryKey: ['onboarding'] })

  const goNext = () => {
    const all = steps()
    const i = all.findIndex((s) => s.key === activeKey())
    const next = all.slice(i + 1).find((s) => !s.done) ?? all[i + 1]
    if (next) setActiveKey(next.key)
  }

  const activeCompanyId = () => auth.companies().find((c) => c.active)?.id ?? null

  return (
    <div class="space-y-6">
      <PageHeader
        title="Configuración inicial"
        subtitle="Deja tu empresa lista para operar. Cada paso llena un dato que la app necesita."
      />

      <Show
        when={!statusQuery.isLoading}
        fallback={
          <div class="flex justify-center py-16">
            <Spinner />
          </div>
        }
      >
        <ProgressBanner
          ready={statusQuery.data?.ready ?? false}
          done={statusQuery.data?.required_done ?? 0}
          total={statusQuery.data?.required_total ?? 0}
        />

        <div class="grid gap-6 lg:grid-cols-[280px_1fr]">
          {/* Stepper */}
          <Card glass class="h-fit p-2">
            <For each={steps()}>
              {(step) => (
                <button
                  type="button"
                  onClick={() => setActiveKey(step.key)}
                  class="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-white/5"
                  classList={{ 'bg-white/10': step.key === activeKey() }}
                >
                  <span
                    class="grid h-6 w-6 shrink-0 place-items-center rounded-full border text-[11px] font-semibold"
                    classList={{
                      'border-emerald-400/60 bg-emerald-400/20 text-emerald-300': step.done,
                      'border-white/20 text-muted-foreground': !step.done,
                    }}
                  >
                    <Show when={step.done} fallback={step.count}>
                      <Check class="h-3.5 w-3.5" />
                    </Show>
                  </span>
                  <span class="min-w-0 flex-1">
                    <span class="block text-sm font-medium">{step.label}</span>
                    <span class="block text-[11px] text-muted-foreground">
                      {step.required ? 'Obligatorio' : 'Opcional'}
                    </span>
                  </span>
                </button>
              )}
            </For>
          </Card>

          {/* Active step form */}
          <Card glass glow class="p-6">
            <Show when={activeStep()} keyed>
              {(step) => (
                <div class="space-y-5">
                  <div>
                    <div class="flex items-center gap-2">
                      <h2 class="text-lg font-semibold">{step.label}</h2>
                      <Show when={step.done}>
                        <span class="inline-flex items-center gap-1 rounded-full bg-emerald-400/15 px-2 py-0.5 text-[11px] font-medium text-emerald-300">
                          <Check class="h-3 w-3" /> Listo
                        </span>
                      </Show>
                    </div>
                    <p class="mt-1 text-[13px] text-muted-foreground">{step.detail}</p>
                    <Show when={step.unlocks}>
                      <p class="mt-0.5 text-[12px] text-muted-foreground">Desbloquea: {step.unlocks}</p>
                    </Show>
                  </div>

                  <StepForm
                    step={step}
                    companyId={activeCompanyId()}
                    onDone={() => {
                      void refresh()
                    }}
                    onNext={goNext}
                  />
                </div>
              )}
            </Show>
          </Card>
        </div>
      </Show>
    </div>
  )
}

function ProgressBanner(props: { ready: boolean; done: number; total: number }): JSX.Element {
  const pct = () => (props.total === 0 ? 100 : Math.round((props.done / props.total) * 100))
  return (
    <Card glass glow class="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between">
      <div class="flex items-center gap-3">
        <div class="grid h-11 w-11 place-items-center rounded-xl bg-primary text-primary-foreground">
          <Rocket class="h-6 w-6" />
        </div>
        <div>
          <p class="text-sm font-semibold">
            <Show when={props.ready} fallback={`${props.done} de ${props.total} pasos obligatorios`}>
              ¡Tu empresa está lista para operar! 🎉
            </Show>
          </p>
          <p class="text-[12px] text-muted-foreground">
            <Show when={props.ready} fallback="Completa los pasos obligatorios para empezar.">
              Los pasos opcionales desbloquean funciones extra.
            </Show>
          </p>
        </div>
      </div>
      <div class="min-w-[160px]">
        <div class="h-2 overflow-hidden rounded-full bg-white/10">
          <div
            class="h-full rounded-full bg-gradient-to-r from-cyan-400 to-violet-500 transition-all"
            style={{ width: `${pct()}%` }}
          />
        </div>
        <p class="mt-1 text-right text-[11px] text-muted-foreground">{pct()}%</p>
      </div>
    </Card>
  )
}

// --- per-step embedded forms --------------------------------------------------

function StepForm(props: {
  step: OnboardingStep
  companyId: string | null
  onDone: () => void
  onNext: () => void
}): JSX.Element {
  const nextButton = (
    <Button type="button" variant="outline" onClick={props.onNext} class="gap-1.5">
      Siguiente <ArrowRight class="h-4 w-4" />
    </Button>
  )

  return (
    <div class="space-y-5">
      <Show when={props.step.key === 'company'}>
        <div class="space-y-4">
          <p class="text-sm text-muted-foreground">
            Tu empresa ya existe. Puedes ajustar nombre, moneda o notas cuando quieras.
          </p>
          <div class="flex items-center gap-2">
            <A href={props.step.route}>
              <Button variant="outline" class="gap-1.5">
                {props.step.cta} <ExternalLink class="h-4 w-4" />
              </Button>
            </A>
            {nextButton}
          </div>
        </div>
      </Show>

      <Show when={props.step.key === 'accounts'}>
        <AccountForm onDone={props.onDone} onNext={props.onNext} />
      </Show>

      <Show when={props.step.key === 'categories'}>
        <CategoryForm onDone={props.onDone} onNext={props.onNext} />
      </Show>

      <Show when={props.step.key === 'concept_statuses'}>
        <ConceptStatusForm onDone={props.onDone} onNext={props.onNext} done={props.step.done} />
      </Show>

      <Show when={props.step.key === 'contacts'}>
        <ContactForm onDone={props.onDone} onNext={props.onNext} />
      </Show>

      <Show when={props.step.key === 'sat_config'}>
        <SatConfigForm onDone={props.onDone} onNext={props.onNext} />
      </Show>

      <Show when={props.step.key === 'users'}>
        <UserForm companyId={props.companyId} onDone={props.onDone} onNext={props.onNext} />
      </Show>
    </div>
  )
}

const ADD_LABEL = 'Agregar y continuar'

function FormFooter(props: { pending: boolean; onNext: () => void }): JSX.Element {
  return (
    <div class="flex items-center gap-2 pt-1">
      <Button type="submit" disabled={props.pending} class="magnetic gap-1.5">
        {props.pending ? 'Guardando…' : ADD_LABEL}
      </Button>
      <Button type="button" variant="ghost" onClick={props.onNext}>
        Omitir por ahora
      </Button>
    </div>
  )
}

function Field(props: { label: string; children: JSX.Element }): JSX.Element {
  return (
    <div class="space-y-1">
      <label class="block text-sm font-medium">{props.label}</label>
      {props.children}
    </div>
  )
}

function AccountForm(props: { onDone: () => void; onNext: () => void }): JSX.Element {
  const [name, setName] = createSignal('')
  const [type, setType] = createSignal<AccountType>('bank')
  const [currency, setCurrency] = createSignal('MXN')
  const m = createMutation(() => ({
    mutationFn: () =>
      createAccount({ name: name().trim(), account_type: type(), currency: currency().trim(), is_active: true }),
    onSuccess: () => {
      toast.success('Cuenta creada')
      setName('')
      props.onDone()
    },
    onError: (e) => toast.error('No se pudo crear la cuenta', humanizeError(e, '')),
  }))
  return (
    <form
      class="space-y-4"
      onSubmit={(e) => {
        e.preventDefault()
        m.mutate()
      }}
    >
      <Field label="Nombre">
        <Input value={name()} onInput={setName} placeholder="BBVA principal" required />
      </Field>
      <Field label="Tipo">
        <Select value={type()} onChange={(v) => setType(v as AccountType)}>
          <option value="bank">Banco</option>
          <option value="cash">Efectivo</option>
          <option value="credit_card">Tarjeta de crédito</option>
          <option value="investment">Inversión</option>
          <option value="other">Otro</option>
        </Select>
      </Field>
      <Field label="Moneda">
        <Input value={currency()} onInput={setCurrency} placeholder="MXN" />
      </Field>
      <FormFooter pending={m.isPending} onNext={props.onNext} />
    </form>
  )
}

function CategoryForm(props: { onDone: () => void; onNext: () => void }): JSX.Element {
  const [name, setName] = createSignal('')
  const [flow, setFlow] = createSignal<'income' | 'expense'>('expense')
  const m = createMutation(() => ({
    mutationFn: () => createCategory({ name: name().trim(), flow_type: flow() }),
    onSuccess: () => {
      toast.success('Categoría creada')
      setName('')
      props.onDone()
    },
    onError: (e) => toast.error('No se pudo crear la categoría', humanizeError(e, '')),
  }))
  return (
    <form
      class="space-y-4"
      onSubmit={(e) => {
        e.preventDefault()
        m.mutate()
      }}
    >
      <p class="text-[12px] text-muted-foreground">Necesitas al menos una de ingreso y una de gasto.</p>
      <Field label="Nombre">
        <Input value={name()} onInput={setName} placeholder="Ventas / Servicios" required />
      </Field>
      <Field label="Flujo">
        <Select value={flow()} onChange={(v) => setFlow(v as 'income' | 'expense')}>
          <option value="income">Ingreso</option>
          <option value="expense">Gasto</option>
        </Select>
      </Field>
      <FormFooter pending={m.isPending} onNext={props.onNext} />
    </form>
  )
}

function ConceptStatusForm(props: { onDone: () => void; onNext: () => void; done: boolean }): JSX.Element {
  const seed = createMutation(() => ({
    mutationFn: async () => {
      for (let i = 0; i < DEFAULT_STATUSES.length; i++) {
        const s = DEFAULT_STATUSES[i]
        await createConceptStatus({
          name: s.name,
          position: i,
          color: s.color,
          is_initial: s.is_initial ?? false,
          is_terminal: s.is_terminal ?? false,
          is_cancelled: s.is_cancelled ?? false,
          is_active: true,
        })
      }
    },
    onSuccess: () => {
      toast.success('Estados por defecto creados')
      props.onDone()
    },
    onError: (e) => toast.error('No se pudieron crear los estados', humanizeError(e, '')),
  }))
  return (
    <div class="space-y-4">
      <p class="text-sm text-muted-foreground">
        Crea el flujo estándar de un solo clic: Pedido → Ingeniería → CNC → Calidad → Entrega → Terminado, más
        Cancelado. Luego puedes reordenarlos o renombrarlos en la página de Estados.
      </p>
      <div class="flex flex-wrap items-center gap-2">
        <Button type="button" disabled={seed.isPending} class="magnetic" onClick={() => seed.mutate()}>
          {seed.isPending ? 'Creando…' : 'Crear estados por defecto'}
        </Button>
        <A href="/concept-statuses">
          <Button type="button" variant="outline" class="gap-1.5">
            Personalizar <ExternalLink class="h-4 w-4" />
          </Button>
        </A>
        <Button type="button" variant="ghost" onClick={props.onNext}>
          {props.done ? 'Siguiente' : 'Omitir por ahora'}
        </Button>
      </div>
    </div>
  )
}

function ContactForm(props: { onDone: () => void; onNext: () => void }): JSX.Element {
  const [name, setName] = createSignal('')
  const [type, setType] = createSignal<ContactType>('customer')
  const [rfc, setRfc] = createSignal('')
  const [email, setEmail] = createSignal('')
  const m = createMutation(() => ({
    mutationFn: () =>
      createContact({
        name: name().trim(),
        contact_type: type(),
        rfc: rfc().trim() || null,
        email: email().trim() || null,
      }),
    onSuccess: () => {
      toast.success('Contacto creado')
      setName('')
      setRfc('')
      setEmail('')
      props.onDone()
    },
    onError: (e) => toast.error('No se pudo crear el contacto', humanizeError(e, '')),
  }))
  return (
    <form
      class="space-y-4"
      onSubmit={(e) => {
        e.preventDefault()
        m.mutate()
      }}
    >
      <Field label="Nombre">
        <Input value={name()} onInput={setName} placeholder="Cliente / Proveedor SA" required />
      </Field>
      <Field label="Tipo">
        <Select value={type()} onChange={(v) => setType(v as ContactType)}>
          <option value="customer">Cliente</option>
          <option value="supplier">Proveedor</option>
          <option value="service">Servicio</option>
          <option value="other">Otro</option>
        </Select>
      </Field>
      <div class="grid gap-4 sm:grid-cols-2">
        <Field label="RFC (opcional)">
          <Input value={rfc()} onInput={setRfc} placeholder="XAXX010101000" />
        </Field>
        <Field label="Email (opcional)">
          <Input value={email()} onInput={setEmail} type="email" placeholder="correo@ejemplo.com" />
        </Field>
      </div>
      <FormFooter pending={m.isPending} onNext={props.onNext} />
    </form>
  )
}

function SatConfigForm(props: { onDone: () => void; onNext: () => void }): JSX.Element {
  const [rfc, setRfc] = createSignal('')
  const [label, setLabel] = createSignal('')
  const [pass, setPass] = createSignal('')
  let cerInput!: HTMLInputElement
  let keyInput!: HTMLInputElement
  const m = createMutation(() => ({
    mutationFn: () => {
      const cer = cerInput.files?.[0]
      const key = keyInput.files?.[0]
      if (!cer || !key) throw new Error('Selecciona el archivo .cer y el .key')
      return uploadSatConfig(rfc().trim(), label().trim(), pass(), cer, key)
    },
    onSuccess: () => {
      toast.success('e.firma configurada')
      props.onDone()
    },
    onError: (e) => toast.error('No se pudo subir la e.firma', humanizeError(e, (e as Error).message)),
  }))
  return (
    <form
      class="space-y-4"
      onSubmit={(e) => {
        e.preventDefault()
        m.mutate()
      }}
    >
      <p class="text-[12px] text-muted-foreground">
        Opcional. Sube tu e.firma (FIEL) del SAT para descargar CFDIs automáticamente.
      </p>
      <div class="grid gap-4 sm:grid-cols-2">
        <Field label="RFC">
          <Input value={rfc()} onInput={setRfc} placeholder="XAXX010101000" required />
        </Field>
        <Field label="Etiqueta (opcional)">
          <Input value={label()} onInput={setLabel} placeholder="FIEL principal" />
        </Field>
      </div>
      <Field label="Contraseña de la clave privada">
        <Input value={pass()} onInput={setPass} type="password" required />
      </Field>
      <div class="grid gap-4 sm:grid-cols-2">
        <Field label="Certificado (.cer)">
          <input ref={cerInput} type="file" accept=".cer" class="block w-full text-sm text-muted-foreground" required />
        </Field>
        <Field label="Clave privada (.key)">
          <input ref={keyInput} type="file" accept=".key" class="block w-full text-sm text-muted-foreground" required />
        </Field>
      </div>
      <FormFooter pending={m.isPending} onNext={props.onNext} />
    </form>
  )
}

function UserForm(props: { companyId: string | null; onDone: () => void; onNext: () => void }): JSX.Element {
  const [email, setEmail] = createSignal('')
  const [role, setRole] = createSignal<'admin' | 'staff'>('staff')
  const m = createMutation(() => ({
    mutationFn: () => {
      if (!props.companyId) throw new Error('No se pudo determinar la empresa activa')
      return createUser({
        username: email().trim(),
        memberships: [{ company_id: props.companyId, role: role(), permissions: [] }],
      })
    },
    onSuccess: () => {
      toast.success('Usuario invitado', 'Comparte su código QR desde la página de Usuarios.')
      setEmail('')
      props.onDone()
    },
    onError: (e) => toast.error('No se pudo invitar al usuario', humanizeError(e, (e as Error).message)),
  }))
  return (
    <form
      class="space-y-4"
      onSubmit={(e) => {
        e.preventDefault()
        m.mutate()
      }}
    >
      <p class="text-[12px] text-muted-foreground">
        Opcional. Se genera un secreto TOTP; comparte el QR desde la página de Usuarios.
      </p>
      <Field label="Usuario (email)">
        <Input value={email()} onInput={setEmail} type="email" placeholder="colega@empresa.com" required />
      </Field>
      <Field label="Rol">
        <Select value={role()} onChange={(v) => setRole(v as 'admin' | 'staff')}>
          <option value="staff">Staff</option>
          <option value="admin">Admin</option>
        </Select>
      </Field>
      <FormFooter pending={m.isPending} onNext={props.onNext} />
    </form>
  )
}

import { type JSX, Show } from 'solid-js'

/**
 * Whether a part past programming can be run now (Daniel, 2026-11-09: material, material
 * habilitado and program done → "ya deberían de poderse correr"). Nothing in programming.
 */
export function ReadyBadge(props: { ready: boolean | null }): JSX.Element {
  return (
    <Show when={props.ready !== null}>
      <Show
        when={props.ready}
        fallback={
          <span class="rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] font-medium text-amber-600 dark:text-amber-400">
            Falta material
          </span>
        }
      >
        <span class="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[11px] font-semibold text-emerald-600 dark:text-emerald-400">
          Lista para correr
        </span>
      </Show>
    </Show>
  )
}

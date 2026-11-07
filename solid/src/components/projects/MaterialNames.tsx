// The material choices offered when a part's material is typed: the shop's usual ones plus
// every material already given to a part, so the list fills itself as new ones come up
// (Daniel, 2026-11-06: a drawing asked for ANSI 304 → "Inoxidable 304").
import { createQuery } from '@tanstack/solid-query'
import { type JSX, For, createMemo } from 'solid-js'

import { getCutList } from '../../lib/api/material'

export const BASE_MATERIALS = [
  'Aluminio 6061',
  'Aluminio 7075',
  '1018',
  '1045',
  '4140',
  'Inoxidable 304',
  'Inoxidable 316',
  'Delrin negro',
  'Delrin blanco',
  'Nylamid',
  'G10',
  'Latón',
  'Cobre',
]

/** A `<datalist>` with the usual materials and those already used (open projects). */
export function MaterialNames(props: { id: string; extra?: (string | null | undefined)[] }): JSX.Element {
  const used = createQuery(() => ({ queryKey: ['cut-list'], queryFn: getCutList, staleTime: 5 * 60_000 }))
  const names = createMemo(() => {
    const seen = new Map<string, string>()
    const add = (n: string | null | undefined) => {
      const t = n?.trim()
      if (t && !seen.has(t.toLowerCase())) seen.set(t.toLowerCase(), t)
    }
    BASE_MATERIALS.forEach(add)
    ;(used.data ?? []).forEach((i) => add(i.material.material))
    ;(props.extra ?? []).forEach(add)
    return [...seen.values()].sort((a, b) => a.localeCompare(b, 'es', { numeric: true }))
  })
  return (
    <datalist id={props.id}>
      <For each={names()}>{(n) => <option value={n} />}</For>
    </datalist>
  )
}

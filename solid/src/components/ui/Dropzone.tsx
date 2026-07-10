// Drag-and-drop (or click-to-browse) file dropzone. Purely presentational: it
// collects File[] and hands them to `onFiles` — the caller owns upload/mutation.
import { UploadCloud } from 'lucide-solid'
import { type JSX, Show, createSignal } from 'solid-js'

interface DropzoneProps {
  onFiles: (files: File[]) => void
  /** `accept` attribute for the hidden input, e.g. ".xml,.zip". */
  accept?: string
  multiple?: boolean
  disabled?: boolean
  /** Optional hint line under the primary label. */
  hint?: string
  label?: string
}

export function Dropzone(props: DropzoneProps): JSX.Element {
  const [dragOver, setDragOver] = createSignal(false)
  let input: HTMLInputElement | undefined

  const emit = (list: FileList | null | undefined) => {
    if (props.disabled || !list) return
    const files = Array.from(list)
    if (files.length) props.onFiles(files)
  }

  return (
    <div
      role="button"
      tabindex={props.disabled ? -1 : 0}
      aria-disabled={props.disabled}
      onClick={() => !props.disabled && input?.click()}
      onKeyDown={(e) => {
        if (props.disabled) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          input?.click()
        }
      }}
      onDragOver={(e) => {
        if (props.disabled) return
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragOver(false)
        emit(e.dataTransfer?.files)
      }}
      class="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-6 py-10 text-center transition"
      classList={{
        'border-ring bg-primary/5': dragOver(),
        'border-border bg-glass hover:border-ring/60': !dragOver() && !props.disabled,
        'cursor-not-allowed opacity-60': props.disabled,
      }}
    >
      <UploadCloud class="h-8 w-8 text-muted-foreground" />
      <p class="text-sm font-medium text-foreground">
        {props.label ?? 'Arrastra archivos aquí o haz clic para elegir'}
      </p>
      <Show when={props.hint}>
        <p class="text-xs text-muted-foreground">{props.hint}</p>
      </Show>
      <input
        ref={input}
        type="file"
        class="hidden"
        accept={props.accept}
        multiple={props.multiple}
        disabled={props.disabled}
        onChange={(e) => {
          emit(e.currentTarget.files)
          e.currentTarget.value = '' // allow re-selecting the same file
        }}
      />
    </div>
  )
}

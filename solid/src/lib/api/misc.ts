import { apiGet, apiGetBlob, apiPost } from './client'
import type { PdfPreviewResponse, TimelineBucket, TimelineMode } from './types'

// --- tiempo (timeline) ----------------------------------------------------------------

export function getTimeline(
  mode: TimelineMode,
  from: string,
  to: string,
): Promise<TimelineBucket[]> {
  return apiGet<TimelineBucket[]>('/api/tiempo', { mode, from, to })
}

// --- PDF preview (Typst) ---------------------------------------------------------------

/** Raw Typst source -> base64-in-JSON envelope; decode to a Blob for preview/download. */
export async function pdfPreview(source: string): Promise<Blob> {
  const res = await apiPost<PdfPreviewResponse>('/pdf/preview', { source })
  if (!res.ok || !res.pdf_base64) {
    throw new Error(res.error ?? 'No se pudo generar el PDF')
  }
  const bytes = base64ToBytes(res.pdf_base64)
  return new Blob([bytes], { type: 'application/pdf' })
}

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64)
  const bytes = new Uint8Array(new ArrayBuffer(binary.length))
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

// --- QR code (TOTP enrollment) ----------------------------------------------------------
// Raw image/png response — apiGetBlob, then URL.createObjectURL(...) at the call site.

export const getQrCode = () => apiGetBlob('/qrcode')
export const getUserQrCode = (userId: string) => apiGetBlob(`/admin/users/${userId}/qrcode`)

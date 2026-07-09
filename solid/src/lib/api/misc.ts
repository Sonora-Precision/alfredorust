import { apiGet, apiGetBlob } from './client'
import type { TimelineBucket, TimelineMode } from './types'

// --- tiempo (timeline) ----------------------------------------------------------------

export function getTimeline(
  mode: TimelineMode,
  from: string,
  to: string,
): Promise<TimelineBucket[]> {
  return apiGet<TimelineBucket[]>('/api/tiempo', { mode, from, to })
}

// --- QR code (TOTP enrollment) ----------------------------------------------------------
// Raw image/png response — apiGetBlob, then URL.createObjectURL(...) at the call site.

export const getQrCode = () => apiGetBlob('/qrcode')
export const getUserQrCode = (userId: string) => apiGetBlob(`/admin/users/${userId}/qrcode`)

// Asistencia: checks from the shop's time clock, the employees with their shift, and the
// weekly report. Admin-only on the server.
import { apiGet, apiPost } from './client'

export interface ShiftWindow {
  /** 1 = Monday … 7 = Sunday */
  days: number[]
  /** "HH:MM", shop time */
  start: string
  end: string
}

export interface AttendanceShift {
  /** "HH:MM", shop time */
  start: string
  end: string
  /** 1 = Monday … 7 = Sunday */
  days: number[]
  tolerance_min: number
  /** Days with a different schedule, e.g. Saturday 12:00–17:00. */
  other?: ShiftWindow[]
}

export interface AttendanceEmployee {
  employee_no: string
  name: string
  user_id?: string | null
  shift?: AttendanceShift | null
  /** Other shifts they may work instead; each day uses the one closest to their entry. */
  alternates?: AttendanceShift[]
  active: boolean
  /** First day they work here (YYYY-MM-DD); earlier days are not absences. "" = none. */
  start_date?: string | null
  /** Unpaid intern: checks in like everyone, not payroll. */
  intern?: boolean
  /** Weekly pay before taxes (MXN). */
  weekly_pay?: number | null
  /** Hours that pay covers; null = 45. */
  weekly_hours?: number | null
}

export interface ManualCheck {
  id: string
  time: string
  note?: string | null
  author?: string | null
}

export type AttendanceStatus =
  | 'ok'
  | 'retardo'
  | 'falta'
  | 'incompleto'
  | 'descanso'
  | 'extra'
  | 'pendiente'
  | 'sin_horario'
  | 'antes_alta'

export interface AttendanceDay {
  date: string
  checks: string[]
  entry?: string | null
  exit?: string | null
  worked_min: number
  late_min: number
  status: AttendanceStatus
  /** "HH:MM–HH:MM" the day was measured against. */
  window?: string | null
  /** The window came from an alternate shift. */
  alternate?: boolean
  manual?: ManualCheck[]
  /** An admin's correction; `entry`/`exit` above already use it. */
  correction?: AttendanceCorrection | null
}

export interface AttendanceCorrection {
  entry?: string | null
  exit?: string | null
  note?: string | null
  author: string
}

export interface AttendanceEmployeeReport {
  employee_no: string
  name: string
  shift?: AttendanceShift | null
  alternates?: AttendanceShift[]
  intern?: boolean
  /** MXN per hour (weekly pay ÷ hours), before taxes. */
  hourly_rate?: number | null
  /** Earned in the range, before taxes; overtime at double. */
  earned?: number | null
  overtime_min?: number
  days: AttendanceDay[]
  totals: { worked_min: number; late_min: number; late_days: number; absences: number; incomplete: number }
}

export interface AttendanceReport {
  from: string
  to: string
  employees: AttendanceEmployeeReport[]
  unknown: { employee_no: string; checks: number }[]
}

export const getAttendanceReport = (from?: string, to?: string) =>
  apiGet<AttendanceReport>('/api/admin/attendance/report', { ...(from ? { from } : {}), ...(to ? { to } : {}) })
export const listAttendanceEmployees = () => apiGet<AttendanceEmployee[]>('/api/admin/attendance/employees')
export const saveAttendanceEmployee = (payload: AttendanceEmployee) =>
  apiPost<void>('/api/admin/attendance/employees', payload)
export const addManualCheck = (payload: { employee_no: string; date: string; time: string; note?: string | null }) =>
  apiPost<{ id: string }>('/api/admin/attendance/manual', payload)
/** Sets a day's entry/exit; with both empty the correction is removed. */
export const saveCorrection = (payload: {
  employee_no: string
  date: string
  entry?: string | null
  exit?: string | null
  note?: string | null
}) => apiPost<void>('/api/admin/attendance/correction', payload)
export const deleteManualCheck =(id: string) => apiPost<void>(`/api/admin/attendance/manual/${encodeURIComponent(id)}/delete`)
export const deleteAttendanceEmployee =(employeeNo: string) =>
  apiPost<void>(`/api/admin/attendance/employees/${encodeURIComponent(employeeNo)}/delete`)

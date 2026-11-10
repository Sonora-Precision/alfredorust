import { apiGet, apiPost } from './client'
import type {
  BoardMemberLoad,
  MachineStatePayload,
  FloorData,
  PlantView,
  QualityItem,
  QualityPayload,
  SequenceMovePayload,
  TakeWorkOrderPayload,
  WeeklyPieces,
  WorkOrder,
  WorkOrderSearchHit,
  WorkQueue,
} from './types'

export const listWorkOrders = (queue: WorkQueue, mine = false) =>
  apiGet<WorkOrder[]>('/api/production/board', mine ? { queue, mine: 'true' } : { queue })
export const listBoardMembers = () => apiGet<BoardMemberLoad[]>('/api/production/members')

const action = (id: string, name: string, body: unknown = {}) =>
  apiPost<void>(`/api/production/work_orders/${id}/${name}`, body)

export const assignWorkOrder = (id: string, userId: string | null) =>
  action(id, 'assign', { user_id: userId })
export const takeWorkOrder = (id: string, payload: TakeWorkOrderPayload = {}) =>
  action(id, 'take', payload)
export const releaseWorkOrder = (id: string) => action(id, 'release')
export const completeWorkOrder = (id: string) => action(id, 'complete')
export const moveWorkOrder = (id: string, payload: SequenceMovePayload) =>
  action(id, 'sequence', payload)

export const getPlant = () => apiGet<PlantView>('/api/production/plant')
export const getFloor = () => apiGet<FloorData>('/api/production/floor')
export const getWeeklyPieces = () => apiGet<WeeklyPieces>('/api/production/weekly_pieces')
export const searchWorkOrders = (q: string) =>
  apiGet<WorkOrderSearchHit[]>('/api/production/search', { q })
export const listQualityQueue = () => apiGet<QualityItem[]>('/api/production/quality')
export const recordQuality = (id: string, payload: QualityPayload) =>
  apiPost<QualityItem>(`/api/production/work_orders/${id}/quality`, payload)
export const setMachineState = (resourceId: string, payload: MachineStatePayload) =>
  apiPost<void>(`/api/production/machines/${resourceId}/state`, payload)
export const finishMachineJob = (resourceId: string) =>
  apiPost<void>(`/api/production/machines/${resourceId}/finish`, {})
export const queueOnMachine = (resourceId: string, conceptId: string, label: string | null) =>
  apiPost<void>(`/api/production/machines/${resourceId}/queue`, { concept_id: conceptId, label })
export const removeQueueEntry = (id: string) => apiPost<void>(`/api/production/machine_queue/${id}/remove`, {})
/** Dragged to a 0-based place in its machine's queue. */
export const moveQueueEntryTo = (id: string, to: number) =>
  apiPost<void>(`/api/production/machine_queue/${id}/move`, { to })
export const moveQueueEntry = (id: string, up: boolean) =>
  apiPost<void>(`/api/production/machine_queue/${id}/move`, { up })
export const startQueueEntry = (id: string) => apiPost<void>(`/api/production/machine_queue/${id}/start`, {})

/** Every open project with its parts, for the traveler (no money). */
export const getTraveler = () => apiGet<import('./types').TravelerData>('/api/admin/traveler')

/** "Mi turno": the caller's parts and what changed on them since their last look. An admin
 *  may pass someone else's id to see their turn (it does not count as that person's look). */
export const getMyShift = (userId?: string | null) =>
  apiGet<import('./types').MyShiftData>('/api/production/my_shift', userId ? { user_id: userId } : undefined)

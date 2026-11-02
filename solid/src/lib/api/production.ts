import { apiGet, apiPost } from './client'
import type {
  BoardMemberLoad,
  MachineStatePayload,
  PlantView,
  SequenceMovePayload,
  TakeWorkOrderPayload,
  WorkOrder,
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
export const setMachineState = (resourceId: string, payload: MachineStatePayload) =>
  apiPost<void>(`/api/production/machines/${resourceId}/state`, payload)

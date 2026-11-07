// Closing projects, comments on part numbers and the suggestion box (Daniel, 2026-11-06).
import { apiGet, apiPost } from './client'
import type { PartComment, PartCommentKind, Suggestion, SuggestionStatus } from './types'

export const closeProject = (id: string, closed: boolean) => apiPost<void>(`/api/admin/projects/${id}/close`, { closed })

export const listPartComments = (projectId: string) =>
  apiGet<PartComment[]>(`/api/admin/projects/${projectId}/part_comments`)
export const createPartComment = (conceptId: string, c: { kind: PartCommentKind; text: string; quantity?: number | null }) =>
  apiPost<PartComment>(`/api/admin/project_concepts/${conceptId}/comments`, c)
export const deletePartComment = (id: string) => apiPost<void>(`/api/admin/part_comments/${id}/delete`, {})

export const listSuggestions = () => apiGet<Suggestion[]>('/api/suggestions')
export const createSuggestion = (text: string) => apiPost<Suggestion>('/api/suggestions', { text })
export const updateSuggestion = (id: string, u: { status?: SuggestionStatus; reply?: string | null }) =>
  apiPost<void>(`/api/suggestions/${id}`, u)

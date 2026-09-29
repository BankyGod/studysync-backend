import { pickAvatarColor } from '../utils/helpers.js'
import { normalizeAvatarColor } from '../utils/profileAvatar.js'

function actorRef(id, names) {
  return id ? { id, name: names?.[id] ?? 'Unknown' } : null
}

export function formatTask(row) {
  const names = row.user_names ?? {}
  const task = {
    id: row.id,
    title: row.title,
    status: row.status,
    variant: row.variant,
    taskType: row.task_type ?? 'standard',
    createdAt: row.created_at,
    priority: row.priority ?? null,
    startedAt: row.started_at ?? null,
    lastActivityAt: row.last_activity_at ?? row.completed_at ?? row.started_at ?? row.created_at,
    reviewStatus: row.review_status ?? null,
    reviewNote: row.review_note ?? null,
    reviewedAt: row.reviewed_at ?? null,
    reviewedBy: actorRef(row.reviewed_by_id, names),
    pendingAdvanceRequest: null,
    submissions: (row.submissions ?? []).map((s) => ({
      id: s.id,
      fileId: s.file_id,
      fileName: s.file_name,
      fileSize: s.file_size,
      fileType: s.file_type,
      uploadedAt: s.uploaded_at,
      uploadedBy: actorRef(s.uploaded_by_id, names),
    })),
    activity: (row.activity ?? []).map((entry) => ({
      id: entry.id,
      type: entry.type,
      at: entry.at,
      actor: actorRef(entry.actor_id, names),
      ...(entry.note ? { note: entry.note } : {}),
    })),
  }
  if (row.due_date) task.dueDate = row.due_date
  if (row.completed_at) task.completedAt = row.completed_at
  if (row.creator_id) {
    task.createdBy = {
      id: row.creator_id,
      initials:
        row.creator_initials ??
        (row.creator_name
          ? row.creator_name
              .split(/\s+/)
              .map((part) => part[0]?.toUpperCase() ?? '')
              .join('')
              .slice(0, 2) || '??'
          : '??'),
      name: row.creator_name || 'Unknown',
      color: normalizeAvatarColor(row.creator_color ?? pickAvatarColor(row.creator_id), row.creator_id),
    }
  }
  if (row.assignee_id) {
    task.assignee = {
      id: row.assignee_id,
      initials: row.initials,
      name: row.assignee_name,
      color: normalizeAvatarColor(row.avatar_color, row.assignee_id),
    }
  }
  const advance = row.pending_advance_request
  if (advance) {
    task.pendingAdvanceRequest = {
      id: advance.id,
      fromStatus: advance.from_status,
      targetStatus: advance.target_status,
      requestedAt: advance.requested_at,
      requestedBy: actorRef(advance.requested_by_id, names),
    }
  }
  const pending = row.pending_regress_request
  if (pending) {
    task.pendingRegressRequest = {
      requestId: pending.id,
      requesterId: pending.requester_id,
      fromStatus: pending.from_status,
      targetStatus: pending.target_status,
      createdAt: pending.created_at,
    }
  }
  return task
}

export function groupTasksByStatus(rows) {
  const result = { todo: [], in_progress: [], completed: [] }
  rows.forEach((row) => {
    result[row.status].push(formatTask(row))
  })
  return result
}

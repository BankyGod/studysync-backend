export const STATUS_RANK = {
  todo: 0,
  in_progress: 1,
  completed: 2,
}

export function isBackwardStatusMove(fromStatus, toStatus) {
  return STATUS_RANK[toStatus] < STATUS_RANK[fromStatus]
}

export function statusFromProgress(progress, currentStatus) {
  if (progress === 'started') {
    return 'in_progress'
  }
  if (progress === 'done') {
    return 'completed'
  }
  if (progress === 'not_started') {
    return currentStatus === 'completed' ? 'in_progress' : currentStatus
  }
  return currentStatus
}

export function progressFromStatus(status, currentProgress) {
  if (status === 'completed') {
    return 'done'
  }
  if (status === 'in_progress' && currentProgress === 'not_started') {
    return 'started'
  }
  if (status === 'todo' && currentProgress !== 'not_started') {
    return 'not_started'
  }
  return currentProgress
}

export function buildStatusUpdates(nextStatus, existing) {
  let completedAt = existing.completed_at
  let startedAt = existing.started_at
  let variant = existing.variant
  let progress = existing.progress ?? 'not_started'

  if (nextStatus === 'completed' && existing.status !== 'completed') {
    completedAt = new Date().toISOString().slice(0, 10)
    variant = 'completed'
    progress = 'done'
  } else if (nextStatus !== 'completed') {
    completedAt = null
    if (variant === 'completed') {
      variant = 'default'
    }
    progress = progressFromStatus(nextStatus, progress)
  }

  if (nextStatus === 'in_progress' && !startedAt) {
    startedAt = new Date().toISOString()
  }

  return { status: nextStatus, completed_at: completedAt, started_at: startedAt, variant, progress }
}

export function buildProgressUpdates(progress, existing) {
  const nextStatus = statusFromProgress(progress, existing.status)
  const updates = buildStatusUpdates(nextStatus, { ...existing, progress })
  if (progress === 'started' && !existing.started_at) {
    updates.started_at = new Date().toISOString()
  }
  updates.progress = progress
  return updates
}

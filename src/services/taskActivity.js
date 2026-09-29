import { v4 as uuid } from 'uuid'
import { Task } from '../db/models.js'
import { STATUS_RANK } from './taskWorkflow.js'

export const MAX_TASK_ACTIVITY = 50

export function activityEntry(type, actorId, note = null, at = new Date().toISOString()) {
  return { id: uuid(), type, at, actor_id: actorId ?? null, note: note || null }
}

const STATUS_LABELS = { todo: 'To do', in_progress: 'In progress', completed: 'Done' }

/** Activity entry describing a direct column move. */
export function statusChangeEntry(fromStatus, toStatus, actorId, at) {
  if (toStatus === 'completed') return activityEntry('completed', actorId, null, at)
  if (toStatus === 'in_progress' && STATUS_RANK[fromStatus] < STATUS_RANK.in_progress) {
    return activityEntry('started', actorId, null, at)
  }
  return activityEntry('updated', actorId, `Moved to ${STATUS_LABELS[toStatus] ?? toStatus}`, at)
}

/**
 * Builds a Mongo update that sets fields and appends activity (capped).
 * `bumpActivity: false` is used for nudges, which must not hide stalled tasks.
 */
export function buildTaskUpdate(set = {}, entries = [], { bumpActivity = true } = {}) {
  const update = {}
  const $set = { ...set }
  if (entries.length && bumpActivity) {
    $set.last_activity_at = entries[entries.length - 1].at
  }
  if (Object.keys($set).length) update.$set = $set
  if (entries.length) {
    update.$push = { activity: { $each: entries, $slice: -MAX_TASK_ACTIVITY } }
  }
  return update
}

export async function saveTaskChange(taskId, set, entries, options) {
  const update = buildTaskUpdate(set, entries, options)
  if (!Object.keys(update).length) return
  await Task.updateOne({ id: taskId }, update, options?.session ? { session: options.session } : undefined)
}

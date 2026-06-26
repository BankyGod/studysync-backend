import {
  createNotification,
  createNotifications,
  getGroupMemberUserIds,
  getUserDisplayName,
} from './notificationService.js'

function statusLabel(status) {
  if (status === 'in_progress') return 'In Progress'
  if (status === 'completed') return 'Completed'
  return 'To Do'
}

export async function notifyTaskAssigned(io, { group, task, actorId, assigneeId }) {
  if (!assigneeId || assigneeId === actorId) return

  const actorName = await getUserDisplayName(actorId)
  await createNotification(io, {
    userId: assigneeId,
    type: 'task_assigned',
    title: 'Task assigned to you',
    message: `${actorName} assigned you "${task.title}" in ${group.title}.`,
    groupId: group.id,
    groupSlug: group.slug,
    taskId: task.id,
    actorId,
    metadata: { taskTitle: task.title },
  })
}

export async function notifyTaskProgress(io, { group, task, actorId, action, creatorId, assigneeId }) {
  const actorName = await getUserDisplayName(actorId)
  const recipients = new Set()

  if (assigneeId && assigneeId !== actorId) {
    recipients.add(assigneeId)
  }
  if (creatorId && creatorId !== actorId) {
    recipients.add(creatorId)
  }

  if (action === 'start') {
    await createNotifications(io, [...recipients], {
      type: 'task_progress_started',
      title: 'Task started',
      message: `${actorName} started "${task.title}" in ${group.title}.`,
      groupId: group.id,
      groupSlug: group.slug,
      taskId: task.id,
      actorId,
      metadata: { taskTitle: task.title, action },
    })
    return
  }

  if (action === 'complete') {
    await createNotifications(io, [...recipients], {
      type: 'task_progress_done',
      title: 'Task marked done',
      message: `${actorName} marked "${task.title}" as done in ${group.title}.`,
      groupId: group.id,
      groupSlug: group.slug,
      taskId: task.id,
      actorId,
      metadata: { taskTitle: task.title, action },
    })
  }
}

export async function notifyTaskStatusCompleted(io, { group, task, actorId, creatorId, assigneeId }) {
  const actorName = await getUserDisplayName(actorId)
  const recipients = new Set()

  if (assigneeId && assigneeId !== actorId) {
    recipients.add(assigneeId)
  }
  if (creatorId && creatorId !== actorId) {
    recipients.add(creatorId)
  }

  await createNotifications(io, [...recipients], {
    type: 'task_completed',
    title: 'Task completed',
    message: `${actorName} moved "${task.title}" to Completed in ${group.title}.`,
    groupId: group.id,
    groupSlug: group.slug,
    taskId: task.id,
    actorId,
    metadata: { taskTitle: task.title },
  })
}

export async function notifyRegressRequested(io, { group, task, requesterId, creatorId, fromStatus, targetStatus }) {
  if (!creatorId || creatorId === requesterId) return

  const requesterName = await getUserDisplayName(requesterId)
  await createNotification(io, {
    userId: creatorId,
    type: 'task_regress_requested',
    title: 'Move-back approval needed',
    message: `${requesterName} wants to move "${task.title}" from ${statusLabel(fromStatus)} back to ${statusLabel(targetStatus)}.`,
    groupId: group.id,
    groupSlug: group.slug,
    taskId: task.id,
    actorId: requesterId,
    metadata: { fromStatus, targetStatus, taskTitle: task.title },
  })
}

export async function notifyRegressApproved(io, { group, task, resolverId, fromStatus, targetStatus }) {
  const memberIds = await getGroupMemberUserIds(group.id)
  const resolverName = await getUserDisplayName(resolverId)

  await createNotifications(io, memberIds, {
    type: 'task_regress_approved',
    title: 'Task moved back',
    message: `${resolverName} approved moving "${task.title}" from ${statusLabel(fromStatus)} to ${statusLabel(targetStatus)}.`,
    groupId: group.id,
    groupSlug: group.slug,
    taskId: task.id,
    actorId: resolverId,
    metadata: { fromStatus, targetStatus, taskTitle: task.title },
  })
}

export async function notifyRegressRejected(io, { group, task, resolverId, requesterId, fromStatus, targetStatus }) {
  const resolverName = await getUserDisplayName(resolverId)
  await createNotification(io, {
    userId: requesterId,
    type: 'task_regress_rejected',
    title: 'Move-back request denied',
    message: `${resolverName} denied moving "${task.title}" from ${statusLabel(fromStatus)} to ${statusLabel(targetStatus)}.`,
    groupId: group.id,
    groupSlug: group.slug,
    taskId: task.id,
    actorId: resolverId,
    metadata: { fromStatus, targetStatus, taskTitle: task.title },
  })
}

export async function notifyTaskDeleted(io, { group, task, actorId, assigneeId }) {
  if (!assigneeId || assigneeId === actorId) return

  const actorName = await getUserDisplayName(actorId)
  await createNotification(io, {
    userId: assigneeId,
    type: 'task_deleted',
    title: 'Task deleted',
    message: `${actorName} deleted "${task.title}" from ${group.title}.`,
    groupId: group.id,
    groupSlug: group.slug,
    taskId: task.id,
    actorId,
    metadata: { taskTitle: task.title },
  })
}

// Legacy aliases
export const notifyMoveBackRequested = notifyRegressRequested
export const notifyMoveBackApproved = notifyRegressApproved
export const notifyMoveBackDenied = notifyRegressRejected

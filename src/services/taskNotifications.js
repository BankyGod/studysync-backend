import {
  createNotification,
  createNotifications,
  getGroupMemberUserIds,
  getUserDisplayName,
} from './notificationService.js'
import { getGroupLeaderId } from './groupLeaderService.js'

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
  const leaderId = await getGroupLeaderId(group.id)
  const recipientId = leaderId || creatorId
  if (!recipientId || recipientId === requesterId) return

  const requesterName = await getUserDisplayName(requesterId)
  await createNotification(io, {
    userId: recipientId,
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

export async function notifyReviewRequested(io, { group, task, requesterId, leaderId, targetStatus }) {
  if (!leaderId || leaderId === requesterId) return

  const requesterName = await getUserDisplayName(requesterId)
  const step = targetStatus === 'completed' ? 'mark as done' : 'start'
  await createNotification(io, {
    userId: leaderId,
    type: 'task.review_requested',
    title: 'Step needs your approval',
    message: `${requesterName} wants to ${step} "${task.title}" in ${group.title}.`,
    groupId: group.id,
    groupSlug: group.slug,
    taskId: task.id,
    actorId: requesterId,
    metadata: {
      taskTitle: task.title,
      targetStatus,
      from: { id: requesterId, name: requesterName },
    },
  })
}

export async function notifyReviewDecision(io, { group, task, leaderId, recipientId, approved, note }) {
  if (!recipientId || recipientId === leaderId) return

  const leaderName = await getUserDisplayName(leaderId)
  await createNotification(io, {
    userId: recipientId,
    type: approved ? 'task.review_approved' : 'task.changes_requested',
    title: approved ? 'Step approved' : 'Step declined',
    message: approved
      ? `${leaderName} approved your step on "${task.title}".`
      : `${leaderName} declined your step on "${task.title}"${note ? `: ${note}` : '.'}`,
    groupId: group.id,
    groupSlug: group.slug,
    taskId: task.id,
    actorId: leaderId,
    metadata: approved ? { taskTitle: task.title } : { taskTitle: task.title, note: note || null },
  })
}

export async function notifyNudge(io, { group, leaderId, userId, task = null, message }) {
  const leaderName = await getUserDisplayName(leaderId)
  const text = message || (task ? `Reminder about "${task.title}".` : 'Reminder from your pod leader.')
  await createNotification(io, {
    userId,
    type: 'task.nudge',
    title: `Reminder from ${leaderName}`,
    message: text,
    groupId: group.id,
    groupSlug: group.slug,
    taskId: task?.id ?? null,
    actorId: leaderId,
    metadata: {
      taskTitle: task?.title ?? null,
      message: message || '',
      from: { id: leaderId, name: leaderName },
    },
  })
}

export async function notifyAnnouncementUpdated(io, { group, leaderId, text }) {
  const memberIds = await getGroupMemberUserIds(group.id)
  const leaderName = await getUserDisplayName(leaderId)
  await createNotifications(
    io,
    memberIds.filter((id) => id !== leaderId),
    {
      type: 'announcement.updated',
      title: 'New pod announcement',
      message: `${leaderName}: ${text.length > 140 ? `${text.slice(0, 137)}...` : text}`,
      groupId: group.id,
      groupSlug: group.slug,
      actorId: leaderId,
      metadata: { text },
    },
  )
}

// Legacy aliases
export const notifyMoveBackRequested = notifyRegressRequested
export const notifyMoveBackApproved = notifyRegressApproved
export const notifyMoveBackDenied = notifyRegressRejected

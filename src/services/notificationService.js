import { v4 as uuid } from 'uuid'
import { Notification, GroupMember, User } from '../db/models.js'

function formatNotification(doc) {
  return {
    id: doc.id,
    type: doc.type,
    title: doc.title,
    message: doc.message,
    groupId: doc.group_slug,
    taskId: doc.task_id,
    actorId: doc.actor_id,
    read: Boolean(doc.read_at),
    readAt: doc.read_at,
    createdAt: doc.created_at,
    metadata: doc.metadata ?? undefined,
  }
}

export async function getGroupMemberUserIds(groupId) {
  const members = await GroupMember.find({ group_id: groupId }).lean()
  return members.map((member) => member.user_id)
}

export async function getUserDisplayName(userId) {
  const user = await User.findOne({ id: userId }).lean()
  if (!user) return 'Someone'
  return `${user.first_name} ${user.last_name}`.trim()
}

export async function createNotification(io, {
  userId,
  type,
  title,
  message,
  groupId = null,
  groupSlug = null,
  taskId = null,
  actorId = null,
  metadata = null,
}) {
  const now = new Date().toISOString()
  const notification = {
    id: uuid(),
    user_id: userId,
    type,
    title,
    message,
    group_id: groupId,
    group_slug: groupSlug,
    task_id: taskId,
    actor_id: actorId,
    read_at: null,
    created_at: now,
    metadata,
  }

  await Notification.create(notification)
  const formatted = formatNotification(notification)
  io?.to(`user:${userId}`).emit('notification:new', formatted)
  return formatted
}

export async function createNotifications(io, recipients, payload) {
  const uniqueRecipients = [...new Set(recipients.filter(Boolean))]
  return Promise.all(uniqueRecipients.map((userId) => createNotification(io, { ...payload, userId })))
}

export async function notifyExcept(io, recipients, excludeUserId, payload) {
  const filtered = recipients.filter((userId) => userId && userId !== excludeUserId)
  return createNotifications(io, filtered, payload)
}

export { formatNotification }

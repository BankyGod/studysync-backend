import { Task, User, GroupMember, TaskMoveRequest } from './models.js'
import { getInitials, pickAvatarColor } from '../utils/helpers.js'

function taskUserIds(task) {
  const ids = [task.assignee_id, task.creator_id, task.reviewed_by_id, task.pending_advance_request?.requested_by_id]
  for (const entry of task.activity ?? []) ids.push(entry.actor_id)
  return ids.filter(Boolean)
}

export async function fetchTaskRows(groupId, taskId = null) {
  const filter = taskId ? { id: taskId, group_id: groupId } : { group_id: groupId }
  const tasks = await Task.find(filter).sort({ position: 1, created_at: 1 }).lean()

  const userIds = [...new Set(tasks.flatMap(taskUserIds))]
  const [users, members, pendingMoveRequests] = await Promise.all([
    userIds.length ? User.find({ id: { $in: userIds } }).lean() : [],
    userIds.length ? GroupMember.find({ group_id: groupId, user_id: { $in: userIds } }).lean() : [],
    TaskMoveRequest.find({ group_id: groupId, status: 'pending' }).lean(),
  ])

  const userById = Object.fromEntries(users.map((u) => [u.id, u]))
  const memberByUserId = Object.fromEntries(members.map((m) => [m.user_id, m]))
  const pendingByTaskId = Object.fromEntries(pendingMoveRequests.map((request) => [request.task_id, request]))
  const nameOf = (id) => {
    const user = id ? userById[id] : null
    return user ? `${user.first_name} ${user.last_name}`.trim() : null
  }

  return tasks.map((task) => {
    const assigneeMember = task.assignee_id ? memberByUserId[task.assignee_id] : null
    const creatorUser = task.creator_id ? userById[task.creator_id] : null
    const creatorMember = task.creator_id ? memberByUserId[task.creator_id] : null
    const userNames = Object.fromEntries(taskUserIds(task).map((id) => [id, nameOf(id) ?? 'Unknown']))
    return {
      ...task,
      initials: assigneeMember?.initials ?? null,
      avatar_color: assigneeMember?.avatar_color ?? null,
      assignee_name: nameOf(task.assignee_id) ?? '',
      creator_name: nameOf(task.creator_id) ?? '',
      creator_initials:
        creatorMember?.initials ??
        (creatorUser ? getInitials(creatorUser.first_name, creatorUser.last_name) : null),
      creator_color: creatorMember?.avatar_color ?? (task.creator_id ? pickAvatarColor(task.creator_id) : null),
      pending_regress_request: pendingByTaskId[task.id] ?? null,
      user_names: userNames,
    }
  })
}

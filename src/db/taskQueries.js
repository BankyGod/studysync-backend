import { Task, User, GroupMember, TaskMoveRequest } from './models.js'

export async function fetchTaskRows(groupId, taskId = null) {
  const filter = taskId ? { id: taskId, group_id: groupId } : { group_id: groupId }
  const tasks = await Task.find(filter).sort({ position: 1, created_at: 1 }).lean()

  const relatedUserIds = new Set()
  tasks.forEach((task) => {
    if (task.assignee_id) relatedUserIds.add(task.assignee_id)
    if (task.creator_id) relatedUserIds.add(task.creator_id)
  })

  const userIds = [...relatedUserIds]
  const [users, members, pendingMoveRequests] = await Promise.all([
    userIds.length ? User.find({ id: { $in: userIds } }).lean() : [],
    userIds.length ? GroupMember.find({ group_id: groupId, user_id: { $in: userIds } }).lean() : [],
    TaskMoveRequest.find({ group_id: groupId, status: 'pending' }).lean(),
  ])

  const userById = Object.fromEntries(users.map((u) => [u.id, u]))
  const memberByUserId = Object.fromEntries(members.map((m) => [m.user_id, m]))
  const pendingByTaskId = Object.fromEntries(pendingMoveRequests.map((request) => [request.task_id, request]))

  return tasks.map((task) => {
    const assigneeUser = task.assignee_id ? userById[task.assignee_id] : null
    const assigneeMember = task.assignee_id ? memberByUserId[task.assignee_id] : null
    const creatorUser = task.creator_id ? userById[task.creator_id] : null
    const creatorMember = task.creator_id ? memberByUserId[task.creator_id] : null
    return {
      ...task,
      initials: assigneeMember?.initials ?? null,
      avatar_color: assigneeMember?.avatar_color ?? null,
      assignee_name: assigneeUser ? `${assigneeUser.first_name} ${assigneeUser.last_name}`.trim() : '',
      creator_name: creatorUser ? `${creatorUser.first_name} ${creatorUser.last_name}`.trim() : '',
      creator_initials: creatorMember?.initials ?? null,
      creator_color: creatorMember?.avatar_color ?? null,
      pending_regress_request: pendingByTaskId[task.id] ?? null,
    }
  })
}

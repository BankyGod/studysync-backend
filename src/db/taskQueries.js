import { Task, User, GroupMember } from './models.js'

export async function fetchTaskRows(groupId, taskId = null) {
  const filter = taskId ? { id: taskId, group_id: groupId } : { group_id: groupId }
  const tasks = await Task.find(filter).sort({ position: 1, created_at: 1 }).lean()

  const assigneeIds = [...new Set(tasks.map((t) => t.assignee_id).filter(Boolean))]
  const [users, members] = await Promise.all([
    assigneeIds.length ? User.find({ id: { $in: assigneeIds } }).lean() : [],
    assigneeIds.length ? GroupMember.find({ group_id: groupId, user_id: { $in: assigneeIds } }).lean() : [],
  ])

  const userById = Object.fromEntries(users.map((u) => [u.id, u]))
  const memberByUserId = Object.fromEntries(members.map((m) => [m.user_id, m]))

  return tasks.map((task) => {
    const user = task.assignee_id ? userById[task.assignee_id] : null
    const member = task.assignee_id ? memberByUserId[task.assignee_id] : null
    return {
      ...task,
      initials: member?.initials ?? null,
      avatar_color: member?.avatar_color ?? null,
      assignee_name: user ? `${user.first_name} ${user.last_name}`.trim() : '',
    }
  })
}

import { GroupMember, StudyGroup, Task, User } from '../db/models.js'
import { formatCourseLabel } from '../utils/helpers.js'
import { leaderIdFromMembers, normalizeMemberRole } from './groupLeaderService.js'

/** Completion % over all tasks in the pod (dashboard / me/groups). */
export async function computeGroupProgress(groupId) {
  const stats = await Task.aggregate([
    { $match: { group_id: groupId } },
    {
      $group: {
        _id: null,
        total: { $sum: 1 },
        completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
      },
    },
  ])
  const total = stats[0]?.total ?? 0
  const completed = stats[0]?.completed ?? 0
  return {
    total,
    completed,
    progress: total === 0 ? 0 : Math.round((completed / total) * 100),
  }
}

/** Completion % over assigned tasks only (staff task-progress). */
export async function computeAssignedTaskProgress(groupId) {
  const stats = await Task.aggregate([
    {
      $match: {
        group_id: groupId,
        assignee_id: { $nin: [null, ''] },
      },
    },
    {
      $group: {
        _id: null,
        total: { $sum: 1 },
        completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
      },
    },
  ])
  const total = stats[0]?.total ?? 0
  const completed = stats[0]?.completed ?? 0
  return {
    total,
    completed,
    progress: total === 0 ? 0 : Math.round((completed / total) * 100),
  }
}

export async function getTaskProgressReport() {
  const groups = await StudyGroup.find().sort({ created_at: -1 }).lean()
  if (!groups.length) {
    return {
      summary: { pods: 0, avgProgress: 0, podsWithoutLeader: 0 },
      items: [],
    }
  }

  const groupIds = groups.map((g) => g.id)
  const allMembers = await GroupMember.find({ group_id: { $in: groupIds } }).lean()
  const membersByGroup = new Map()
  for (const m of allMembers) {
    if (!membersByGroup.has(m.group_id)) membersByGroup.set(m.group_id, [])
    membersByGroup.get(m.group_id).push(m)
  }

  const leaderIds = [
    ...new Set(
      allMembers.filter((m) => normalizeMemberRole(m.role) === 'leader').map((m) => m.user_id),
    ),
  ]
  const leaders = leaderIds.length
    ? await User.find({ id: { $in: leaderIds } })
        .select('id first_name last_name')
        .lean()
    : []
  const leaderById = Object.fromEntries(leaders.map((u) => [u.id, u]))

  const items = await Promise.all(
    groups.map(async (g) => {
      const members = membersByGroup.get(g.id) ?? []
      const leaderId = leaderIdFromMembers(members)
      const leader = leaderId ? leaderById[leaderId] : null
      const { progress, total, completed } = await computeAssignedTaskProgress(g.id)

      return {
        groupId: g.id,
        slug: g.slug,
        title: g.title,
        course: formatCourseLabel(g.subject, g.course_number),
        progress,
        assignedTotal: total,
        assignedCompleted: completed,
        memberCount: members.length,
        leaderId,
        leaderName: leader ? `${leader.first_name} ${leader.last_name}`.trim() : null,
      }
    }),
  )

  const podsWithoutLeader = items.filter((i) => !i.leaderId).length
  const avgProgress =
    items.length === 0
      ? 0
      : Math.round(items.reduce((sum, i) => sum + i.progress, 0) / items.length)

  return {
    summary: {
      pods: items.length,
      avgProgress,
      podsWithoutLeader,
    },
    items,
  }
}

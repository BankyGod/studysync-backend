import {
  User,
  OnboardingProfile,
  UserCourse,
  StudyGroup,
  GroupMember,
  Task,
  Message,
  StoredFile,
  MatchingJob,
  Cohort,
  UserProfile,
} from '../db/models.js'
import { computeReliabilityBatch, formatReliability } from './reliabilityService.js'
import { formatCourseLabel } from '../utils/helpers.js'
import { avatarUrlForUser } from '../utils/profileAvatar.js'
import {
  leaderIdFromMembers,
  normalizeMemberRole,
} from './groupLeaderService.js'
import { computeAssignedTaskProgress, getTaskProgressReport } from './groupProgressService.js'

/** Matches frontend adminService isDemoOrSeedUser heuristics. */
export function isDemoOrSeedUser(user) {
  if (!user) return false
  const email = String(user.email ?? '').trim().toLowerCase()
  if (email.endsWith('@studysync.local')) return true
  if (/^student\d+@/.test(email)) return true

  const name = `${user.first_name ?? ''} ${user.last_name ?? ''}`.trim()
  if (/^student\s*\d+$/i.test(name)) return true

  const studentId = String(user.student_id ?? '').trim()
  if (/^(seed|demo)[-_]/i.test(studentId)) return true

  return false
}

/** Mongo clause to exclude demo/seed students from admin listings. */
export function realStudentMatch(extra = {}) {
  const { $and: extraAnd, ...rest } = extra
  return {
    role: 'student',
    ...rest,
    $and: [
      ...(Array.isArray(extraAnd) ? extraAnd : []),
      {
        $nor: [
          { email: /@studysync\.local$/i },
          { email: /^student\d+@/i },
          { student_id: /^(seed|demo)[-_]/i },
        ],
      },
    ],
  }
}

function startOfDayIso(date) {
  const d = new Date(date)
  d.setUTCHours(0, 0, 0, 0)
  return d.toISOString().slice(0, 10)
}

function daysAgoIso(days) {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - days)
  d.setUTCHours(0, 0, 0, 0)
  return d.toISOString()
}

function podHealthLabel({ memberCount, completionRate, lastActivityAt }) {
  if (memberCount === 0) return 'empty'
  if (!lastActivityAt) return 'inactive'

  const daysSince =
    (Date.now() - new Date(lastActivityAt).getTime()) / (24 * 60 * 60 * 1000)

  if (daysSince > 14) return 'inactive'
  if (completionRate >= 70 && memberCount >= 2) return 'healthy'
  if (completionRate >= 40 || memberCount >= 2) return 'moderate'
  return 'at_risk'
}

export async function getOverviewReport() {
  const realStudents = await User.find(realStudentMatch()).select('id').lean()
  const realStudentIds = realStudents.map((s) => s.id)
  const realIdSet = new Set(realStudentIds)

  const [
    instructors,
    admins,
    pods,
    cohorts,
    memberships,
    tasksTodo,
    tasksInProgress,
    tasksCompleted,
    messages,
    files,
    matchingJobs,
    matchingCompleted,
    matchingWaiting,
    matchingFailed,
  ] = await Promise.all([
    User.countDocuments({ role: 'instructor' }),
    User.countDocuments({ role: 'admin' }),
    StudyGroup.countDocuments(),
    Cohort.countDocuments(),
    GroupMember.find({ user_id: { $in: realStudentIds } }).lean(),
    Task.countDocuments({ status: 'todo' }),
    Task.countDocuments({ status: 'in_progress' }),
    Task.countDocuments({ status: 'completed' }),
    Message.countDocuments(),
    StoredFile.countDocuments(),
    MatchingJob.countDocuments(),
    MatchingJob.countDocuments({ status: 'completed' }),
    MatchingJob.countDocuments({ status: 'waiting' }),
    MatchingJob.countDocuments({ status: 'failed' }),
  ])

  const matchedStudentIds = new Set(
    memberships.filter((m) => realIdSet.has(m.user_id)).map((m) => m.user_id),
  )

  const students = realStudentIds.length

  return {
    students,
    pods,
    cohorts,
    matched: matchedStudentIds.size,
    users: { students, instructors, admins, total: students + instructors + admins },
    podStats: { total: pods, memberships: memberships.length },
    tasks: {
      todo: tasksTodo,
      inProgress: tasksInProgress,
      completed: tasksCompleted,
      total: tasksTodo + tasksInProgress + tasksCompleted,
    },
    messages,
    files,
    matching: {
      jobs: matchingJobs,
      completed: matchingCompleted,
      waiting: matchingWaiting,
      failed: matchingFailed,
    },
  }
}

export async function getEngagementReport() {
  const students = await User.find(realStudentMatch(), { id: 1 }).lean()
  const studentIds = students.map((s) => s.id)
  const totalStudents = studentIds.length

  if (!totalStudents) {
    return {
      totalStudents: 0,
      matched: 0,
      matchedRate: 0,
      inactive: 0,
      withTasks: 0,
      withMessages: 0,
    }
  }

  const [memberships, taskActors, messageSenders] = await Promise.all([
    GroupMember.find({ user_id: { $in: studentIds } }, { user_id: 1 }).lean(),
    Task.find(
      { $or: [{ assignee_id: { $in: studentIds } }, { creator_id: { $in: studentIds } }] },
      { assignee_id: 1, creator_id: 1 },
    ).lean(),
    Message.find({ sender_id: { $in: studentIds } }, { sender_id: 1 }).lean(),
  ])

  const matchedIds = new Set(memberships.map((m) => m.user_id))
  const taskUserIds = new Set()
  taskActors.forEach((t) => {
    if (t.assignee_id) taskUserIds.add(t.assignee_id)
    if (t.creator_id) taskUserIds.add(t.creator_id)
  })
  const messageUserIds = new Set(messageSenders.map((m) => m.sender_id))

  const inactive = studentIds.filter(
    (id) => !matchedIds.has(id) && !taskUserIds.has(id) && !messageUserIds.has(id),
  ).length

  return {
    totalStudents,
    matched: matchedIds.size,
    matchedRate: Math.round((matchedIds.size / totalStudents) * 100),
    inactive,
    withTasks: [...taskUserIds].filter((id) => matchedIds.has(id) || studentIds.includes(id)).length,
    withMessages: messageUserIds.size,
  }
}

export async function getPodsReport() {
  const groups = await StudyGroup.find().sort({ created_at: -1 }).lean()
  if (!groups.length) return { pods: [] }

  const groupIds = groups.map((g) => g.id)

  const [members, tasks, messages, files] = await Promise.all([
    GroupMember.find({ group_id: { $in: groupIds } }).lean(),
    Task.find({ group_id: { $in: groupIds } }).lean(),
    Message.find({ group_id: { $in: groupIds } }, { group_id: 1, sent_at: 1 }).lean(),
    StoredFile.find({ group_id: { $in: groupIds } }, { group_id: 1, uploaded_at: 1 }).lean(),
  ])

  const membersByGroup = {}
  members.forEach((m) => {
    membersByGroup[m.group_id] = (membersByGroup[m.group_id] || 0) + 1
  })

  const tasksByGroup = {}
  tasks.forEach((t) => {
    if (!tasksByGroup[t.group_id]) {
      tasksByGroup[t.group_id] = { total: 0, completed: 0, latest: null }
    }
    tasksByGroup[t.group_id].total += 1
    if (t.status === 'completed') tasksByGroup[t.group_id].completed += 1
    const stamp = t.completed_at || t.started_at || t.created_at
    if (!tasksByGroup[t.group_id].latest || stamp > tasksByGroup[t.group_id].latest) {
      tasksByGroup[t.group_id].latest = stamp
    }
  })

  const activityByGroup = {}
  messages.forEach((m) => {
    if (!activityByGroup[m.group_id] || m.sent_at > activityByGroup[m.group_id]) {
      activityByGroup[m.group_id] = m.sent_at
    }
  })
  files.forEach((f) => {
    if (!activityByGroup[f.group_id] || f.uploaded_at > activityByGroup[f.group_id]) {
      activityByGroup[f.group_id] = f.uploaded_at
    }
  })

  const pods = groups.map((g) => {
    const memberCount = membersByGroup[g.id] || 0
    const taskInfo = tasksByGroup[g.id] || { total: 0, completed: 0, latest: null }
    const completionRate =
      taskInfo.total === 0 ? 0 : Math.round((taskInfo.completed / taskInfo.total) * 100)

    const candidates = [g.created_at, taskInfo.latest, activityByGroup[g.id]].filter(Boolean)
    const lastActivityAt = candidates.sort().at(-1) || null

    const health = podHealthLabel({ memberCount, completionRate, lastActivityAt })

    return {
      id: g.id,
      groupId: g.slug,
      title: g.title,
      subject: g.subject,
      courseNumber: g.course_number,
      memberCount,
      taskTotal: taskInfo.total,
      taskCompleted: taskInfo.completed,
      completionRate,
      lastActivityAt,
      health,
      createdAt: g.created_at,
    }
  })

  return { pods }
}

export async function getReliabilityReport({ limit = 20 } = {}) {
  const students = await User.find(realStudentMatch())
    .select('id first_name last_name email program level')
    .lean()

  if (!students.length) {
    return { leaderboard: [], atRisk: [] }
  }

  const studentIds = students.map((s) => s.id)
  const reliabilityByUser = await computeReliabilityBatch(studentIds)

  const rows = students
    .map((s) => {
      const reliability = formatReliability(
        reliabilityByUser[s.id] || { score: null, tasksScored: 0, scope: 'global' },
      )
      return {
        id: s.id,
        name: `${s.first_name} ${s.last_name}`.trim(),
        email: s.email,
        program: s.program,
        level: s.level,
        reliability,
      }
    })
    .filter((row) => row.reliability.score !== null)

  const leaderboard = [...rows]
    .sort((a, b) => (b.reliability.score ?? 0) - (a.reliability.score ?? 0))
    .slice(0, limit)

  const atRisk = [...rows]
    .filter((row) => (row.reliability.score ?? 100) < 60)
    .sort((a, b) => (a.reliability.score ?? 0) - (b.reliability.score ?? 0))
    .slice(0, limit)

  return { leaderboard, atRisk }
}

export async function getCoursesReport() {
  const [courses, groups] = await Promise.all([
    UserCourse.aggregate([
      {
        $group: {
          _id: { subject: '$subject', course_number: '$course_number' },
          studentCount: { $sum: 1 },
        },
      },
      { $sort: { studentCount: -1 } },
    ]),
    StudyGroup.find().lean(),
  ])

  const podsByCourse = {}
  groups.forEach((g) => {
    const key = `${g.subject}::${g.course_number}`
    podsByCourse[key] = (podsByCourse[key] || 0) + 1
  })

  const courseMap = new Map()

  courses.forEach((c) => {
    const key = `${c._id.subject}::${c._id.course_number}`
    courseMap.set(key, {
      subject: c._id.subject,
      courseNumber: c._id.course_number,
      studentCount: c.studentCount,
      podCount: podsByCourse[key] || 0,
    })
  })

  groups.forEach((g) => {
    const key = `${g.subject}::${g.course_number}`
    if (!courseMap.has(key)) {
      courseMap.set(key, {
        subject: g.subject,
        courseNumber: g.course_number,
        studentCount: 0,
        podCount: podsByCourse[key] || 0,
      })
    }
  })

  return { courses: [...courseMap.values()] }
}

export async function getActivityReport({ days = 30 } = {}) {
  const safeDays = Math.min(90, Math.max(1, Number(days) || 30))
  const since = daysAgoIso(safeDays)

  const [users, matches, messages, tasks] = await Promise.all([
    User.find({ role: 'student', created_at: { $gte: since } }, { created_at: 1 }).lean(),
    MatchingJob.find(
      { status: 'completed', completed_at: { $gte: since } },
      { completed_at: 1 },
    ).lean(),
    Message.find({ sent_at: { $gte: since } }, { sent_at: 1 }).lean(),
    Task.find(
      { status: 'completed', completed_at: { $gte: since } },
      { completed_at: 1 },
    ).lean(),
  ])

  const buckets = {}
  for (let i = 0; i < safeDays; i += 1) {
    const d = new Date()
    d.setUTCDate(d.getUTCDate() - (safeDays - 1 - i))
    const key = startOfDayIso(d)
    buckets[key] = { date: key, signups: 0, matchesCompleted: 0, messages: 0, tasksCompleted: 0 }
  }

  users.forEach((u) => {
    const key = startOfDayIso(u.created_at)
    if (buckets[key]) buckets[key].signups += 1
  })
  matches.forEach((m) => {
    const key = startOfDayIso(m.completed_at)
    if (buckets[key]) buckets[key].matchesCompleted += 1
  })
  messages.forEach((m) => {
    const key = startOfDayIso(m.sent_at)
    if (buckets[key]) buckets[key].messages += 1
  })
  tasks.forEach((t) => {
    const key = startOfDayIso(t.completed_at)
    if (buckets[key]) buckets[key].tasksCompleted += 1
  })

  return {
    days: safeDays,
    series: Object.values(buckets),
  }
}

/**
 * Full printable report bundle for GET /admin/reports
 * (shape expected by frontend AdminReportsPage / fetchAdminReportBundle).
 */
export async function getAdminReportBundle() {
  const [overview, cohorts, groups, students, taskProgress] = await Promise.all([
    getOverviewReport(),
    buildCohortsForReport(),
    buildGroupsForReport(),
    buildStudentsForReport(),
    getTaskProgressReport(),
  ])

  return {
    generatedAt: new Date().toISOString(),
    summary: {
      students: overview.students,
      pods: overview.pods,
      cohorts: overview.cohorts,
      matched: overview.matched,
      podsWithoutLeader: taskProgress.summary.podsWithoutLeader,
      avgProgress: taskProgress.summary.avgProgress,
    },
    cohorts,
    groups,
    students,
    taskProgress: taskProgress.items,
    overview,
  }
}

async function buildCohortsForReport() {
  const cohorts = await Cohort.find().sort({ created_at: -1 }).lean()
  return Promise.all(
    cohorts.map(async (c) => {
      const groups = await StudyGroup.find({ cohort_id: c.id }, { id: 1, slug: 1, title: 1 }).lean()
      const groupIds = groups.map((g) => g.id)
      const memberUserIds = groupIds.length
        ? await GroupMember.distinct('user_id', { group_id: { $in: groupIds } })
        : []
      const realMembers = memberUserIds.length
        ? await User.find(realStudentMatch({ id: { $in: memberUserIds } }))
            .select('id')
            .lean()
        : []

      return {
        id: c.id,
        name: c.name,
        term: c.term,
        studentCount: realMembers.length,
        podCount: groups.length,
        groupCount: groups.length,
        pods: groups.map((g) => ({ id: g.id, groupId: g.slug, title: g.title })),
        createdAt: c.created_at,
      }
    }),
  )
}

async function buildGroupsForReport() {
  const [groups, cohorts] = await Promise.all([
    StudyGroup.find().sort({ created_at: -1 }).lean(),
    Cohort.find().lean(),
  ])
  const cohortById = Object.fromEntries(cohorts.map((c) => [c.id, c]))

  if (!groups.length) return []

  const groupIds = groups.map((g) => g.id)
  const allMembers = await GroupMember.find({ group_id: { $in: groupIds } }).lean()
  const userIds = [...new Set(allMembers.map((m) => m.user_id))]
  const users = userIds.length
    ? await User.find({ id: { $in: userIds } })
        .select('id first_name last_name email program level student_id')
        .lean()
    : []
  const userById = Object.fromEntries(users.map((u) => [u.id, u]))

  const membersByGroup = new Map()
  for (const m of allMembers) {
    if (!membersByGroup.has(m.group_id)) membersByGroup.set(m.group_id, [])
    membersByGroup.get(m.group_id).push(m)
  }

  return Promise.all(
    groups.map(async (g) => {
      const rawMembers = membersByGroup.get(g.id) ?? []
      const members = rawMembers
        .map((m) => {
          const u = userById[m.user_id]
          if (u && isDemoOrSeedUser(u)) return null
          const role = normalizeMemberRole(m.role)
          return {
            id: m.user_id,
            name: u ? `${u.first_name} ${u.last_name}`.trim() : 'Unknown',
            email: u?.email,
            program: u?.program,
            level: u?.level,
            initials: m.initials,
            role,
            isLeader: role === 'leader',
          }
        })
        .filter(Boolean)

      const leader = members.find((m) => m.isLeader) ?? null
      const leaderId = leader?.id ?? null
      const { progress } = await computeAssignedTaskProgress(g.id)
      const cohort = g.cohort_id ? cohortById[g.cohort_id] : null
      const course = formatCourseLabel(g.subject, g.course_number)

      return {
        id: g.id,
        groupId: g.slug,
        title: g.title,
        subject: g.subject,
        courseNumber: g.course_number,
        course,
        courseCode: course,
        cohortId: g.cohort_id,
        cohortName: cohort?.name ?? null,
        memberCount: members.length,
        members,
        leader,
        leaderId,
        progress,
        hasLeader: Boolean(leader),
        createdAt: g.created_at,
      }
    }),
  )
}

async function buildStudentsForReport() {
  const students = await User.find(realStudentMatch()).sort({ created_at: -1 }).lean()
  if (!students.length) return []

  const studentIds = students.map((s) => s.id)
  const [onboarding, memberships, profiles] = await Promise.all([
    OnboardingProfile.find({ user_id: { $in: studentIds } }).lean(),
    GroupMember.find({ user_id: { $in: studentIds } }).lean(),
    UserProfile.find({ user_id: { $in: studentIds } })
      .select('user_id avatar_mime_type avatar_storage_key avatar_byte_length')
      .lean(),
  ])

  const onboardingByUser = Object.fromEntries(onboarding.map((o) => [o.user_id, o]))
  const profileByUser = Object.fromEntries(profiles.map((p) => [p.user_id, p]))
  const groupIds = [...new Set(memberships.map((m) => m.group_id))]
  const groups = groupIds.length
    ? await StudyGroup.find({ id: { $in: groupIds } }, { id: 1, slug: 1, title: 1 }).lean()
    : []
  const groupById = Object.fromEntries(groups.map((g) => [g.id, g]))

  return students.map((s) => {
    const userGroups = memberships
      .filter((m) => m.user_id === s.id)
      .map((m) => groupById[m.group_id])
      .filter(Boolean)
      .map((g) => ({ id: g.id, groupId: g.slug, title: g.title }))

    return {
      id: s.id,
      name: `${s.first_name} ${s.last_name}`.trim(),
      email: s.email,
      studentId: s.student_id,
      program: s.program,
      level: s.level,
      university: s.university,
      onboardingCompleted: Boolean(onboardingByUser[s.id]?.completed_at),
      matched: userGroups.length > 0,
      groups: userGroups,
      avatarUrl: avatarUrlForUser(s.id, profileByUser[s.id]),
      createdAt: s.created_at,
    }
  })
}

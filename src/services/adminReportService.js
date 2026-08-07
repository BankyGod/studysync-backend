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
} from '../db/models.js'
import { computeReliabilityBatch, formatReliability } from './reliabilityService.js'

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
  const [
    students,
    instructors,
    admins,
    pods,
    memberships,
    cohorts,
    matchedStudents,
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
    User.countDocuments({ role: 'student' }),
    User.countDocuments({ role: 'instructor' }),
    User.countDocuments({ role: 'admin' }),
    StudyGroup.countDocuments(),
    GroupMember.countDocuments(),
    Cohort.countDocuments(),
    GroupMember.distinct('user_id').then((ids) => ids.length),
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

  return {
    // Flat card fields (Instructor overview: Students / Pods / Cohorts / Matched)
    students,
    pods,
    cohorts,
    matched: matchedStudents,
    users: { students, instructors, admins, total: students + instructors + admins },
    podStats: { total: pods, memberships },
    tasks: {
      todo: tasksTodo,
      inProgress: tasksInProgress,
      completed: tasksCompleted,
      total: tasksTodo + tasksInProgress + tasksCompleted,
    },
    messages,
    files,
    matching: {
      total: matchingJobs,
      completed: matchingCompleted,
      waiting: matchingWaiting,
      failed: matchingFailed,
    },
  }
}

export async function getEngagementReport() {
  const students = await User.find({ role: 'student' }, { id: 1 }).lean()
  const studentIds = students.map((s) => s.id)
  const totalStudents = studentIds.length

  if (totalStudents === 0) {
    return {
      totalStudents: 0,
      onboardingCompleted: 0,
      onboardingRate: 0,
      matched: 0,
      matchedRate: 0,
      withAssignedTasks: 0,
      withMessages: 0,
      inactiveStudents: 0,
    }
  }

  const [onboarded, memberships, assignedTasks, messages] = await Promise.all([
    OnboardingProfile.countDocuments({
      user_id: { $in: studentIds },
      completed_at: { $ne: null },
    }),
    GroupMember.find({ user_id: { $in: studentIds } }, { user_id: 1 }).lean(),
    Task.find({ assignee_id: { $in: studentIds } }, { assignee_id: 1 }).lean(),
    Message.find({ sender_id: { $in: studentIds } }, { sender_id: 1 }).lean(),
  ])

  const matchedIds = new Set(memberships.map((m) => m.user_id))
  const taskUserIds = new Set(assignedTasks.map((t) => t.assignee_id).filter(Boolean))
  const messageUserIds = new Set(messages.map((m) => m.sender_id))

  const inactiveStudents = studentIds.filter(
    (id) => !matchedIds.has(id) && !taskUserIds.has(id) && !messageUserIds.has(id),
  ).length

  return {
    totalStudents,
    onboardingCompleted: onboarded,
    onboardingRate: Math.round((onboarded / totalStudents) * 100),
    matched: matchedIds.size,
    matchedRate: Math.round((matchedIds.size / totalStudents) * 100),
    withAssignedTasks: taskUserIds.size,
    withMessages: messageUserIds.size,
    inactiveStudents,
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
  const students = await User.find({ role: 'student' })
    .select('id first_name last_name email program level')
    .lean()

  if (!students.length) {
    return { leaderboard: [], atRisk: [] }
  }

  const studentIds = students.map((s) => s.id)
  const reliabilityByUser = await computeReliabilityBatch(studentIds)

  const rows = students
    .map((s) => {
      const reliability = formatReliability(reliabilityByUser[s.id] || { score: null, tasksScored: 0, scope: 'global' })
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

  const coursesReport = [...courseMap.values()].sort((a, b) => b.studentCount - a.studentCount)

  return { courses: coursesReport }
}

export async function getActivityReport({ days = 30 } = {}) {
  const safeDays = Math.min(90, Math.max(1, Number(days) || 30))
  const since = daysAgoIso(safeDays)

  const [users, matches, messages, tasks] = await Promise.all([
    User.find({ created_at: { $gte: since } }, { created_at: 1 }).lean(),
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

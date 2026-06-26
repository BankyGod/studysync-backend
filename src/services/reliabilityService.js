import { Task, TaskRegressRequest, StudyGroup } from '../db/models.js'

const MIN_TASKS_SCORED = 3
const MS_PER_DAY = 24 * 60 * 60 * 1000
const START_BONUS_WINDOW_MS = 48 * 60 * 60 * 1000

export function reliabilityLabel(score) {
  if (score === null || score === undefined) return 'Not enough data'
  if (score >= 90) return 'Highly reliable'
  if (score >= 75) return 'Reliable'
  if (score >= 60) return 'Moderate'
  if (score >= 40) return 'Building trust'
  return 'Needs improvement'
}

export function formatReliability(result) {
  return {
    score: result.score,
    tasksScored: result.tasksScored,
    label: reliabilityLabel(result.score),
    scope: result.scope,
    ...(result.groupId ? { groupId: result.groupId } : {}),
  }
}

function parseDate(value) {
  if (!value) return null
  const date = new Date(value.includes('T') ? value : `${value}T00:00:00`)
  return Number.isNaN(date.getTime()) ? null : date
}

function taskWeight(task, now) {
  const created = new Date(task.created_at)
  const ageDays = (now.getTime() - created.getTime()) / MS_PER_DAY
  if (ageDays <= 30) return 1
  if (ageDays <= 90) return 0.7
  return 0.4
}

function isScorableTask(task, now) {
  if (task.status === 'completed') return true

  if (task.due_date) {
    const due = parseDate(task.due_date)
    if (due && due < now) return true
  }

  return false
}

function scoreTask(task, regressedAfterComplete, now) {
  if (task.status !== 'completed') {
    if (task.due_date) {
      const due = parseDate(task.due_date)
      if (due && due < now) return 0
    }
    return null
  }

  let score

  if (!task.due_date) {
    score = 85
  } else {
    const completed = parseDate(task.completed_at)
    const due = parseDate(task.due_date)
    if (!completed || !due) {
      score = 85
    } else if (completed <= due) {
      score = 100
    } else {
      const daysLate = Math.ceil((completed.getTime() - due.getTime()) / MS_PER_DAY)
      score = Math.max(40, 100 - daysLate * 15)
    }
  }

  if (task.started_at) {
    const created = new Date(task.created_at)
    const started = new Date(task.started_at)
    if (started.getTime() - created.getTime() <= START_BONUS_WINDOW_MS) {
      score = Math.min(100, score + 5)
    }
  }

  if (regressedAfterComplete) {
    score -= 10
  }

  return Math.max(0, Math.min(100, score))
}

function aggregateScores(taskScores) {
  if (taskScores.length < MIN_TASKS_SCORED) {
    return { score: null, tasksScored: taskScores.length }
  }

  let weightedSum = 0
  let weightTotal = 0
  taskScores.forEach(({ score, weight }) => {
    weightedSum += score * weight
    weightTotal += weight
  })

  const score = weightTotal === 0 ? null : Math.round(weightedSum / weightTotal)
  return { score, tasksScored: taskScores.length }
}

async function resolveGroupScope(groupIdOrSlug) {
  if (!groupIdOrSlug) return null

  const group = await StudyGroup.findOne({
    $or: [{ id: groupIdOrSlug }, { slug: groupIdOrSlug }],
  }).lean()

  if (!group) return null
  return { internalId: group.id, slug: group.slug }
}

function computeFromTasks(tasks, regressedTaskIds, groupSlug, now) {
  const taskScores = []

  tasks.forEach((task) => {
    if (!isScorableTask(task, now)) return

    const taskScore = scoreTask(task, regressedTaskIds.has(task.id), now)
    if (taskScore === null) return

    taskScores.push({
      score: taskScore,
      weight: taskWeight(task, now),
    })
  })

  const { score, tasksScored } = aggregateScores(taskScores)

  return {
    score,
    tasksScored,
    scope: groupSlug ? 'group' : 'global',
    ...(groupSlug ? { groupId: groupSlug } : {}),
  }
}

export async function computeUserReliability(userId, groupIdOrSlug = null) {
  const groupScope = await resolveGroupScope(groupIdOrSlug)
  const now = new Date()

  const filter = { assignee_id: userId }
  if (groupScope) {
    filter.group_id = groupScope.internalId
  }

  const tasks = await Task.find(filter).lean()
  const taskIds = tasks.map((task) => task.id)

  const regressions =
    taskIds.length === 0
      ? []
      : await TaskRegressRequest.find({
          task_id: { $in: taskIds },
          status: 'approved',
          from_status: 'completed',
        }).lean()

  const regressedTaskIds = new Set(regressions.map((request) => request.task_id))

  return computeFromTasks(tasks, regressedTaskIds, groupScope?.slug ?? null, now)
}

export async function computeReliabilityBatch(userIds, groupInternalId = null, groupSlug = null) {
  if (!userIds.length) return {}

  const now = new Date()
  const filter = { assignee_id: { $in: userIds } }
  if (groupInternalId) {
    filter.group_id = groupInternalId
  }

  const tasks = await Task.find(filter).lean()
  const taskIds = tasks.map((task) => task.id)

  const regressions =
    taskIds.length === 0
      ? []
      : await TaskRegressRequest.find({
          task_id: { $in: taskIds },
          status: 'approved',
          from_status: 'completed',
        }).lean()

  const regressedTaskIds = new Set(regressions.map((request) => request.task_id))
  const tasksByUser = Object.fromEntries(userIds.map((id) => [id, []]))

  tasks.forEach((task) => {
    if (tasksByUser[task.assignee_id]) {
      tasksByUser[task.assignee_id].push(task)
    }
  })

  const results = {}
  userIds.forEach((userId) => {
    results[userId] = computeFromTasks(tasksByUser[userId] ?? [], regressedTaskIds, groupSlug, now)
  })

  return results
}

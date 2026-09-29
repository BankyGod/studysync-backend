import { Router } from 'express'
import { v4 as uuid } from 'uuid'
import mongoose from 'mongoose'
import { Task, TaskRegressRequest, TASK_PRIORITIES } from '../../db/models.js'
import { fetchTaskRows } from '../../db/taskQueries.js'
import { authRequired, requireGroupMember } from '../../middleware/auth.js'
import {
  notFound,
  validationError,
  forbidden,
  conflict,
  regressRequiresApproval,
  advanceRequiresApproval,
  advanceAlreadyPending,
  taskNotAwaitingReview,
} from '../../utils/errors.js'
import { pickAvatarColor } from '../../utils/helpers.js'
import { normalizeAvatarColor } from '../../utils/profileAvatar.js'
import {
  STATUS_RANK,
  buildProgressUpdates,
  buildStatusUpdates,
  isBackwardStatusMove,
} from '../../services/taskWorkflow.js'
import {
  notifyRegressApproved,
  notifyRegressRejected,
  notifyRegressRequested,
  notifyReviewDecision,
  notifyReviewRequested,
  notifyTaskAssigned,
  notifyTaskDeleted,
  notifyTaskProgress,
  notifyTaskStatusCompleted,
} from '../../services/taskNotifications.js'
import { getUserDisplayName } from '../../services/notificationService.js'
import { getGroupLeaderId } from '../../services/groupLeaderService.js'
import {
  activityEntry,
  buildTaskUpdate,
  saveTaskChange,
  statusChangeEntry,
} from '../../services/taskActivity.js'

const router = Router({ mergeParams: true })

router.use(authRequired, requireGroupMember)

const REVIEW_NOTE_MAX = 500

function actorRef(id, names) {
  return id ? { id, name: names?.[id] ?? 'Unknown' } : null
}

export function formatTask(row) {
  const names = row.user_names ?? {}
  const task = {
    id: row.id,
    title: row.title,
    status: row.status,
    variant: row.variant,
    createdAt: row.created_at,
    priority: row.priority ?? null,
    startedAt: row.started_at ?? null,
    lastActivityAt: row.last_activity_at ?? row.completed_at ?? row.started_at ?? row.created_at,
    reviewStatus: row.review_status ?? null,
    reviewNote: row.review_note ?? null,
    reviewedAt: row.reviewed_at ?? null,
    reviewedBy: actorRef(row.reviewed_by_id, names),
    pendingAdvanceRequest: null,
    activity: (row.activity ?? []).map((entry) => ({
      id: entry.id,
      type: entry.type,
      at: entry.at,
      actor: actorRef(entry.actor_id, names),
      ...(entry.note ? { note: entry.note } : {}),
    })),
  }
  if (row.due_date) task.dueDate = row.due_date
  if (row.completed_at) task.completedAt = row.completed_at
  if (row.creator_id) {
    task.createdBy = {
      id: row.creator_id,
      initials:
        row.creator_initials ??
        (row.creator_name
          ? row.creator_name
              .split(/\s+/)
              .map((part) => part[0]?.toUpperCase() ?? '')
              .join('')
              .slice(0, 2) || '??'
          : '??'),
      name: row.creator_name || 'Unknown',
      color: normalizeAvatarColor(row.creator_color ?? pickAvatarColor(row.creator_id), row.creator_id),
    }
  }
  if (row.assignee_id) {
    task.assignee = {
      id: row.assignee_id,
      initials: row.initials,
      name: row.assignee_name,
      color: normalizeAvatarColor(row.avatar_color, row.assignee_id),
    }
  }
  const advance = row.pending_advance_request
  if (advance) {
    task.pendingAdvanceRequest = {
      id: advance.id,
      fromStatus: advance.from_status,
      targetStatus: advance.target_status,
      requestedAt: advance.requested_at,
      requestedBy: actorRef(advance.requested_by_id, names),
    }
  }
  const pending = row.pending_regress_request
  if (pending) {
    task.pendingRegressRequest = {
      requestId: pending.id,
      requesterId: pending.requester_id,
      fromStatus: pending.from_status,
      targetStatus: pending.target_status,
      createdAt: pending.created_at,
    }
  }
  return task
}

function groupTasksByStatus(rows) {
  const result = { todo: [], in_progress: [], completed: [] }
  rows.forEach((row) => {
    result[row.status].push(formatTask(row))
  })
  return result
}

function isOwnTask(task, userId) {
  return Boolean(task.creator_id) && task.creator_id === userId
}

/** Leader state for the caller, cached per request. */
async function leaderContext(req) {
  if (!req.leaderContext) {
    const leaderId = await getGroupLeaderId(req.group.id)
    req.leaderContext = {
      leaderId,
      hasLeader: Boolean(leaderId),
      isLeader: Boolean(leaderId) && leaderId === req.user.id,
    }
  }
  return req.leaderContext
}

/**
 * Column moves: backward needs the leader (regress flow); forward needs the leader
 * in pods that have one (step approval). Leaderless pods keep direct forward moves.
 */
function assertStatusMoveAllowed(existing, nextStatus, ctx) {
  if (!nextStatus || nextStatus === existing.status) return
  if (ctx.isLeader) return

  const details = { taskId: existing.id, fromStatus: existing.status, targetStatus: nextStatus }
  if (isBackwardStatusMove(existing.status, nextStatus)) {
    throw regressRequiresApproval('Moving this task backward requires approval from the group leader.', details)
  }
  if (ctx.hasLeader) {
    throw advanceRequiresApproval('Moving this task forward requires approval from the group leader.', details)
  }
}

/** Fields that clear a waiting step request when the leader moves the task directly. */
function clearedAdvanceFields(existing) {
  if (!existing.pending_advance_request) return {}
  return { pending_advance_request: null, review_status: null }
}

function normalizePriority(value) {
  if (value === undefined) return undefined
  if (value === null || value === '') return null
  const normalized = String(value).trim().toLowerCase()
  if (!TASK_PRIORITIES.includes(normalized)) {
    throw validationError(`priority must be one of ${TASK_PRIORITIES.join(', ')} or null`)
  }
  return normalized
}

async function nextPositionInColumn(groupId, status) {
  const last = await Task.findOne({ group_id: groupId, status }).sort({ position: -1 }).lean()
  return (last?.position ?? -1) + 1
}

async function loadFormattedTask(req, taskId) {
  const row = (await fetchTaskRows(req.group.id, taskId))[0]
  return row ? formatTask(row) : null
}

function broadcastTask(req, task) {
  req.app.get('io')?.to(`workspace:${req.group.slug}`).emit('task:updated', { groupId: req.group.slug, task })
}

async function findTask(req) {
  const existing = await Task.findOne({ id: req.params.taskId, group_id: req.group.id }).lean()
  if (!existing) throw notFound('Task not found')
  return existing
}

async function createRegressRequest(req, existing, targetStatus) {
  const pending = await TaskRegressRequest.findOne({ task_id: existing.id, status: 'pending' }).lean()
  if (pending) {
    throw conflict('A regress request is already pending for this task')
  }

  const now = new Date().toISOString()
  const requestId = uuid()
  await TaskRegressRequest.create({
    id: requestId,
    task_id: existing.id,
    group_id: req.group.id,
    requester_id: req.user.id,
    from_status: existing.status,
    target_status: targetStatus,
    status: 'pending',
    created_at: now,
  })
  await saveTaskChange(existing.id, {}, [activityEntry('regress_requested', req.user.id, null, now)])

  const requesterName = await getUserDisplayName(req.user.id)
  const io = req.app.get('io')
  await notifyRegressRequested(io, {
    group: req.group,
    task: existing,
    requesterId: req.user.id,
    creatorId: existing.creator_id,
    fromStatus: existing.status,
    targetStatus,
  })

  io?.to(`workspace:${req.group.slug}`).emit('task:regress-requested', {
    groupId: req.group.slug,
    taskId: existing.id,
    request: {
      requestId,
      requesterId: req.user.id,
      requesterName,
      fromStatus: existing.status,
      targetStatus,
      createdAt: now,
    },
  })
  const task = await loadFormattedTask(req, existing.id)
  if (task) broadcastTask(req, task)

  return { requestId, taskId: existing.id, fromStatus: existing.status, targetStatus, status: 'pending' }
}

router.get('/', async (req, res, next) => {
  try {
    const rows = await fetchTaskRows(req.group.id)
    res.json(groupTasksByStatus(rows))
  } catch (error) {
    next(error)
  }
})

router.put('/reorder', async (req, res, next) => {
  const session = await mongoose.startSession()
  try {
    const { tasks } = req.body ?? {}
    if (!Array.isArray(tasks)) {
      throw validationError('tasks array is required')
    }

    const existingTasks = await Task.find({ group_id: req.group.id }).lean()
    const existingById = Object.fromEntries(existingTasks.map((task) => [task.id, task]))
    const ctx = await leaderContext(req)

    for (const item of tasks) {
      const existing = existingById[item.id]
      if (!existing) {
        throw notFound(`Task not found: ${item.id}`)
      }
      assertStatusMoveAllowed(existing, item.status, ctx)
    }

    session.startTransaction()

    const now = new Date().toISOString()
    for (const [index, item] of tasks.entries()) {
      const existing = existingById[item.id]
      const moved = Boolean(item.status) && item.status !== existing.status
      const set = {
        ...(moved ? buildStatusUpdates(item.status, existing) : {}),
        ...(moved ? clearedAdvanceFields(existing) : {}),
        position: item.position ?? index,
      }
      const entries = moved ? [statusChangeEntry(existing.status, item.status, req.user.id, now)] : []
      await Task.updateOne({ id: item.id, group_id: req.group.id }, buildTaskUpdate(set, entries), { session })
    }

    await session.commitTransaction()

    const rows = await fetchTaskRows(req.group.id)
    const io = req.app.get('io')

    for (const item of tasks) {
      const existing = existingById[item.id]
      if (!existing || !item.status || item.status === existing.status) continue

      const row = rows.find((entry) => entry.id === item.id)
      if (!row) continue
      const task = formatTask(row)

      if (item.status === 'completed') {
        await notifyTaskStatusCompleted(io, {
          group: req.group,
          task,
          actorId: req.user.id,
          creatorId: existing.creator_id,
          assigneeId: existing.assignee_id,
        })
      }

      broadcastTask(req, task)
    }

    res.json(groupTasksByStatus(rows))
  } catch (error) {
    if (session.inTransaction()) await session.abortTransaction()
    next(error)
  } finally {
    session.endSession()
  }
})

router.post('/', async (req, res, next) => {
  try {
    const { title, dueDate, assigneeId } = req.body ?? {}
    if (!title?.trim()) {
      throw validationError('Task title is required')
    }

    const ctx = await leaderContext(req)
    const canSetSchedule = ctx.isLeader || !ctx.hasLeader
    const priority = canSetSchedule ? normalizePriority(req.body?.priority) ?? null : null

    const position = await nextPositionInColumn(req.group.id, 'todo')
    const taskId = uuid()
    const now = new Date().toISOString()
    const activity = [activityEntry('created', req.user.id, null, now)]
    if (assigneeId) activity.push(activityEntry('assigned', req.user.id, null, now))

    await Task.create({
      id: taskId,
      group_id: req.group.id,
      creator_id: req.user.id,
      title: title.trim(),
      status: 'todo',
      progress: 'not_started',
      variant: 'default',
      due_date: canSetSchedule ? dueDate || null : null,
      priority,
      assignee_id: assigneeId || null,
      position,
      last_activity_at: now,
      activity,
      created_at: now,
    })

    const task = await loadFormattedTask(req, taskId)
    const io = req.app.get('io')
    io?.to(`workspace:${req.group.slug}`).emit('task:created', { groupId: req.group.slug, task })

    if (assigneeId) {
      await notifyTaskAssigned(io, {
        group: req.group,
        task,
        actorId: req.user.id,
        assigneeId,
      })
    }

    res.status(201).json(task)
  } catch (error) {
    next(error)
  }
})

router.post('/:taskId/progress', async (req, res, next) => {
  try {
    const existing = await findTask(req)

    const { action } = req.body ?? {}
    if (!['start', 'complete'].includes(action)) {
      throw validationError('action must be start or complete')
    }

    const ctx = await leaderContext(req)
    const targetStatus = action === 'start' ? 'in_progress' : 'completed'
    const io = req.app.get('io')

    if (!ctx.isLeader) {
      if (!existing.assignee_id) {
        throw validationError('Task must have an assignee to update progress')
      }
      if (existing.assignee_id !== req.user.id) {
        throw forbidden('Only the assignee or the group leader can update task progress')
      }
    }

    if (ctx.hasLeader && !ctx.isLeader) {
      if (existing.pending_advance_request) {
        throw advanceAlreadyPending(undefined, { taskId: existing.id })
      }
      if (STATUS_RANK[targetStatus] <= STATUS_RANK[existing.status]) {
        throw validationError(`Task is already ${existing.status === 'completed' ? 'done' : 'in progress'}`)
      }

      const now = new Date().toISOString()
      const request = {
        id: uuid(),
        from_status: existing.status,
        target_status: targetStatus,
        requested_at: now,
        requested_by_id: req.user.id,
      }
      await saveTaskChange(
        existing.id,
        { pending_advance_request: request, review_status: 'pending', review_note: null },
        [activityEntry(action === 'start' ? 'start_requested' : 'completion_requested', req.user.id, null, now)],
      )

      const task = await loadFormattedTask(req, existing.id)
      broadcastTask(req, task)
      await notifyReviewRequested(io, {
        group: req.group,
        task: existing,
        requesterId: req.user.id,
        leaderId: ctx.leaderId,
        targetStatus,
      })

      res.status(202).json(task)
      return
    }

    const now = new Date().toISOString()
    const updates = {
      ...buildProgressUpdates(action === 'start' ? 'started' : 'done', existing),
      ...clearedAdvanceFields(existing),
    }
    if (updates.status !== existing.status) {
      updates.position = await nextPositionInColumn(req.group.id, updates.status)
    }
    await saveTaskChange(existing.id, updates, [
      activityEntry(action === 'start' ? 'started' : 'completed', req.user.id, null, now),
    ])

    const task = await loadFormattedTask(req, existing.id)
    broadcastTask(req, task)
    await notifyTaskProgress(io, {
      group: req.group,
      task,
      actorId: req.user.id,
      action,
      creatorId: existing.creator_id,
      assigneeId: existing.assignee_id,
    })
    if (action === 'complete') {
      await notifyTaskStatusCompleted(io, {
        group: req.group,
        task,
        actorId: req.user.id,
        creatorId: existing.creator_id,
        assigneeId: existing.assignee_id,
      })
    }

    res.json(task)
  } catch (error) {
    next(error)
  }
})

router.post('/:taskId/review', async (req, res, next) => {
  try {
    const existing = await findTask(req)
    const ctx = await leaderContext(req)
    if (!ctx.isLeader) {
      throw forbidden('Only the group leader can approve or decline steps')
    }

    const { decision } = req.body ?? {}
    if (!['approved', 'changes_requested'].includes(decision)) {
      throw validationError('decision must be approved or changes_requested')
    }
    const note = String(req.body?.note ?? '').trim()
    if (note.length > REVIEW_NOTE_MAX) {
      throw validationError(`note must be at most ${REVIEW_NOTE_MAX} characters`)
    }

    const request = existing.pending_advance_request
    if (!request) {
      throw taskNotAwaitingReview()
    }

    const now = new Date().toISOString()
    const approved = decision === 'approved'
    const reviewFields = {
      pending_advance_request: null,
      review_status: decision,
      review_note: approved ? null : note || null,
      reviewed_at: now,
      reviewed_by_id: req.user.id,
    }

    let set = reviewFields
    if (approved) {
      const target = request.target_status
      const statusUpdates = buildStatusUpdates(target, existing)
      if (!statusUpdates.started_at) statusUpdates.started_at = now
      set = {
        ...statusUpdates,
        ...(target !== existing.status ? { position: await nextPositionInColumn(req.group.id, target) } : {}),
        ...reviewFields,
      }
    }
    await saveTaskChange(existing.id, set, [
      activityEntry(decision, req.user.id, approved ? null : note || null, now),
    ])

    const task = await loadFormattedTask(req, existing.id)
    broadcastTask(req, task)

    const io = req.app.get('io')
    await notifyReviewDecision(io, {
      group: req.group,
      task: existing,
      leaderId: req.user.id,
      recipientId: existing.assignee_id ?? request.requested_by_id,
      approved,
      note,
    })
    if (approved && request.target_status === 'completed' && existing.creator_id !== existing.assignee_id) {
      await notifyTaskStatusCompleted(io, {
        group: req.group,
        task,
        actorId: req.user.id,
        creatorId: existing.creator_id,
        assigneeId: null,
      })
    }

    res.json(task)
  } catch (error) {
    next(error)
  }
})

router.post('/:taskId/regress-requests', async (req, res, next) => {
  try {
    const existing = await findTask(req)

    const { targetStatus } = req.body ?? {}
    if (!['todo', 'in_progress'].includes(targetStatus)) {
      throw validationError('targetStatus must be todo or in_progress')
    }

    if (!isBackwardStatusMove(existing.status, targetStatus)) {
      throw validationError('Regress requests are only needed when moving a task to an earlier column')
    }

    if ((await leaderContext(req)).isLeader) {
      throw validationError('Group leaders can move tasks backward directly')
    }

    const result = await createRegressRequest(req, existing, targetStatus)
    res.status(201).json(result)
  } catch (error) {
    next(error)
  }
})

router.post('/:taskId/regress-requests/:requestId/approve', async (req, res, next) => {
  try {
    const existing = await findTask(req)
    if (!(await leaderContext(req)).isLeader) {
      throw forbidden('Only the group leader can approve regress requests')
    }

    const regressRequest = await TaskRegressRequest.findOne({
      id: req.params.requestId,
      task_id: existing.id,
      group_id: req.group.id,
      status: 'pending',
    }).lean()
    if (!regressRequest) {
      throw notFound('Regress request not found')
    }

    const now = new Date().toISOString()
    const io = req.app.get('io')

    await TaskRegressRequest.updateOne(
      { id: regressRequest.id },
      { status: 'approved', resolved_at: now, resolved_by_id: req.user.id },
    )

    const statusUpdates = buildStatusUpdates(regressRequest.target_status, existing)
    await saveTaskChange(
      existing.id,
      { ...statusUpdates, ...clearedAdvanceFields(existing), position: existing.position },
      [statusChangeEntry(existing.status, regressRequest.target_status, req.user.id, now)],
    )

    const task = await loadFormattedTask(req, existing.id)

    await notifyRegressApproved(io, {
      group: req.group,
      task: existing,
      resolverId: req.user.id,
      fromStatus: regressRequest.from_status,
      targetStatus: regressRequest.target_status,
    })

    broadcastTask(req, task)
    io?.to(`workspace:${req.group.slug}`).emit('task:regress-approved', {
      groupId: req.group.slug,
      taskId: existing.id,
      requestId: regressRequest.id,
      task,
    })

    res.json({ requestId: regressRequest.id, status: 'approved', task })
  } catch (error) {
    next(error)
  }
})

router.post('/:taskId/regress-requests/:requestId/reject', async (req, res, next) => {
  try {
    const existing = await findTask(req)
    if (!(await leaderContext(req)).isLeader) {
      throw forbidden('Only the group leader can reject regress requests')
    }

    const regressRequest = await TaskRegressRequest.findOne({
      id: req.params.requestId,
      task_id: existing.id,
      group_id: req.group.id,
      status: 'pending',
    }).lean()
    if (!regressRequest) {
      throw notFound('Regress request not found')
    }

    const now = new Date().toISOString()
    const io = req.app.get('io')

    await TaskRegressRequest.updateOne(
      { id: regressRequest.id },
      { status: 'rejected', resolved_at: now, resolved_by_id: req.user.id },
    )

    await notifyRegressRejected(io, {
      group: req.group,
      task: existing,
      resolverId: req.user.id,
      requesterId: regressRequest.requester_id,
      fromStatus: regressRequest.from_status,
      targetStatus: regressRequest.target_status,
    })

    io?.to(`workspace:${req.group.slug}`).emit('task:regress-rejected', {
      groupId: req.group.slug,
      taskId: existing.id,
      requestId: regressRequest.id,
    })
    const task = await loadFormattedTask(req, existing.id)
    if (task) broadcastTask(req, task)

    res.json({ requestId: regressRequest.id, status: 'rejected' })
  } catch (error) {
    next(error)
  }
})

router.patch('/:taskId', async (req, res, next) => {
  try {
    const existing = await findTask(req)

    const { title, dueDate, assigneeId, status, variant, position } = req.body ?? {}
    const priority = normalizePriority(req.body?.priority)
    const ctx = await leaderContext(req)

    const dueDateChanged = dueDate !== undefined && (dueDate || null) !== (existing.due_date ?? null)
    const priorityChanged = priority !== undefined && priority !== (existing.priority ?? null)
    if ((dueDateChanged || priorityChanged) && ctx.hasLeader && !ctx.isLeader) {
      throw forbidden('Only the group leader can set due dates and priority.')
    }

    const isMetadataEdit =
      title !== undefined || dueDateChanged || priorityChanged || assigneeId !== undefined
    if (isMetadataEdit && !ctx.isLeader && !isOwnTask(existing, req.user.id)) {
      throw forbidden('Only the task creator or group leader can edit title, due date, priority, or assignee')
    }

    if (title !== undefined && !title?.trim()) {
      throw validationError('Task title is required')
    }

    const previousAssigneeId = existing.assignee_id
    const set = {
      title: title !== undefined ? title.trim() : existing.title,
      due_date: dueDate !== undefined ? dueDate || null : existing.due_date,
      priority: priority !== undefined ? priority : existing.priority ?? null,
      assignee_id: assigneeId !== undefined ? assigneeId || null : existing.assignee_id,
      position: position ?? existing.position,
    }

    const now = new Date().toISOString()
    const entries = []
    const moved = status !== undefined && status !== existing.status

    if (moved) {
      assertStatusMoveAllowed(existing, status, ctx)
      const nextVariant =
        variant ??
        (status === 'completed' ? 'completed' : existing.variant === 'completed' ? 'default' : existing.variant)
      Object.assign(set, buildStatusUpdates(status, { ...existing, variant: nextVariant }), clearedAdvanceFields(existing))
      if (variant !== undefined) set.variant = nextVariant
      entries.push(statusChangeEntry(existing.status, status, req.user.id, now))
    } else if (variant !== undefined) {
      set.variant = variant
    }

    if (set.assignee_id !== previousAssigneeId) {
      entries.push(activityEntry('assigned', req.user.id, null, now))
    }
    if ((title !== undefined && set.title !== existing.title) || dueDateChanged || priorityChanged) {
      entries.push(activityEntry('updated', req.user.id, null, now))
    }

    await saveTaskChange(existing.id, set, entries)

    const task = await loadFormattedTask(req, existing.id)
    broadcastTask(req, task)

    const io = req.app.get('io')
    if (set.assignee_id && set.assignee_id !== previousAssigneeId) {
      await notifyTaskAssigned(io, {
        group: req.group,
        task,
        actorId: req.user.id,
        assigneeId: set.assignee_id,
      })
    }

    if (moved && status === 'completed') {
      await notifyTaskStatusCompleted(io, {
        group: req.group,
        task,
        actorId: req.user.id,
        creatorId: existing.creator_id,
        assigneeId: existing.assignee_id,
      })
    }

    res.json(task)
  } catch (error) {
    next(error)
  }
})

router.delete('/:taskId', async (req, res, next) => {
  try {
    const existing = await findTask(req)

    if (!(await leaderContext(req)).isLeader && !isOwnTask(existing, req.user.id)) {
      throw forbidden('Only the task creator or group leader can delete this task')
    }

    await Task.deleteOne({ id: req.params.taskId, group_id: req.group.id })
    await TaskRegressRequest.deleteMany({ task_id: req.params.taskId })

    const io = req.app.get('io')
    await notifyTaskDeleted(io, {
      group: req.group,
      task: existing,
      actorId: req.user.id,
      assigneeId: existing.assignee_id,
    })

    io?.to(`workspace:${req.group.slug}`).emit('task:deleted', { id: req.params.taskId })

    res.status(204).send()
  } catch (error) {
    next(error)
  }
})

export default router

import { Router } from 'express'
import { v4 as uuid } from 'uuid'
import mongoose from 'mongoose'
import { Task, TaskRegressRequest } from '../../db/models.js'
import { fetchTaskRows } from '../../db/taskQueries.js'
import { authRequired, requireGroupMember } from '../../middleware/auth.js'
import { notFound, validationError, forbidden, conflict, regressRequiresApproval } from '../../utils/errors.js'
import {
  buildProgressUpdates,
  buildStatusUpdates,
  isBackwardStatusMove,
} from '../../services/taskWorkflow.js'
import {
  notifyRegressApproved,
  notifyRegressRejected,
  notifyRegressRequested,
  notifyTaskAssigned,
  notifyTaskDeleted,
  notifyTaskProgress,
  notifyTaskStatusCompleted,
} from '../../services/taskNotifications.js'
import { getUserDisplayName } from '../../services/notificationService.js'

const router = Router({ mergeParams: true })

router.use(authRequired, requireGroupMember)

function formatTask(row) {
  const task = {
    id: row.id,
    title: row.title,
    variant: row.variant,
    createdAt: row.created_at,
  }
  if (row.due_date) task.dueDate = row.due_date
  if (row.started_at) task.startedAt = row.started_at
  if (row.completed_at) task.completedAt = row.completed_at
  if (row.creator_id) {
    task.createdBy = {
      id: row.creator_id,
      initials: row.creator_initials,
      name: row.creator_name,
      color: row.creator_color,
    }
  }
  if (row.assignee_id) {
    task.assignee = {
      id: row.assignee_id,
      initials: row.initials,
      name: row.assignee_name,
      color: row.avatar_color,
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

function canDeleteTask(task, userId) {
  if (!task.creator_id) return true
  return task.creator_id === userId
}

function assertForwardOrCreatorMove(existing, nextStatus, userId) {
  if (!isBackwardStatusMove(existing.status, nextStatus)) return
  if (existing.creator_id && existing.creator_id !== userId) {
    throw regressRequiresApproval('Moving this task backward requires approval from the task creator.', {
      taskId: existing.id,
      fromStatus: existing.status,
      targetStatus: nextStatus,
    })
  }
}

async function applyTaskUpdate(req, taskId, updates, existing, { notifyProgress, notifyCompleted } = {}) {
  await Task.updateOne({ id: taskId }, updates)

  const row = (await fetchTaskRows(req.group.id, taskId))[0]
  const task = formatTask(row)
  const io = req.app.get('io')
  io?.to(`workspace:${req.group.slug}`).emit('task:updated', { groupId: req.group.slug, task })

  if (notifyProgress) {
    await notifyTaskProgress(io, {
      group: req.group,
      task,
      actorId: req.user.id,
      action: notifyProgress,
      creatorId: existing.creator_id,
      assigneeId: existing.assignee_id,
    })
  }

  if (notifyCompleted) {
    await notifyTaskStatusCompleted(io, {
      group: req.group,
      task,
      actorId: req.user.id,
      creatorId: existing.creator_id,
      assigneeId: existing.assignee_id,
    })
  }

  return task
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

    for (const item of tasks) {
      const existing = existingById[item.id]
      if (!existing) {
        throw notFound(`Task not found: ${item.id}`)
      }
      if (item.status && item.status !== existing.status) {
        assertForwardOrCreatorMove(existing, item.status, req.user.id)
      }
    }

    session.startTransaction()

    for (const [index, item] of tasks.entries()) {
      const existing = existingById[item.id]
      const statusUpdates = buildStatusUpdates(item.status, existing)

      await Task.updateOne(
        { id: item.id, group_id: req.group.id },
        { ...statusUpdates, position: item.position ?? index },
        { session },
      )
    }

    await session.commitTransaction()

    const rows = await fetchTaskRows(req.group.id)
    const io = req.app.get('io')

    for (const item of tasks) {
      const existing = existingById[item.id]
      if (!existing || item.status === existing.status) continue

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

      io?.to(`workspace:${req.group.slug}`).emit('task:updated', { groupId: req.group.slug, task })
    }

    res.json(groupTasksByStatus(rows))
  } catch (error) {
    await session.abortTransaction()
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

    const maxPosition = await Task.findOne({ group_id: req.group.id, status: 'todo' })
      .sort({ position: -1 })
      .lean()
    const position = (maxPosition?.position ?? -1) + 1

    const taskId = uuid()
    const now = new Date().toISOString()

    await Task.create({
      id: taskId,
      group_id: req.group.id,
      creator_id: req.user.id,
      title: title.trim(),
      status: 'todo',
      progress: 'not_started',
      variant: 'default',
      due_date: dueDate || null,
      assignee_id: assigneeId || null,
      position,
      created_at: now,
    })

    const row = (await fetchTaskRows(req.group.id, taskId))[0]
    const task = formatTask(row)
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
    const existing = await Task.findOne({ id: req.params.taskId, group_id: req.group.id }).lean()
    if (!existing) {
      throw notFound('Task not found')
    }

    const { action } = req.body ?? {}
    if (!['start', 'complete'].includes(action)) {
      throw validationError('action must be start or complete')
    }

    if (!existing.assignee_id) {
      throw validationError('Task must have an assignee to update progress')
    }
    if (existing.assignee_id !== req.user.id) {
      throw forbidden('Only the assignee can update task progress')
    }

    const progress = action === 'start' ? 'started' : 'done'
    const updates = buildProgressUpdates(progress, existing)
    const task = await applyTaskUpdate(req, req.params.taskId, updates, existing, {
      notifyProgress: action,
      notifyCompleted: action === 'complete',
    })

    res.json(task)
  } catch (error) {
    next(error)
  }
})

router.post('/:taskId/regress-requests', async (req, res, next) => {
  try {
    const existing = await Task.findOne({ id: req.params.taskId, group_id: req.group.id }).lean()
    if (!existing) {
      throw notFound('Task not found')
    }

    const { targetStatus } = req.body ?? {}
    if (!['todo', 'in_progress'].includes(targetStatus)) {
      throw validationError('targetStatus must be todo or in_progress')
    }

    if (!isBackwardStatusMove(existing.status, targetStatus)) {
      throw validationError('Regress requests are only needed when moving a task to an earlier column')
    }

    if (existing.creator_id === req.user.id) {
      throw validationError('Task creators can move tasks backward directly')
    }

    const result = await createRegressRequest(req, existing, targetStatus)
    res.status(201).json(result)
  } catch (error) {
    next(error)
  }
})

router.post('/:taskId/regress-requests/:requestId/approve', async (req, res, next) => {
  try {
    const existing = await Task.findOne({ id: req.params.taskId, group_id: req.group.id }).lean()
    if (!existing) {
      throw notFound('Task not found')
    }
    if (existing.creator_id !== req.user.id) {
      throw forbidden('Only the task creator can approve regress requests')
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
    await Task.updateOne({ id: existing.id }, { ...statusUpdates, position: existing.position })

    const row = (await fetchTaskRows(req.group.id, existing.id))[0]
    const task = formatTask(row)

    await notifyRegressApproved(io, {
      group: req.group,
      task: existing,
      resolverId: req.user.id,
      fromStatus: regressRequest.from_status,
      targetStatus: regressRequest.target_status,
    })

    io?.to(`workspace:${req.group.slug}`).emit('task:updated', { groupId: req.group.slug, task })
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
    const existing = await Task.findOne({ id: req.params.taskId, group_id: req.group.id }).lean()
    if (!existing) {
      throw notFound('Task not found')
    }
    if (existing.creator_id !== req.user.id) {
      throw forbidden('Only the task creator can reject regress requests')
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

    res.json({ requestId: regressRequest.id, status: 'rejected' })
  } catch (error) {
    next(error)
  }
})

router.patch('/:taskId', async (req, res, next) => {
  try {
    const existing = await Task.findOne({ id: req.params.taskId, group_id: req.group.id }).lean()
    if (!existing) {
      throw notFound('Task not found')
    }

    const { title, dueDate, assigneeId, status, variant, position } = req.body ?? {}
    const previousAssigneeId = existing.assignee_id
    const updates = {
      title: title?.trim() ?? existing.title,
      due_date: dueDate !== undefined ? dueDate || null : existing.due_date,
      assignee_id: assigneeId !== undefined ? assigneeId || null : existing.assignee_id,
      position: position ?? existing.position,
    }

    if (status !== undefined) {
      assertForwardOrCreatorMove(existing, status, req.user.id)
      const nextVariant =
        variant ??
        (status === 'completed' ? 'completed' : existing.variant === 'completed' ? 'default' : existing.variant)
      Object.assign(updates, buildStatusUpdates(status, { ...existing, variant: nextVariant }))
      if (variant !== undefined) {
        updates.variant = nextVariant
      }
    } else {
      updates.status = existing.status
      updates.progress = existing.progress ?? 'not_started'
      updates.completed_at = existing.completed_at
      updates.started_at = existing.started_at
      updates.variant = variant ?? existing.variant
    }

    await Task.updateOne({ id: req.params.taskId }, updates)

    const row = (await fetchTaskRows(req.group.id, req.params.taskId))[0]
    const task = formatTask(row)
    const io = req.app.get('io')
    io?.to(`workspace:${req.group.slug}`).emit('task:updated', { groupId: req.group.slug, task })

    if (assigneeId !== undefined && updates.assignee_id && updates.assignee_id !== previousAssigneeId) {
      await notifyTaskAssigned(io, {
        group: req.group,
        task,
        actorId: req.user.id,
        assigneeId: updates.assignee_id,
      })
    }

    if (status !== undefined && status === 'completed' && existing.status !== 'completed') {
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
    const existing = await Task.findOne({ id: req.params.taskId, group_id: req.group.id }).lean()
    if (!existing) {
      throw notFound('Task not found')
    }

    if (!canDeleteTask(existing, req.user.id)) {
      throw forbidden('Only the task creator can delete this task')
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

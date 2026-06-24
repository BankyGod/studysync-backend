import { Router } from 'express'
import { v4 as uuid } from 'uuid'
import mongoose from 'mongoose'
import { Task } from '../../db/models.js'
import { fetchTaskRows } from '../../db/taskQueries.js'
import { authRequired, requireGroupMember } from '../../middleware/auth.js'
import { notFound, validationError } from '../../utils/errors.js'

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
  if (row.completed_at) task.completedAt = row.completed_at
  if (row.assignee_id) {
    task.assignee = {
      id: row.assignee_id,
      initials: row.initials,
      name: row.assignee_name,
      color: row.avatar_color,
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

router.get('/', async (req, res, next) => {
  try {
    const rows = await fetchTaskRows(req.group.id)
    res.json(groupTasksByStatus(rows))
  } catch (error) {
    next(error)
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
      title: title.trim(),
      status: 'todo',
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

    res.status(201).json(task)
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
    const nextStatus = status ?? existing.status
    let completedAt = existing.completed_at

    if (nextStatus === 'completed' && existing.status !== 'completed') {
      completedAt = new Date().toISOString().slice(0, 10)
    } else if (nextStatus !== 'completed') {
      completedAt = null
    }

    const nextVariant =
      variant ??
      (nextStatus === 'completed' ? 'completed' : existing.variant === 'completed' ? 'default' : existing.variant)

    await Task.updateOne(
      { id: req.params.taskId },
      {
        title: title?.trim() ?? existing.title,
        due_date: dueDate !== undefined ? dueDate || null : existing.due_date,
        assignee_id: assigneeId !== undefined ? assigneeId || null : existing.assignee_id,
        status: nextStatus,
        variant: nextVariant,
        completed_at: completedAt,
        position: position ?? existing.position,
      },
    )

    const row = (await fetchTaskRows(req.group.id, req.params.taskId))[0]
    const task = formatTask(row)
    const io = req.app.get('io')
    io?.to(`workspace:${req.group.slug}`).emit('task:updated', { groupId: req.group.slug, task })

    res.json(task)
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

    session.startTransaction()

    for (const [index, item] of tasks.entries()) {
      let completedAt = null
      const updates = {
        status: item.status,
        position: item.position ?? index,
      }

      if (item.status === 'completed') {
        completedAt = new Date().toISOString().slice(0, 10)
        updates.completed_at = completedAt
        updates.variant = 'completed'
      } else {
        updates.completed_at = null
      }

      await Task.updateOne({ id: item.id, group_id: req.group.id }, updates, { session })
    }

    await session.commitTransaction()

    const rows = await fetchTaskRows(req.group.id)
    res.json(groupTasksByStatus(rows))
  } catch (error) {
    await session.abortTransaction()
    next(error)
  } finally {
    session.endSession()
  }
})

router.delete('/:taskId', async (req, res, next) => {
  try {
    const result = await Task.deleteOne({ id: req.params.taskId, group_id: req.group.id })

    if (result.deletedCount === 0) {
      throw notFound('Task not found')
    }

    const io = req.app.get('io')
    io?.to(`workspace:${req.group.slug}`).emit('task:deleted', {
      groupId: req.group.slug,
      taskId: req.params.taskId,
    })

    res.status(204).send()
  } catch (error) {
    next(error)
  }
})

export default router

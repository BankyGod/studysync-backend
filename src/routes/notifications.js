import { Router } from 'express'
import { Notification } from '../db/models.js'
import { notFound } from '../utils/errors.js'
import { formatNotification } from '../services/notificationService.js'

const router = Router({ mergeParams: true })

router.get('/', async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100)
    const unreadOnly = req.query.unreadOnly === 'true' || req.query.unread === 'true'
    const groupId = req.query.groupId?.trim()

    const filter = { user_id: req.user.id }
    if (unreadOnly) {
      filter.read_at = null
    }
    if (groupId) {
      filter.group_slug = groupId
    }
    if (req.query.cursor) {
      filter.created_at = { $lt: req.query.cursor }
    }

    const notifications = await Notification.find(filter)
      .sort({ created_at: -1 })
      .limit(limit + 1)
      .lean()

    const hasMore = notifications.length > limit
    const page = hasMore ? notifications.slice(0, limit) : notifications
    const nextCursor = hasMore ? page[page.length - 1]?.created_at : null

    const unreadFilter = { user_id: req.user.id, read_at: null }
    if (groupId) unreadFilter.group_slug = groupId

    res.json({
      notifications: page.map(formatNotification),
      unreadCount: await Notification.countDocuments(unreadFilter),
      nextCursor,
    })
  } catch (error) {
    next(error)
  }
})

router.get('/unread-count', async (req, res, next) => {
  try {
    const filter = { user_id: req.user.id, read_at: null }
    if (req.query.groupId?.trim()) {
      filter.group_slug = req.query.groupId.trim()
    }
    const unreadCount = await Notification.countDocuments(filter)
    res.json({ unreadCount })
  } catch (error) {
    next(error)
  }
})

router.post('/read-all', async (req, res, next) => {
  try {
    const now = new Date().toISOString()
    const filter = { user_id: req.user.id, read_at: null }
    if (req.body?.groupId?.trim()) {
      filter.group_slug = req.body.groupId.trim()
    }

    const result = await Notification.updateMany(filter, { read_at: now })
    res.json({ updated: result.modifiedCount })
  } catch (error) {
    next(error)
  }
})

router.patch('/:notificationId/read', async (req, res, next) => {
  try {
    const notification = await Notification.findOne({ id: req.params.notificationId, user_id: req.user.id }).lean()
    if (!notification) {
      throw notFound('Notification not found')
    }

    const read = req.body?.read !== false
    const readAt = read ? new Date().toISOString() : null

    await Notification.updateOne({ id: notification.id }, { read_at: readAt })

    res.json(formatNotification({ ...notification, read_at: readAt }))
  } catch (error) {
    next(error)
  }
})

router.delete('/:notificationId', async (req, res, next) => {
  try {
    const result = await Notification.deleteOne({ id: req.params.notificationId, user_id: req.user.id })
    if (result.deletedCount === 0) {
      throw notFound('Notification not found')
    }
    res.status(204).send()
  } catch (error) {
    next(error)
  }
})

export default router

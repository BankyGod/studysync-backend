import { Router } from 'express'
import { v4 as uuid } from 'uuid'
import { ScheduledSession, GroupMember } from '../../db/models.js'
import { authRequired, requireGroupMember } from '../../middleware/auth.js'
import { notFound, validationError } from '../../utils/errors.js'

const router = Router({ mergeParams: true })
const MEETING_TYPES = ['Online Meeting', 'In Person', 'Hybrid']

router.use(authRequired, requireGroupMember)

function formatSession(row, memberCount) {
  return {
    id: row.id,
    title: row.title,
    date: row.date,
    startTime: row.start_time,
    endTime: row.end_time,
    meetingType: row.meeting_type,
    agenda: row.agenda ?? undefined,
    memberCount,
    createdAt: row.created_at,
  }
}

router.get('/', async (req, res, next) => {
  try {
    const memberCount = await GroupMember.countDocuments({ group_id: req.group.id })

    const rows = await ScheduledSession.find({ group_id: req.group.id })
      .sort({ date: 1, start_time: 1 })
      .lean()

    res.json({ sessions: rows.map((r) => formatSession(r, memberCount)) })
  } catch (error) {
    next(error)
  }
})

router.post('/', async (req, res, next) => {
  try {
    const { title, date, startTime, endTime, meetingType, agenda } = req.body ?? {}

    if (!title?.trim() || !date || !startTime || !endTime || !meetingType) {
      throw validationError('title, date, startTime, endTime, and meetingType are required')
    }

    if (!MEETING_TYPES.includes(meetingType)) {
      throw validationError('Invalid meeting type')
    }

    if (startTime >= endTime) {
      throw validationError('endTime must be after startTime')
    }

    const sessionId = uuid()
    const now = new Date().toISOString()

    await ScheduledSession.create({
      id: sessionId,
      group_id: req.group.id,
      title: title.trim(),
      date,
      start_time: startTime,
      end_time: endTime,
      meeting_type: meetingType,
      agenda: agenda?.trim() || null,
      created_by_id: req.user.id,
      created_at: now,
    })

    const memberCount = await GroupMember.countDocuments({ group_id: req.group.id })
    const row = await ScheduledSession.findOne({ id: sessionId }).lean()
    const session = formatSession(row, memberCount)

    const io = req.app.get('io')
    io?.to(`workspace:${req.group.slug}`).emit('session:created', { groupId: req.group.slug, session })

    res.status(201).json(session)
  } catch (error) {
    next(error)
  }
})

router.patch('/:sessionId', async (req, res, next) => {
  try {
    const existing = await ScheduledSession.findOne({
      id: req.params.sessionId,
      group_id: req.group.id,
    }).lean()

    if (!existing) {
      throw notFound('Session not found')
    }

    const { title, date, startTime, endTime, meetingType, agenda } = req.body ?? {}

    await ScheduledSession.updateOne(
      { id: req.params.sessionId },
      {
        title: title?.trim() ?? existing.title,
        date: date ?? existing.date,
        start_time: startTime ?? existing.start_time,
        end_time: endTime ?? existing.end_time,
        meeting_type: meetingType ?? existing.meeting_type,
        agenda: agenda !== undefined ? agenda?.trim() || null : existing.agenda,
      },
    )

    const memberCount = await GroupMember.countDocuments({ group_id: req.group.id })
    const row = await ScheduledSession.findOne({ id: req.params.sessionId }).lean()
    const session = formatSession(row, memberCount)

    const io = req.app.get('io')
    io?.to(`workspace:${req.group.slug}`).emit('session:updated', { groupId: req.group.slug, session })

    res.json(session)
  } catch (error) {
    next(error)
  }
})

router.delete('/:sessionId', async (req, res, next) => {
  try {
    const result = await ScheduledSession.deleteOne({
      id: req.params.sessionId,
      group_id: req.group.id,
    })

    if (result.deletedCount === 0) {
      throw notFound('Session not found')
    }

    res.status(204).send()
  } catch (error) {
    next(error)
  }
})

export default router

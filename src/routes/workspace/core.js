import { Router } from 'express'
import { v4 as uuid } from 'uuid'
import { GroupMember, Nudge, StudyGroup, Task, User, UserProfile } from '../../db/models.js'
import { fetchTaskRows } from '../../db/taskQueries.js'
import { notFound, nudgeRateLimited, validationError } from '../../utils/errors.js'
import { getUserDisplayName } from '../../services/notificationService.js'
import { notifyAnnouncementUpdated, notifyNudge } from '../../services/taskNotifications.js'
import { activityEntry, saveTaskChange } from '../../services/taskActivity.js'
import { formatTask } from '../../services/taskFormatter.js'
import { authRequired, requireGroupMember } from '../../middleware/auth.js'
import { formatMember } from '../../utils/serializers.js'
import { formatCourseLabel } from '../../utils/helpers.js'
import { avatarUrlForUser } from '../../utils/profileAvatar.js'
import { computeReliabilityBatch, formatReliability } from '../../services/reliabilityService.js'
import { computeGroupProgress } from '../../services/groupProgressService.js'
import {
  assertCallerIsLeader,
  formatLeaderTransferResponse,
  leaderIdFromMembers,
  removeGroupMember,
  setGroupLeader,
} from '../../services/groupLeaderService.js'
import { userHasPermission, PERMISSIONS } from '../../services/staffPermissions.js'

const router = Router({ mergeParams: true })

router.use(authRequired, requireGroupMember)

router.get('/', async (req, res, next) => {
  try {
    const members = await GroupMember.find({ group_id: req.group.id }).lean()
    const users = await User.find({ id: { $in: members.map((m) => m.user_id) } }).lean()
    const profiles = await UserProfile.find({ user_id: { $in: members.map((m) => m.user_id) } })
      .select(
        'user_id avatar_mime_type avatar_storage_key avatar_byte_length',
      )
      .lean()
    const userById = Object.fromEntries(users.map((u) => [u.id, u]))
    const profileByUserId = Object.fromEntries(profiles.map((p) => [p.user_id, p]))
    const memberIds = members.map((m) => m.user_id)
    const reliabilityByUser = await computeReliabilityBatch(memberIds, req.group.id, req.group.slug)
    const { progress } = await computeGroupProgress(req.group.id)
    const leaderId = leaderIdFromMembers(members)

    const formatted = members.map((m) => {
      const u = userById[m.user_id]
      const member = formatMember({
        user_id: m.user_id,
        initials: m.initials,
        avatar_color: m.avatar_color,
        role: m.role,
        first_name: u?.first_name,
        last_name: u?.last_name,
        program: u?.program,
        avatarUrl: avatarUrlForUser(m.user_id, profileByUserId[m.user_id]),
      })
      member.reliability = formatReliability(reliabilityByUser[m.user_id])
      return member
    })

    res.json({
      groupId: req.group.slug,
      title: req.group.title,
      courseLabel: formatCourseLabel(req.group.subject, req.group.course_number),
      leaderId,
      progress,
      announcement: await formatAnnouncement(req.group.announcement),
      members: formatted,
    })
  } catch (error) {
    next(error)
  }
})

const ANNOUNCEMENT_MAX = 500
const NUDGE_MESSAGE_MAX = 300
const NUDGE_WINDOW_MS = 60 * 60 * 1000

async function formatAnnouncement(announcement) {
  if (!announcement?.text) return null
  return {
    text: announcement.text,
    updatedAt: announcement.updated_at,
    author: { id: announcement.author_id, name: await getUserDisplayName(announcement.author_id) },
  }
}

function broadcastWorkspaceUpdated(req, payload = {}) {
  req.app.get('io')?.to(`workspace:${req.group.slug}`).emit('workspace:updated', {
    groupId: req.group.slug,
    ...payload,
  })
}

router.put('/announcement', async (req, res, next) => {
  try {
    await assertCallerIsLeader(req.group.id, req.user.id, 'Only the group leader can pin announcements')
    const text = String(req.body?.text ?? '').trim()
    if (!text) throw validationError('text is required')
    if (text.length > ANNOUNCEMENT_MAX) {
      throw validationError(`text must be at most ${ANNOUNCEMENT_MAX} characters`)
    }

    const stored = { text, updated_at: new Date().toISOString(), author_id: req.user.id }
    await StudyGroup.updateOne({ id: req.group.id }, { $set: { announcement: stored } })
    const announcement = await formatAnnouncement(stored)

    broadcastWorkspaceUpdated(req, { announcement })
    await notifyAnnouncementUpdated(req.app.get('io'), { group: req.group, leaderId: req.user.id, text })

    res.json({ announcement })
  } catch (error) {
    next(error)
  }
})

router.delete('/announcement', async (req, res, next) => {
  try {
    await assertCallerIsLeader(req.group.id, req.user.id, 'Only the group leader can remove announcements')
    await StudyGroup.updateOne({ id: req.group.id }, { $set: { announcement: null } })
    broadcastWorkspaceUpdated(req, { announcement: null })
    res.status(204).send()
  } catch (error) {
    next(error)
  }
})

router.post('/nudges', async (req, res, next) => {
  try {
    await assertCallerIsLeader(req.group.id, req.user.id, 'Only the group leader can send reminders')

    const userId = String(req.body?.userId ?? '').trim()
    const taskId = String(req.body?.taskId ?? '').trim() || null
    const message = String(req.body?.message ?? '').trim()
    if (!userId) throw validationError('userId is required')
    if (userId === req.user.id) throw validationError('You cannot remind yourself')
    if (message.length > NUDGE_MESSAGE_MAX) {
      throw validationError(`message must be at most ${NUDGE_MESSAGE_MAX} characters`)
    }

    const member = await GroupMember.findOne({ group_id: req.group.id, user_id: userId }).lean()
    if (!member) throw notFound('That user is not a member of this pod')

    const task = taskId ? await Task.findOne({ id: taskId, group_id: req.group.id }).lean() : null
    if (taskId && !task) throw notFound('Task not found')

    const since = new Date(Date.now() - NUDGE_WINDOW_MS).toISOString()
    const recent = await Nudge.findOne({
      leader_id: req.user.id,
      user_id: userId,
      task_id: taskId,
      created_at: { $gt: since },
    }).lean()
    if (recent) {
      const retryAt = new Date(new Date(recent.created_at).getTime() + NUDGE_WINDOW_MS).toISOString()
      throw nudgeRateLimited(undefined, { retryAt })
    }

    const now = new Date().toISOString()
    await Nudge.create({
      id: uuid(),
      group_id: req.group.id,
      leader_id: req.user.id,
      user_id: userId,
      task_id: taskId,
      message,
      created_at: now,
    })

    const io = req.app.get('io')
    await notifyNudge(io, { group: req.group, leaderId: req.user.id, userId, task, message })

    if (task) {
      await saveTaskChange(task.id, {}, [activityEntry('nudged', req.user.id, message || null, now)], {
        bumpActivity: false,
      })
      const row = (await fetchTaskRows(req.group.id, task.id))[0]
      if (row) {
        io?.to(`workspace:${req.group.slug}`).emit('task:updated', {
          groupId: req.group.slug,
          task: formatTask(row),
        })
      }
    }

    res.status(201).json({ ok: true })
  } catch (error) {
    next(error)
  }
})

async function transferLeadership(req, res, next) {
  try {
    const targetUserId = req.body?.userId ?? req.body?.user_id
    const isStaffAssign = userHasPermission(req.user, PERMISSIONS.ASSIGN_LEADERS)

    if (!isStaffAssign) {
      await assertCallerIsLeader(req.group.id, req.user.id)
    }

    await setGroupLeader(req.group.id, targetUserId)
    const payload = await formatLeaderTransferResponse(req.group)
    broadcastWorkspaceUpdated(req, { leaderId: targetUserId })
    res.json(payload)
  } catch (error) {
    next(error)
  }
}

router.put('/leader', transferLeadership)
router.patch('/leader', transferLeadership)

/** Leader removes a member from the pod. */
router.delete('/members/:userId', async (req, res, next) => {
  try {
    await assertCallerIsLeader(req.group.id, req.user.id, 'Only the group leader can remove members')
    await removeGroupMember(req.group.id, req.params.userId, { actorId: req.user.id })

    const io = req.app.get('io')
    io?.to(`workspace:${req.group.slug}`).emit('member:removed', {
      groupId: req.group.slug,
      userId: req.params.userId,
    })
    broadcastWorkspaceUpdated(req, { removedUserId: req.params.userId })

    res.status(204).send()
  } catch (error) {
    next(error)
  }
})

export default router

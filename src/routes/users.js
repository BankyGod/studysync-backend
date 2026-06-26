import path from 'path'
import fs from 'fs'
import { Router } from 'express'
import multer from 'multer'
import { v4 as uuid } from 'uuid'
import { UserProfile, StudyGroup, GroupMember, User, Task } from '../db/models.js'
import { config } from '../config.js'
import { authRequired } from '../middleware/auth.js'
import { forbidden, notFound, validationError } from '../utils/errors.js'
import { formatMember } from '../utils/serializers.js'
import { pickGroupAccent } from '../utils/helpers.js'
import { usersShareGroup } from '../services/matchingService.js'
import { avatarUrlForUser, formatProfileResponse } from '../utils/profileAvatar.js'
import notificationsRouter from './notifications.js'

const router = Router()
const MAX_AVATAR_SIZE = 5 * 1024 * 1024
const ALLOWED_AVATAR_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(config.uploadsDir, 'avatars', req.user.id)
      fs.mkdirSync(dir, { recursive: true })
      cb(null, dir)
    },
    filename: (req, file, cb) => {
      cb(null, `${uuid()}${path.extname(file.originalname) || '.jpg'}`)
    },
  }),
  limits: { fileSize: MAX_AVATAR_SIZE },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_AVATAR_TYPES.has(file.mimetype)) {
      cb(new Error('Profile photo must be JPEG, PNG, WebP, or GIF'))
      return
    }
    cb(null, true)
  },
})

router.use(authRequired)

router.use('/me/notifications', notificationsRouter)

async function loadProfileOrFail(userId) {
  const profile = await UserProfile.findOne({ user_id: userId }).lean()
  if (!profile) {
    throw validationError('Profile not found')
  }
  return profile
}

router.get('/me/profile', async (req, res, next) => {
  try {
    const profile = await loadProfileOrFail(req.user.id)
    res.json(formatProfileResponse(profile, req.user, { includeEmail: true }))
  } catch (error) {
    next(error)
  }
})

router.put('/me/profile', async (req, res, next) => {
  try {
    const { fullName, studentRole, primaryUniversity, secondaryUniversity, location } = req.body ?? {}

    if (!fullName?.trim()) {
      throw validationError('fullName is required')
    }

    const now = new Date().toISOString()

    await UserProfile.updateOne(
      { user_id: req.user.id },
      {
        full_name: fullName.trim(),
        student_role: studentRole?.trim() ?? '',
        primary_university: primaryUniversity?.trim() ?? '',
        secondary_university: secondaryUniversity?.trim() || null,
        location: location?.trim() ?? '',
        updated_at: now,
      },
    )

    const profile = await loadProfileOrFail(req.user.id)
    res.json(formatProfileResponse(profile, req.user, { includeEmail: true }))
  } catch (error) {
    next(error)
  }
})

router.post('/me/avatar', upload.single('photo'), async (req, res, next) => {
  try {
    if (!req.file) {
      throw validationError('photo file is required')
    }

    const profile = await loadProfileOrFail(req.user.id)

    if (profile.avatar_storage_key && fs.existsSync(profile.avatar_storage_key)) {
      fs.unlinkSync(profile.avatar_storage_key)
    }

    const now = new Date().toISOString()
    await UserProfile.updateOne(
      { user_id: req.user.id },
      {
        avatar_storage_key: req.file.path,
        avatar_mime_type: req.file.mimetype,
        updated_at: now,
      },
    )

    const updated = await loadProfileOrFail(req.user.id)
    res.json({
      avatarUrl: avatarUrlForUser(req.user.id, updated),
      updatedAt: now,
    })
  } catch (error) {
    if (req.file?.path && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path)
    }
    next(error)
  }
})

router.delete('/me/avatar', async (req, res, next) => {
  try {
    const profile = await loadProfileOrFail(req.user.id)

    if (profile.avatar_storage_key && fs.existsSync(profile.avatar_storage_key)) {
      fs.unlinkSync(profile.avatar_storage_key)
    }

    const now = new Date().toISOString()
    await UserProfile.updateOne(
      { user_id: req.user.id },
      {
        avatar_storage_key: null,
        avatar_mime_type: null,
        updated_at: now,
      },
    )

    res.status(204).send()
  } catch (error) {
    next(error)
  }
})

router.get('/:userId/avatar', async (req, res, next) => {
  try {
    const userId = req.params.userId === 'me' ? req.user.id : req.params.userId

    if (userId !== req.user.id) {
      const sharesGroup = await usersShareGroup(req.user.id, userId)
      if (!sharesGroup) {
        throw forbidden('You can only view avatars of members in your study groups')
      }
    }

    const profile = await UserProfile.findOne({ user_id: userId }).lean()
    if (!profile?.avatar_storage_key || !fs.existsSync(profile.avatar_storage_key)) {
      throw notFound('Profile photo not found')
    }

    res.setHeader('Content-Type', profile.avatar_mime_type || 'image/jpeg')
    res.setHeader('Cache-Control', 'private, max-age=3600')
    fs.createReadStream(profile.avatar_storage_key).pipe(res)
  } catch (error) {
    next(error)
  }
})

router.get('/me/groups', async (req, res, next) => {
  try {
    const memberships = await GroupMember.find({ user_id: req.user.id }).lean()
    const groupIds = memberships.map((m) => m.group_id)

    const groups = await StudyGroup.find({ id: { $in: groupIds } })
      .sort({ created_at: -1 })
      .lean()

    const memberUserIds = new Set()
    const groupMembersMap = new Map()

    await Promise.all(
      groups.map(async (group) => {
        const members = await GroupMember.find({ group_id: group.id }).lean()
        groupMembersMap.set(group.id, members)
        members.forEach((m) => memberUserIds.add(m.user_id))
      }),
    )

    const memberUsers = await User.find({ id: { $in: [...memberUserIds] } }).lean()
    const profiles = await UserProfile.find({ user_id: { $in: [...memberUserIds] } }).lean()
    const userById = Object.fromEntries(memberUsers.map((u) => [u.id, u]))
    const profileByUserId = Object.fromEntries(profiles.map((p) => [p.user_id, p]))

    const result = await Promise.all(
      groups.map(async (group) => {
        const members = groupMembersMap.get(group.id) ?? []

        const formattedMembers = members.map((m) => {
          const u = userById[m.user_id]
          const memberProfile = profileByUserId[m.user_id]
          const formatted = formatMember({
            user_id: m.user_id,
            initials: m.initials,
            avatar_color: m.avatar_color,
            first_name: u?.first_name,
            last_name: u?.last_name,
            program: u?.program,
          })
          const avatarUrl = avatarUrlForUser(m.user_id, memberProfile)
          if (avatarUrl) formatted.avatarUrl = avatarUrl
          return formatted
        })

        const taskStats = await Task.aggregate([
          { $match: { group_id: group.id } },
          {
            $group: {
              _id: null,
              total: { $sum: 1 },
              completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
            },
          },
        ])

        const total = taskStats[0]?.total ?? 0
        const completed = taskStats[0]?.completed ?? 0
        const progress = total === 0 ? 0 : Math.round((completed / total) * 100)

        return {
          id: group.id,
          groupId: group.slug,
          title: group.title,
          progress,
          accent: pickGroupAccent(group.slug),
          members: formattedMembers,
        }
      }),
    )

    res.json({ groups: result })
  } catch (error) {
    next(error)
  }
})

router.get('/:userId/profile', async (req, res, next) => {
  try {
    const { userId } = req.params

    if (userId === req.user.id) {
      const profile = await UserProfile.findOne({ user_id: userId }).lean()
      if (!profile) {
        throw notFound('Profile not found')
      }
      return res.json(formatProfileResponse(profile, req.user, { includeEmail: true }))
    }

    const sharesGroup = await usersShareGroup(req.user.id, userId)
    if (!sharesGroup) {
      throw forbidden('You can only view profiles of members in your study groups')
    }

    const targetUser = await User.findOne({ id: userId }).lean()
    if (!targetUser) {
      throw notFound('User not found')
    }

    const profile = await UserProfile.findOne({ user_id: userId }).lean()
    if (!profile) {
      throw notFound('Profile not found')
    }

    const body = formatProfileResponse(profile, targetUser)
    if (!body.studentRole) body.studentRole = targetUser.program
    if (!body.primaryUniversity) body.primaryUniversity = targetUser.university
    res.json(body)
  } catch (error) {
    next(error)
  }
})

export default router

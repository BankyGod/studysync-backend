import path from 'path'
import fs from 'fs'
import { Router } from 'express'
import multer from 'multer'
import { v4 as uuid } from 'uuid'
import { UserProfile, StudyGroup, GroupMember, User, Task } from '../db/models.js'
import { config } from '../config.js'
import { authRequired, verifyToken } from '../middleware/auth.js'
import { forbidden, notFound, validationError } from '../utils/errors.js'
import { formatMember } from '../utils/serializers.js'
import { pickGroupAccent } from '../utils/helpers.js'
import { usersShareGroup } from '../services/matchingService.js'
import { computeUserReliability, formatReliability } from '../services/reliabilityService.js'
import {
  avatarUrlForUser,
  formatProfileResponse,
  isAllowedAvatarMimeType,
  loadAvatarProfile,
  normalizeAvatarMimeType,
  readAvatarBytes,
  verifyAvatarSig,
} from '../utils/profileAvatar.js'
import notificationsRouter from './notifications.js'

const router = Router()
const MAX_AVATAR_SIZE = 5 * 1024 * 1024

function avatarExtension(originalName, mimetype) {
  const ext = path.extname(originalName || '').toLowerCase()
  if (ext) return ext
  const mime = normalizeAvatarMimeType(mimetype)
  if (mime === 'image/png') return '.png'
  if (mime === 'image/webp') return '.webp'
  if (mime === 'image/gif') return '.gif'
  return '.jpg'
}

function avatarDiskPath(userId, originalName, mimetype) {
  const dir = path.join(config.uploadsDir, 'avatars', userId)
  fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, `${uuid()}${avatarExtension(originalName, mimetype)}`)
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_AVATAR_SIZE },
  fileFilter: (req, file, cb) => {
    if (!isAllowedAvatarMimeType(file.mimetype)) {
      cb(new Error('Profile photo must be JPEG, PNG, WebP, or GIF'))
      return
    }
    cb(null, true)
  },
})

function parseAvatarUpload(req, res, next) {
  upload.single('photo')(req, res, (err) => {
    if (req.file || err) {
      if (err) return next(err)
      return next()
    }
    upload.single('avatar')(req, res, next)
  })
}

async function authorizeAvatarAccess(req, targetUserId) {
  const { exp, sig } = req.query
  if (verifyAvatarSig(targetUserId, exp, sig)) {
    return true
  }

  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) {
    return false
  }

  try {
    const payload = verifyToken(header.slice(7))
    if (payload.sub === targetUserId) {
      return true
    }
    return usersShareGroup(payload.sub, targetUserId)
  } catch {
    return false
  }
}

router.get('/:userId/avatar', async (req, res, next) => {
  try {
    const userId = req.params.userId === 'me' ? null : req.params.userId
    if (!userId) {
      throw validationError('Use /users/me/profile for your own avatar metadata')
    }

    const allowed = await authorizeAvatarAccess(req, userId)
    if (!allowed) {
      throw forbidden('You can only view avatars of members in your study groups')
    }

    const profile = await loadAvatarProfile(userId, { includeData: true })
    const bytes = readAvatarBytes(profile)
    if (!bytes) {
      throw notFound('Profile photo not found')
    }

    res.setHeader('Content-Type', profile.avatar_mime_type || 'image/jpeg')
    res.setHeader('Cache-Control', 'private, max-age=3600')
    res.send(bytes)
  } catch (error) {
    next(error)
  }
})

router.use(authRequired)

router.use('/me/notifications', notificationsRouter)

async function loadProfileOrFail(userId) {
  const profile = await UserProfile.findOne({ user_id: userId })
    .select('user_id full_name student_role primary_university secondary_university location updated_at avatar_mime_type avatar_storage_key avatar_byte_length')
    .lean()
  if (!profile) {
    throw validationError('Profile not found')
  }
  return profile
}

async function ensureUserProfile(user, now = new Date().toISOString()) {
  let profile = await UserProfile.findOne({ user_id: user.id }).lean()
  if (profile) return profile

  await UserProfile.create({
    user_id: user.id,
    full_name: `${user.first_name} ${user.last_name}`.trim(),
    student_role: user.program ?? '',
    primary_university: user.university ?? '',
    location: '',
    updated_at: now,
  })

  return UserProfile.findOne({ user_id: user.id }).lean()
}

async function assertCanViewUserReliability(viewerId, targetUserId, groupIdOrSlug) {
  if (viewerId === targetUserId) return

  const sharesGroup = await usersShareGroup(viewerId, targetUserId)
  if (!sharesGroup) {
    throw forbidden('You can only view reliability for members in your study groups')
  }

  if (groupIdOrSlug) {
    const group = await StudyGroup.findOne({
      $or: [{ id: groupIdOrSlug }, { slug: groupIdOrSlug }],
    }).lean()
    if (!group) {
      throw notFound('Workspace not found')
    }

    const [viewerMember, targetMember] = await Promise.all([
      GroupMember.findOne({ group_id: group.id, user_id: viewerId }).lean(),
      GroupMember.findOne({ group_id: group.id, user_id: targetUserId }).lean(),
    ])

    if (!viewerMember || !targetMember) {
      throw forbidden('Both users must be members of the specified workspace')
    }
  }
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

router.post('/me/avatar', parseAvatarUpload, async (req, res, next) => {
  try {
    if (!req.file) {
      throw validationError('photo file is required (multipart field: photo or avatar)')
    }

    const profile = await ensureUserProfile(req.user)
    const mimeType = normalizeAvatarMimeType(req.file.mimetype)
    const diskPath = avatarDiskPath(req.user.id, req.file.originalname, mimeType)
    const now = new Date().toISOString()

    if (profile.avatar_storage_key && fs.existsSync(profile.avatar_storage_key)) {
      fs.unlinkSync(profile.avatar_storage_key)
    }

    fs.writeFileSync(diskPath, req.file.buffer)

    await UserProfile.updateOne(
      { user_id: req.user.id },
      {
        avatar_data: req.file.buffer,
        avatar_byte_length: req.file.buffer.length,
        avatar_storage_key: diskPath,
        avatar_mime_type: mimeType,
        updated_at: now,
      },
    )

    const updated = await loadAvatarProfile(req.user.id)
    res.json({
      avatarUrl: avatarUrlForUser(req.user.id, updated),
      updatedAt: now,
    })
  } catch (error) {
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
        avatar_data: null,
        avatar_byte_length: 0,
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
    const profiles = await UserProfile.find({ user_id: { $in: [...memberUserIds] } })
      .select(
        'user_id full_name student_role primary_university secondary_university location updated_at avatar_mime_type avatar_storage_key avatar_byte_length',
      )
      .lean()
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

router.get('/me/reliability', async (req, res, next) => {
  try {
    const result = await computeUserReliability(req.user.id, req.query.groupId?.trim() || null)
    res.json(formatReliability(result))
  } catch (error) {
    next(error)
  }
})

router.get('/:userId/reliability', async (req, res, next) => {
  try {
    const { userId } = req.params
    const groupId = req.query.groupId?.trim() || null

    if (userId !== req.user.id) {
      const targetUser = await User.findOne({ id: userId }).lean()
      if (!targetUser) {
        throw notFound('User not found')
      }
    }

    await assertCanViewUserReliability(req.user.id, userId, groupId)
    const result = await computeUserReliability(userId, groupId)
    res.json(formatReliability(result))
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
      const body = formatProfileResponse(profile, req.user, { includeEmail: true })
      const reliability = await computeUserReliability(userId, req.query.groupId?.trim() || null)
      body.reliability = formatReliability(reliability)
      return res.json(body)
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

    const groupId = req.query.groupId?.trim() || null
    await assertCanViewUserReliability(req.user.id, userId, groupId)
    const reliability = await computeUserReliability(userId, groupId)
    body.reliability = formatReliability(reliability)

    res.json(body)
  } catch (error) {
    next(error)
  }
})

export default router

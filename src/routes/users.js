import { Router } from 'express'
import { UserProfile, StudyGroup, GroupMember, User, Task } from '../db/models.js'
import { authRequired } from '../middleware/auth.js'
import { forbidden, notFound, validationError } from '../utils/errors.js'
import { formatMember } from '../utils/serializers.js'
import { pickGroupAccent } from '../utils/helpers.js'
import { usersShareGroup } from '../services/matchingService.js'

const router = Router()

router.use(authRequired)

router.get('/me/profile', async (req, res, next) => {
  try {
    const profile = await UserProfile.findOne({ user_id: req.user.id }).lean()

    if (!profile) {
      throw validationError('Profile not found')
    }

    res.json({
      fullName: profile.full_name,
      studentRole: profile.student_role,
      primaryUniversity: profile.primary_university,
      secondaryUniversity: profile.secondary_university ?? '',
      email: req.user.email,
      location: profile.location,
      updatedAt: profile.updated_at,
    })
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

    const profile = await UserProfile.findOne({ user_id: req.user.id }).lean()

    res.json({
      fullName: profile.full_name,
      studentRole: profile.student_role,
      primaryUniversity: profile.primary_university,
      secondaryUniversity: profile.secondary_university ?? '',
      email: req.user.email,
      location: profile.location,
      updatedAt: profile.updated_at,
    })
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

    const result = await Promise.all(
      groups.map(async (group) => {
        const members = await GroupMember.find({ group_id: group.id }).lean()
        const memberUsers = await User.find({ id: { $in: members.map((m) => m.user_id) } }).lean()
        const userById = Object.fromEntries(memberUsers.map((u) => [u.id, u]))

        const formattedMembers = members.map((m) => {
          const u = userById[m.user_id]
          return formatMember({
            user_id: m.user_id,
            initials: m.initials,
            avatar_color: m.avatar_color,
            first_name: u?.first_name,
            last_name: u?.last_name,
            program: u?.program,
          })
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
      return res.json({
        fullName: profile.full_name,
        studentRole: profile.student_role,
        primaryUniversity: profile.primary_university,
        secondaryUniversity: profile.secondary_university ?? '',
        email: req.user.email,
        location: profile.location,
      })
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

    res.json({
      fullName: profile.full_name,
      studentRole: profile.student_role || targetUser.program,
      primaryUniversity: profile.primary_university || targetUser.university,
      secondaryUniversity: profile.secondary_university ?? '',
      location: profile.location,
    })
  } catch (error) {
    next(error)
  }
})

export default router

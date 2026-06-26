import { Router } from 'express'
import { GroupMember, User, UserProfile } from '../../db/models.js'
import { authRequired, requireGroupMember } from '../../middleware/auth.js'
import { formatMember } from '../../utils/serializers.js'
import { formatCourseLabel } from '../../utils/helpers.js'
import { avatarUrlForUser } from '../../utils/profileAvatar.js'
import { computeReliabilityBatch, formatReliability } from '../../services/reliabilityService.js'

const router = Router({ mergeParams: true })

router.use(authRequired, requireGroupMember)

router.get('/', async (req, res, next) => {
  try {
    const members = await GroupMember.find({ group_id: req.group.id }).lean()
    const users = await User.find({ id: { $in: members.map((m) => m.user_id) } }).lean()
    const profiles = await UserProfile.find({ user_id: { $in: members.map((m) => m.user_id) } }).lean()
    const userById = Object.fromEntries(users.map((u) => [u.id, u]))
    const profileByUserId = Object.fromEntries(profiles.map((p) => [p.user_id, p]))
    const memberIds = members.map((m) => m.user_id)
    const reliabilityByUser = await computeReliabilityBatch(memberIds, req.group.id, req.group.slug)

    const formatted = members.map((m) => {
      const u = userById[m.user_id]
      const member = formatMember({
        user_id: m.user_id,
        initials: m.initials,
        avatar_color: m.avatar_color,
        first_name: u?.first_name,
        last_name: u?.last_name,
        program: u?.program,
      })
      const avatarUrl = avatarUrlForUser(m.user_id, profileByUserId[m.user_id])
      if (avatarUrl) member.avatarUrl = avatarUrl
      member.reliability = formatReliability(reliabilityByUser[m.user_id])
      return member
    })

    res.json({
      groupId: req.group.slug,
      title: req.group.title,
      courseLabel: formatCourseLabel(req.group.subject, req.group.course_number),
      members: formatted,
    })
  } catch (error) {
    next(error)
  }
})

export default router

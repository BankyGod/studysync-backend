import { Router } from 'express'
import { GroupMember, User } from '../../db/models.js'
import { authRequired, requireGroupMember } from '../../middleware/auth.js'
import { formatMember } from '../../utils/serializers.js'
import { formatCourseLabel } from '../../utils/helpers.js'

const router = Router({ mergeParams: true })

router.use(authRequired, requireGroupMember)

router.get('/', async (req, res, next) => {
  try {
    const members = await GroupMember.find({ group_id: req.group.id }).lean()
    const users = await User.find({ id: { $in: members.map((m) => m.user_id) } }).lean()
    const userById = Object.fromEntries(users.map((u) => [u.id, u]))

    const formatted = members.map((m) => {
      const u = userById[m.user_id]
      return formatMember({
        user_id: m.user_id,
        initials: m.initials,
        avatar_color: m.avatar_color,
        first_name: u?.first_name,
        last_name: u?.last_name,
      })
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

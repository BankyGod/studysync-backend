import { Router } from 'express'
import { v4 as uuid } from 'uuid'
import bcrypt from 'bcryptjs'
import {
  Cohort,
  User,
  UserProfile,
  UserCourse,
  StudyGroup,
  GroupMember,
  Task,
  Message,
  StoredFile,
  OnboardingProfile,
} from '../db/models.js'
import { authRequired, requireRole } from '../middleware/auth.js'
import { conflict, forbidden, notFound, validationError } from '../utils/errors.js'
import { computeReliabilityBatch, computeUserReliability, formatReliability } from '../services/reliabilityService.js'
import { avatarUrlForUser } from '../utils/profileAvatar.js'
import {
  getOverviewReport,
  getEngagementReport,
  getPodsReport,
  getReliabilityReport,
  getCoursesReport,
  getActivityReport,
} from '../services/adminReportService.js'

const router = Router()

router.use(authRequired, requireRole('admin', 'instructor'))

function requireAdminOnly(req, res, next) {
  if (req.user.role !== 'admin') {
    next(forbidden('Only admins can perform this action'))
    return
  }
  next()
}

router.get('/dashboard', async (req, res, next) => {
  try {
    const [overview, engagement, activity] = await Promise.all([
      getOverviewReport(),
      getEngagementReport(),
      getActivityReport({ days: 7 }),
    ])

    // Flat summary for Instructor overview cards (Students / Pods / Cohorts / Matched)
    const summary = {
      students: overview.students,
      pods: overview.pods,
      cohorts: overview.cohorts,
      matched: overview.matched,
    }

    res.json({
      summary,
      overview,
      engagement,
      recentActivity: activity,
    })
  } catch (error) {
    next(error)
  }
})

router.get('/reports/overview', async (req, res, next) => {
  try {
    res.json(await getOverviewReport())
  } catch (error) {
    next(error)
  }
})

router.get('/reports/engagement', async (req, res, next) => {
  try {
    res.json(await getEngagementReport())
  } catch (error) {
    next(error)
  }
})

router.get('/reports/pods', async (req, res, next) => {
  try {
    res.json(await getPodsReport())
  } catch (error) {
    next(error)
  }
})

router.get('/reports/reliability', async (req, res, next) => {
  try {
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20))
    res.json(await getReliabilityReport({ limit }))
  } catch (error) {
    next(error)
  }
})

router.get('/reports/courses', async (req, res, next) => {
  try {
    res.json(await getCoursesReport())
  } catch (error) {
    next(error)
  }
})

router.get('/reports/activity', async (req, res, next) => {
  try {
    const days = Number(req.query.days) || 30
    res.json(await getActivityReport({ days }))
  } catch (error) {
    next(error)
  }
})

router.get('/cohorts', async (req, res, next) => {
  try {
    let cohorts = await Cohort.find().sort({ created_at: -1 }).lean()

    // If pods exist but no cohorts, create a default active cohort and attach orphans
    if (cohorts.length === 0) {
      const orphanPods = await StudyGroup.countDocuments({
        $or: [{ cohort_id: null }, { cohort_id: { $exists: false } }, { cohort_id: '' }],
      })
      if (orphanPods > 0) {
        const id = uuid()
        const now = new Date().toISOString()
        await Cohort.create({
          id,
          name: 'Default Cohort',
          term: new Date().getFullYear().toString(),
          created_at: now,
        })
        await StudyGroup.updateMany(
          {
            $or: [{ cohort_id: null }, { cohort_id: { $exists: false } }, { cohort_id: '' }],
          },
          { cohort_id: id },
        )
        cohorts = await Cohort.find().sort({ created_at: -1 }).lean()
      }
    }

    const result = await Promise.all(
      cohorts.map(async (c) => {
        const groups = await StudyGroup.find({ cohort_id: c.id }, { id: 1, slug: 1, title: 1 }).lean()
        const groupIds = groups.map((g) => g.id)
        const memberUserIds = groupIds.length
          ? await GroupMember.distinct('user_id', { group_id: { $in: groupIds } })
          : []

        return {
          id: c.id,
          name: c.name,
          term: c.term,
          studentCount: memberUserIds.length,
          podCount: groups.length,
          pods: groups.map((g) => ({
            id: g.id,
            groupId: g.slug,
            title: g.title,
          })),
          createdAt: c.created_at,
        }
      }),
    )

    res.json({
      cohorts: result,
      total: result.length,
    })
  } catch (error) {
    next(error)
  }
})

router.post('/cohorts', async (req, res, next) => {
  try {
    const { name, term } = req.body ?? {}
    if (!name?.trim()) {
      throw validationError('Cohort name is required')
    }

    const id = uuid()
    const now = new Date().toISOString()
    const cleanName = name.trim()
    const cleanTerm = term?.trim() || null

    await Cohort.create({
      id,
      name: cleanName,
      term: cleanTerm,
      created_at: now,
    })

    res.status(201).json({
      id,
      name: cleanName,
      term: cleanTerm,
      studentCount: 0,
      podCount: 0,
      pods: [],
      createdAt: now,
    })
  } catch (error) {
    next(error)
  }
})

router.post('/users', requireAdminOnly, async (req, res, next) => {
  try {
    const {
      email,
      password,
      firstName,
      lastName,
      role = 'instructor',
      university = 'Ghana Communication Technology University (GCTU)',
      program = 'Staff',
      level = '400',
      studentId,
      phone,
    } = req.body ?? {}

    if (!email?.trim() || !password || !firstName?.trim() || !lastName?.trim()) {
      throw validationError('email, password, firstName, and lastName are required')
    }

    if (!['instructor', 'admin'].includes(role)) {
      throw validationError('role must be instructor or admin')
    }

    if (password.length < 8) {
      throw validationError('Password must be at least 8 characters')
    }

    const normalizedEmail = email.toLowerCase().trim()
    const existingEmail = await User.findOne({ email: normalizedEmail }).lean()
    if (existingEmail) {
      throw conflict('Email already registered')
    }

    const now = new Date().toISOString()
    const userId = uuid()
    const staffStudentId = studentId?.trim() || `STAFF-${Date.now()}`

    const existingStudentId = await User.findOne({ student_id: staffStudentId }).lean()
    if (existingStudentId) {
      throw conflict('Student ID already registered')
    }

    await User.create({
      id: userId,
      email: normalizedEmail,
      password_hash: bcrypt.hashSync(password, 10),
      first_name: firstName.trim(),
      last_name: lastName.trim(),
      student_id: staffStudentId,
      phone: phone?.trim() || null,
      university,
      program,
      level: String(level),
      role,
      created_at: now,
      updated_at: now,
    })

    await UserProfile.create({
      user_id: userId,
      full_name: `${firstName.trim()} ${lastName.trim()}`,
      student_role: program,
      primary_university: university,
      location: '',
      updated_at: now,
    })

    res.status(201).json({
      id: userId,
      email: normalizedEmail,
      name: `${firstName.trim()} ${lastName.trim()}`,
      role,
      studentId: staffStudentId,
      createdAt: now,
    })
  } catch (error) {
    next(error)
  }
})

router.get('/groups', async (req, res, next) => {
  try {
    const match = {}
    if (req.query.cohortId) match.cohort_id = String(req.query.cohortId)
    if (req.query.subject) match.subject = new RegExp(`^${String(req.query.subject).trim()}$`, 'i')
    if (req.query.courseNumber) {
      match.course_number = new RegExp(`^${String(req.query.courseNumber).trim()}$`, 'i')
    }

    const groups = await StudyGroup.aggregate([
      { $match: match },
      {
        $lookup: {
          from: 'group_members',
          localField: 'id',
          foreignField: 'group_id',
          as: 'members',
        },
      },
      { $addFields: { member_count: { $size: '$members' } } },
      { $sort: { created_at: -1 } },
    ])

    const allMemberIds = [...new Set(groups.flatMap((g) => g.members.map((m) => m.user_id)))]
    const users = allMemberIds.length
      ? await User.find({ id: { $in: allMemberIds } })
          .select('id first_name last_name email program level')
          .lean()
      : []
    const userById = Object.fromEntries(users.map((u) => [u.id, u]))
    const memberProfiles = allMemberIds.length
      ? await UserProfile.find({ user_id: { $in: allMemberIds } })
          .select('user_id avatar_mime_type avatar_storage_key avatar_byte_length')
          .lean()
      : []
    const profileByUserId = Object.fromEntries(memberProfiles.map((p) => [p.user_id, p]))

    const result = await Promise.all(
      groups.map(async (g) => {
        const memberIds = g.members.map((m) => m.user_id)
        const reliabilityByUser = await computeReliabilityBatch(memberIds, g.id, g.slug)

        const members = g.members.map((m) => {
          const u = userById[m.user_id]
          const reliability = formatReliability(
            reliabilityByUser[m.user_id] || { score: null, tasksScored: 0, scope: 'group', groupId: g.slug },
          )
          const atRisk = reliability.score !== null && reliability.score < 60
          const avatarUrl = avatarUrlForUser(m.user_id, profileByUserId[m.user_id])

          return {
            id: m.user_id,
            name: u ? `${u.first_name} ${u.last_name}`.trim() : 'Unknown',
            email: u?.email,
            program: u?.program,
            level: u?.level,
            initials: m.initials,
            joinedAt: m.joined_at,
            reliability,
            atRisk,
            avatarUrl,
          }
        })

        const atRiskCount = members.filter((m) => m.atRisk).length

        return {
          id: g.id,
          groupId: g.slug,
          title: g.title,
          subject: g.subject,
          courseNumber: g.course_number,
          memberCount: g.member_count,
          atRiskCount,
          members,
          cohortId: g.cohort_id,
          createdAt: g.created_at,
        }
      }),
    )

    res.json({ groups: result })
  } catch (error) {
    next(error)
  }
})

router.get('/groups/:groupId', async (req, res, next) => {
  try {
    const group = await StudyGroup.findOne({
      $or: [{ id: req.params.groupId }, { slug: req.params.groupId }],
    }).lean()

    if (!group) {
      throw notFound('Study group not found')
    }

    const members = await GroupMember.find({ group_id: group.id }).lean()
    const users = members.length
      ? await User.find({ id: { $in: members.map((m) => m.user_id) } }).lean()
      : []
    const userById = Object.fromEntries(users.map((u) => [u.id, u]))
    const memberProfiles = members.length
      ? await UserProfile.find({ user_id: { $in: members.map((m) => m.user_id) } })
          .select('user_id avatar_mime_type avatar_storage_key avatar_byte_length')
          .lean()
      : []
    const profileByUserId = Object.fromEntries(memberProfiles.map((p) => [p.user_id, p]))
    const reliabilityByUser = await computeReliabilityBatch(
      members.map((m) => m.user_id),
      group.id,
      group.slug,
    )

    const [taskStats, messageCount, fileCount] = await Promise.all([
      Task.aggregate([
        { $match: { group_id: group.id } },
        {
          $group: {
            _id: '$status',
            count: { $sum: 1 },
          },
        },
      ]),
      Message.countDocuments({ group_id: group.id }),
      StoredFile.countDocuments({ group_id: group.id }),
    ])

    const tasks = { todo: 0, inProgress: 0, completed: 0, total: 0 }
    taskStats.forEach((row) => {
      if (row._id === 'todo') tasks.todo = row.count
      if (row._id === 'in_progress') tasks.inProgress = row.count
      if (row._id === 'completed') tasks.completed = row.count
      tasks.total += row.count
    })

    const formattedMembers = members.map((m) => {
      const u = userById[m.user_id]
      const reliability = formatReliability(
        reliabilityByUser[m.user_id] || {
          score: null,
          tasksScored: 0,
          scope: 'group',
          groupId: group.slug,
        },
      )
      const avatarUrl = avatarUrlForUser(m.user_id, profileByUserId[m.user_id])
      return {
        id: m.user_id,
        name: u ? `${u.first_name} ${u.last_name}`.trim() : 'Unknown',
        email: u?.email,
        program: u?.program,
        level: u?.level,
        joinedAt: m.joined_at,
        initials: m.initials,
        reliability,
        atRisk: reliability.score !== null && reliability.score < 60,
        avatarUrl,
      }
    })

    res.json({
      id: group.id,
      groupId: group.slug,
      title: group.title,
      subject: group.subject,
      courseNumber: group.course_number,
      cohortId: group.cohort_id,
      createdAt: group.created_at,
      atRiskCount: formattedMembers.filter((m) => m.atRisk).length,
      members: formattedMembers,
      stats: {
        memberCount: members.length,
        tasks,
        messages: messageCount,
        files: fileCount,
      },
    })
  } catch (error) {
    next(error)
  }
})

router.get('/students', async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1)
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20))
    const offset = (page - 1) * limit
    const q = String(req.query.q || '').trim()
    const level = req.query.level ? String(req.query.level).trim() : null
    const program = req.query.program ? String(req.query.program).trim() : null
    const onboarding = req.query.onboarding
    const matched = req.query.matched

    const match = { role: 'student' }
    if (level) match.level = level
    if (program) match.program = new RegExp(program, 'i')
    if (q) {
      match.$or = [
        { first_name: new RegExp(q, 'i') },
        { last_name: new RegExp(q, 'i') },
        { email: new RegExp(q, 'i') },
        { student_id: new RegExp(q, 'i') },
      ]
    }

    let students = await User.aggregate([
      { $match: match },
      { $sort: { created_at: -1 } },
      {
        $lookup: {
          from: 'onboarding_profiles',
          localField: 'id',
          foreignField: 'user_id',
          as: 'onboarding',
        },
      },
      {
        $addFields: {
          onboarding_completed: { $arrayElemAt: ['$onboarding.completed_at', 0] },
        },
      },
    ])

    if (onboarding === 'true' || onboarding === 'false') {
      const want = onboarding === 'true'
      students = students.filter((s) => Boolean(s.onboarding_completed) === want)
    }

    const memberships = await GroupMember.find(
      { user_id: { $in: students.map((s) => s.id) } },
      { user_id: 1, group_id: 1 },
    ).lean()
    const memberUserIds = new Set(memberships.map((m) => m.user_id))

    if (matched === 'true' || matched === 'false') {
      const wantMatched = matched === 'true'
      students = students.filter((s) => memberUserIds.has(s.id) === wantMatched)
    }

    const total = students.length
    const pageRows = students.slice(offset, offset + limit)

    const groupIds = [
      ...new Set(
        memberships.filter((m) => pageRows.some((s) => s.id === m.user_id)).map((m) => m.group_id),
      ),
    ]
    const groups = groupIds.length
      ? await StudyGroup.find({ id: { $in: groupIds } }, { id: 1, slug: 1, title: 1 }).lean()
      : []
    const groupById = Object.fromEntries(groups.map((g) => [g.id, g]))

    const pageIds = pageRows.map((s) => s.id)
    const profiles = pageIds.length
      ? await UserProfile.find({ user_id: { $in: pageIds } })
          .select('user_id avatar_mime_type avatar_storage_key avatar_byte_length')
          .lean()
      : []
    const profileByUserId = Object.fromEntries(profiles.map((p) => [p.user_id, p]))

    const result = pageRows.map((s) => {
      const userGroups = memberships
        .filter((m) => m.user_id === s.id)
        .map((m) => groupById[m.group_id])
        .filter(Boolean)
        .map((g) => ({ id: g.id, groupId: g.slug, title: g.title }))

      const avatarUrl = avatarUrlForUser(s.id, profileByUserId[s.id])

      return {
        id: s.id,
        name: `${s.first_name} ${s.last_name}`.trim(),
        email: s.email,
        studentId: s.student_id,
        program: s.program,
        level: s.level,
        university: s.university,
        onboardingCompleted: Boolean(s.onboarding_completed),
        matched: userGroups.length > 0,
        groups: userGroups,
        createdAt: s.created_at,
        avatarUrl,
      }
    })

    res.json({
      students: result,
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    })
  } catch (error) {
    next(error)
  }
})

router.get('/students/:userId', async (req, res, next) => {
  try {
    const user = await User.findOne({ id: req.params.userId, role: 'student' }).lean()
    if (!user) {
      throw notFound('Student not found')
    }

    const [profile, onboarding, courses, memberships] = await Promise.all([
      UserProfile.findOne({ user_id: user.id }).lean(),
      OnboardingProfile.findOne({ user_id: user.id }).lean(),
      UserCourse.find({ user_id: user.id }).sort({ is_primary: -1 }).lean(),
      GroupMember.find({ user_id: user.id }).lean(),
    ])

    const groups = memberships.length
      ? await StudyGroup.find({ id: { $in: memberships.map((m) => m.group_id) } }).lean()
      : []

    const reliability = formatReliability(await computeUserReliability(user.id))
    const avatarUrl = avatarUrlForUser(user.id, profile)

    res.json({
      id: user.id,
      name: `${user.first_name} ${user.last_name}`.trim(),
      email: user.email,
      studentId: user.student_id,
      phone: user.phone ?? '',
      program: user.program,
      level: user.level,
      university: user.university,
      createdAt: user.created_at,
      avatarUrl,
      profile: profile
        ? {
            fullName: profile.full_name,
            studentRole: profile.student_role,
            primaryUniversity: profile.primary_university,
            secondaryUniversity: profile.secondary_university ?? '',
            location: profile.location,
            avatarUrl,
          }
        : null,
      onboarding: onboarding
        ? {
            learningStyle: onboarding.learning_style,
            completedAt: onboarding.completed_at,
            savedAt: onboarding.saved_at,
          }
        : null,
      courses: courses.map((c) => ({
        id: c.id,
        subject: c.subject,
        courseNumber: c.course_number,
        isPrimary: Boolean(c.is_primary),
      })),
      groups: groups.map((g) => ({
        id: g.id,
        groupId: g.slug,
        title: g.title,
        subject: g.subject,
        courseNumber: g.course_number,
      })),
      reliability,
    })
  } catch (error) {
    next(error)
  }
})

export default router

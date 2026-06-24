import { Router } from 'express'
import { v4 as uuid } from 'uuid'
import bcrypt from 'bcryptjs'
import { Cohort, User, UserProfile, StudyGroup, GroupMember } from '../db/models.js'
import { authRequired, requireRole } from '../middleware/auth.js'
import { notFound, validationError } from '../utils/errors.js'
import { courseToSlug } from '../utils/helpers.js'

const router = Router()

router.use(authRequired, requireRole('instructor'))

router.get('/cohorts', async (req, res, next) => {
  try {
    const cohorts = await Cohort.find().sort({ created_at: -1 }).lean()
    const studentCount = await User.countDocuments({ role: 'student' })

    const result = await Promise.all(
      cohorts.map(async (c) => {
        const groupCount = await StudyGroup.countDocuments({ cohort_id: c.id })
        return { id: c.id, name: c.name, term: c.term, studentCount, groupCount }
      }),
    )

    res.json({ cohorts: result })
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

    await Cohort.create({
      id,
      name: name.trim(),
      term: term?.trim() || null,
      created_at: now,
    })

    res.status(201).json({ id, name: name.trim(), term: term?.trim() || null, createdAt: now })
  } catch (error) {
    next(error)
  }
})

router.post('/seed', async (req, res, next) => {
  try {
    const { cohortId, studentCount = 10, courses = [] } = req.body ?? {}

    if (!cohortId) {
      throw validationError('cohortId is required')
    }

    const cohort = await Cohort.findOne({ id: cohortId }).lean()
    if (!cohort) {
      throw notFound('Cohort not found')
    }

    const now = new Date().toISOString()
    let created = 0

    for (let i = 0; i < studentCount; i += 1) {
      const id = uuid()
      const email = `student${Date.now()}${i}@studysync.local`
      const passwordHash = bcrypt.hashSync('password123', 10)

      await User.create({
        id,
        email,
        password_hash: passwordHash,
        first_name: 'Student',
        last_name: `${i + 1}`,
        student_id: `STU-${Date.now()}-${i}`,
        university: 'Ghana Communication Technology University (GCTU)',
        program: 'BSc. Computer Science',
        level: '400',
        role: 'student',
        created_at: now,
        updated_at: now,
      })

      await UserProfile.create({
        user_id: id,
        full_name: `Student ${i + 1}`,
        student_role: 'BSc. Computer Science',
        primary_university: 'GCTU',
        location: 'Accra, Ghana',
        updated_at: now,
      })

      created += 1
    }

    res.status(201).json({ cohortId, studentsCreated: created, courses })
  } catch (error) {
    next(error)
  }
})

router.post('/matching/run', async (req, res, next) => {
  try {
    const { cohortId, courseCode } = req.body ?? {}

    let subject
    let courseNumber

    if (courseCode) {
      const group = await StudyGroup.findOne({ slug: courseCode }).lean()
      if (group) {
        subject = group.subject
        courseNumber = group.course_number
      }
    }

    if (!subject && coursesFromBody(req.body)) {
      ;({ subject, courseNumber } = coursesFromBody(req.body))
    }

    if (!subject) {
      throw validationError('courseCode or courses required')
    }

    const jobId = uuid()
    res.status(202).json({
      jobId,
      status: 'running',
      groupsCreated: 0,
      studentsMatched: 0,
      cohortId: cohortId ?? null,
      courseCode: courseToSlug(subject, courseNumber),
    })
  } catch (error) {
    next(error)
  }
})

function coursesFromBody(body) {
  const course = body.courses?.[0]
  if (!course?.subject || !course?.courseNumber) return null
  return { subject: course.subject, courseNumber: course.courseNumber }
}

router.get('/groups', async (req, res, next) => {
  try {
    const groups = await StudyGroup.aggregate([
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

    res.json({
      groups: groups.map((g) => ({
        id: g.id,
        groupId: g.slug,
        title: g.title,
        subject: g.subject,
        courseNumber: g.course_number,
        memberCount: g.member_count,
        cohortId: g.cohort_id,
        createdAt: g.created_at,
      })),
    })
  } catch (error) {
    next(error)
  }
})

router.get('/students', async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1)
    const limit = 20
    const offset = (page - 1) * limit

    const students = await User.aggregate([
      { $match: { role: 'student' } },
      { $sort: { created_at: -1 } },
      { $skip: offset },
      { $limit: limit },
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

    const result = await Promise.all(
      students.map(async (s) => {
        const memberships = await GroupMember.find({ user_id: s.id }).lean()
        const groups = await StudyGroup.find(
          { id: { $in: memberships.map((m) => m.group_id) } },
          { slug: 1, title: 1 },
        ).lean()

        return {
          id: s.id,
          name: `${s.first_name} ${s.last_name}`.trim(),
          email: s.email,
          studentId: s.student_id,
          program: s.program,
          level: s.level,
          onboardingCompleted: Boolean(s.onboarding_completed),
          groups,
        }
      }),
    )

    res.json({ students: result, page })
  } catch (error) {
    next(error)
  }
})

export default router

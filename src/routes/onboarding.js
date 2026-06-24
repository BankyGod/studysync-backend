import { Router } from 'express'
import { v4 as uuid } from 'uuid'
import { OnboardingProfile, UserCourse } from '../db/models.js'
import { authRequired, requireRole } from '../middleware/auth.js'
import { notFound, validationError } from '../utils/errors.js'

const router = Router()

const LEARNING_STYLES = ['visual', 'auditory', 'reading', 'kinesthetic']
const GROUP_SIZES = ['small', 'medium', 'large']
const TIME_COMMITMENTS = ['low', 'medium', 'high']
const DIFFICULTIES = ['beginner', 'intermediate', 'advanced']

function validateOnboarding(body) {
  const { learningStyle, availability, courses, studyPreferences } = body ?? {}

  if (!learningStyle || !LEARNING_STYLES.includes(learningStyle)) {
    throw validationError('Invalid learning style')
  }

  if (!Array.isArray(availability) || availability.length === 0 || availability.length > 5) {
    throw validationError('Availability must contain 1 to 5 slots')
  }

  const validCourses = (courses ?? []).filter((c) => c.subject?.trim() && c.courseNumber?.trim())
  if (validCourses.length === 0) {
    throw validationError('At least one valid course is required')
  }

  const prefs = studyPreferences ?? {}
  if (!GROUP_SIZES.includes(prefs.groupSize)) {
    throw validationError('Invalid groupSize preference')
  }
  if (!TIME_COMMITMENTS.includes(prefs.timeCommitment)) {
    throw validationError('Invalid timeCommitment preference')
  }
  if (!DIFFICULTIES.includes(prefs.difficulty)) {
    throw validationError('Invalid difficulty preference')
  }

  return { learningStyle, availability, validCourses, studyPreferences: prefs }
}

export async function loadProfile(userId) {
  const profile = await OnboardingProfile.findOne({ user_id: userId }).lean()
  if (!profile) return null

  const courses = await UserCourse.find({ user_id: userId })
    .sort({ is_primary: -1 })
    .lean()

  return {
    learningStyle: profile.learning_style,
    availability: JSON.parse(profile.availability),
    courses: courses.map((c) => ({ id: c.id, subject: c.subject, courseNumber: c.course_number })),
    studyPreferences: JSON.parse(profile.study_preferences),
    savedAt: profile.saved_at,
  }
}

router.use(authRequired, requireRole('student'))

router.get('/profile', async (req, res, next) => {
  try {
    const profile = await loadProfile(req.user.id)
    if (!profile) {
      throw notFound('Onboarding profile not found')
    }
    res.json(profile)
  } catch (error) {
    next(error)
  }
})

router.post('/profile', async (req, res, next) => {
  try {
    const { learningStyle, availability, validCourses, studyPreferences } = validateOnboarding(req.body)
    const now = new Date().toISOString()

    const existing = await OnboardingProfile.findOne({ user_id: req.user.id }).lean()

    if (existing) {
      await OnboardingProfile.updateOne(
        { user_id: req.user.id },
        {
          learning_style: learningStyle,
          availability: JSON.stringify(availability),
          study_preferences: JSON.stringify(studyPreferences),
          completed_at: now,
          saved_at: now,
        },
      )
    } else {
      await OnboardingProfile.create({
        user_id: req.user.id,
        learning_style: learningStyle,
        availability: JSON.stringify(availability),
        study_preferences: JSON.stringify(studyPreferences),
        completed_at: now,
        saved_at: now,
      })
    }

    await UserCourse.deleteMany({ user_id: req.user.id })

    await UserCourse.insertMany(
      validCourses.map((course, index) => ({
        id: uuid(),
        user_id: req.user.id,
        subject: course.subject.trim(),
        course_number: course.courseNumber.trim(),
        is_primary: index === 0 ? 1 : 0,
      })),
    )

    res.json(await loadProfile(req.user.id))
  } catch (error) {
    next(error)
  }
})

export default router

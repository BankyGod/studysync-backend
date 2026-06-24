import { Router } from 'express'
import { authRequired, requireRole } from '../middleware/auth.js'
import { notFound, validationError } from '../utils/errors.js'
import { getMatchingJob, listCourseGroups, runMatchingForUser } from '../services/matchingService.js'
import { loadProfile } from './onboarding.js'

const router = Router()

router.use(authRequired, requireRole('student'))

router.post('/find-group', async (req, res, next) => {
  try {
    const profile = await loadProfile(req.user.id)
    if (!profile && !req.body?.course) {
      throw validationError('Complete onboarding before matching')
    }

    const io = req.app.get('io')
    const result = await runMatchingForUser(req.user, req.body ?? {}, io)
    res.status(202).json(result)
  } catch (error) {
    next(error)
  }
})

router.get('/jobs/:jobId', async (req, res, next) => {
  try {
    const job = await getMatchingJob(req.params.jobId, req.user.id)
    if (!job) {
      throw notFound('Matching job not found')
    }
    res.json(job)
  } catch (error) {
    next(error)
  }
})

router.get('/course/:courseCode', async (req, res, next) => {
  try {
    const groups = await listCourseGroups(req.params.courseCode)
    res.json({ courseCode: req.params.courseCode, groups })
  } catch (error) {
    next(error)
  }
})

export default router

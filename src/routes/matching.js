import { Router } from 'express'
import { authRequired, requireRole } from '../middleware/auth.js'
import { notFound, validationError } from '../utils/errors.js'
import {
  getMatchingJob,
  joinGroup,
  leaveGroup,
  listCourseGroups,
  runMatchingForUser,
} from '../services/matchingService.js'
import { loadProfile } from './onboarding.js'

const router = Router()

router.use(authRequired, requireRole('student'))

router.post('/find-group', async (req, res, next) => {
  try {
    const { course } = req.body ?? {}
    if (!course?.subject?.trim() || !course?.courseNumber?.trim()) {
      throw validationError('course with subject and courseNumber is required')
    }

    const io = req.app.get('io')
    const result = await runMatchingForUser(req.user, req.body ?? {}, io)

    if (result.status === 'completed') {
      res.status(200).json(result)
      return
    }
    if (result.status === 'waiting') {
      res.status(202).json(result)
      return
    }
    res.status(202).json(result)
  } catch (error) {
    next(error)
  }
})

router.post('/groups/:groupId/join', async (req, res, next) => {
  try {
    const profile = await loadProfile(req.user.id)
    const studyPreferences = req.body?.studyPreferences ?? profile?.studyPreferences ?? { groupSize: 'medium' }
    const match = await joinGroup(req.user, req.params.groupId, studyPreferences)
    res.status(200).json({ match })
  } catch (error) {
    next(error)
  }
})

async function handleLeave(req, res, next) {
  try {
    const result = await leaveGroup(req.user.id, req.params.groupId)
    res.json(result)
  } catch (error) {
    next(error)
  }
}

router.delete('/groups/:groupId/leave', handleLeave)
router.post('/groups/:groupId/leave', handleLeave)

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

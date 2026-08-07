import { Router } from 'express'
import { authRequired, requireGroupMember } from '../../middleware/auth.js'
import { notFound } from '../../utils/errors.js'
import {
  endVideoCall,
  formatVideoCall,
  getActiveCallForGroup,
  joinVideoCall,
  leaveVideoCall,
  startVideoCall,
} from '../../services/videoCallService.js'
import { VideoCall } from '../../db/models.js'

const router = Router({ mergeParams: true })

router.use(authRequired, requireGroupMember)

function displayInfo(user) {
  return {
    displayName: `${user.first_name} ${user.last_name}`.trim(),
    userEmail: user.email,
  }
}

router.get('/active', async (req, res, next) => {
  try {
    const call = await getActiveCallForGroup(req.group.id)
    if (!call) {
      res.json({ call: null })
      return
    }
    res.json({ call: formatVideoCall(call, displayInfo(req.user)) })
  } catch (error) {
    next(error)
  }
})

router.post('/', async (req, res, next) => {
  try {
    const io = req.app.get('io')
    const result = await startVideoCall({
      group: req.group,
      user: req.user,
      title: req.body?.title,
      io,
    })
    res.status(201).json(result)
  } catch (error) {
    next(error)
  }
})

router.get('/:callId', async (req, res, next) => {
  try {
    const call = await VideoCall.findOne({
      id: req.params.callId,
      group_id: req.group.id,
    }).lean()

    if (!call) {
      throw notFound('Video call not found')
    }

    res.json({ call: formatVideoCall(call, displayInfo(req.user)) })
  } catch (error) {
    next(error)
  }
})

router.post('/:callId/join', async (req, res, next) => {
  try {
    const io = req.app.get('io')
    const call = await joinVideoCall({
      group: req.group,
      callId: req.params.callId,
      user: req.user,
      io,
    })
    res.json({ call })
  } catch (error) {
    next(error)
  }
})

router.post('/:callId/leave', async (req, res, next) => {
  try {
    const io = req.app.get('io')
    const call = await leaveVideoCall({
      group: req.group,
      callId: req.params.callId,
      user: req.user,
      io,
    })
    res.json({ call })
  } catch (error) {
    next(error)
  }
})

router.post('/:callId/end', async (req, res, next) => {
  try {
    const io = req.app.get('io')
    const call = await endVideoCall({
      group: req.group,
      callId: req.params.callId,
      user: req.user,
      io,
    })
    res.json({ call })
  } catch (error) {
    next(error)
  }
})

export default router

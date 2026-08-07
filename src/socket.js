import { Server } from 'socket.io'
import { verifyToken } from './middleware/auth.js'
import { User, StudyGroup, GroupMember } from './db/models.js'
import { isAllowedCorsOrigin } from './config.js'

export function initSocket(httpServer, app) {
  const io = new Server(httpServer, {
    cors: {
      origin(origin, callback) {
        if (isAllowedCorsOrigin(origin)) {
          callback(null, true)
          return
        }
        callback(null, false)
      },
      credentials: true,
    },
    path: '/socket.io',
  })

  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token
      if (!token) {
        next(new Error('Authentication required'))
        return
      }

      const payload = verifyToken(token)
      const user = await User.findOne({ id: payload.sub }).lean()

      if (!user) {
        next(new Error('User not found'))
        return
      }

      socket.user = user
      socket.join(`user:${user.id}`)
      next()
    } catch {
      next(new Error('Invalid token'))
    }
  })

  io.on('connection', (socket) => {
    socket.on('join:workspace', async ({ groupId }) => {
      if (!groupId) return

      const group = await StudyGroup.findOne({ slug: groupId }).lean()
      if (!group) return

      const membership = await GroupMember.findOne({ group_id: group.id, user_id: socket.user.id }).lean()

      if (!membership && socket.user.role !== 'instructor' && socket.user.role !== 'admin') return

      socket.join(`workspace:${groupId}`)
    })

    socket.on('leave:workspace', ({ groupId }) => {
      if (groupId) {
        socket.leave(`workspace:${groupId}`)
      }
    })

    // In-app WebRTC video calls — stay inside StudySync UI (no redirect)
    socket.on('call:join-room', async ({ callId, groupId }) => {
      if (!callId || !groupId) return

      const group = await StudyGroup.findOne({ slug: groupId }).lean()
      if (!group) return

      const membership = await GroupMember.findOne({
        group_id: group.id,
        user_id: socket.user.id,
      }).lean()

      if (!membership && socket.user.role !== 'instructor' && socket.user.role !== 'admin') return

      socket.join(`call:${callId}`)
      socket.to(`call:${callId}`).emit('webrtc:peer-joined', {
        callId,
        userId: socket.user.id,
        name: `${socket.user.first_name} ${socket.user.last_name}`.trim(),
      })
    })

    socket.on('call:leave-room', ({ callId }) => {
      if (!callId) return
      socket.leave(`call:${callId}`)
      socket.to(`call:${callId}`).emit('webrtc:peer-left', {
        callId,
        userId: socket.user.id,
      })
    })

    socket.on('webrtc:signal', ({ callId, toUserId, signal }) => {
      if (!callId || !signal) return

      const payload = {
        callId,
        fromUserId: socket.user.id,
        signal,
      }

      if (toUserId) {
        io.to(`user:${toUserId}`).emit('webrtc:signal', payload)
        return
      }

      socket.to(`call:${callId}`).emit('webrtc:signal', payload)
    })
  })

  app.set('io', io)
  return io
}

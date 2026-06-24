import { Server } from 'socket.io'
import { verifyToken } from './middleware/auth.js'
import { User, StudyGroup, GroupMember } from './db/models.js'
import { config } from './config.js'

export function initSocket(httpServer, app) {
  const io = new Server(httpServer, {
    cors: {
      origin: config.corsOrigin,
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

      if (!membership && socket.user.role !== 'instructor') return

      socket.join(`workspace:${groupId}`)
    })

    socket.on('leave:workspace', ({ groupId }) => {
      if (groupId) {
        socket.leave(`workspace:${groupId}`)
      }
    })
  })

  app.set('io', io)
  return io
}

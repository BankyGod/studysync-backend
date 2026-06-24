import { Router } from 'express'
import workspaceCore from './workspace/core.js'
import workspaceTasks from './workspace/tasks.js'
import workspaceMessages from './workspace/messages.js'
import workspaceFiles from './workspace/files.js'
import workspaceSessions from './workspace/sessions.js'

const router = Router()

router.use('/:groupId', workspaceCore)
router.use('/:groupId/tasks', workspaceTasks)
router.use('/:groupId/messages', workspaceMessages)
router.use('/:groupId/files', workspaceFiles)
router.use('/:groupId/sessions', workspaceSessions)

export default router

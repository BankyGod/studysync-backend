import path from 'path'
import fs from 'fs'
import { Router } from 'express'
import multer from 'multer'
import { v4 as uuid } from 'uuid'
import { Message, StoredFile } from '../../db/models.js'
import { config } from '../../config.js'
import { authRequired, requireGroupMember } from '../../middleware/auth.js'
import { forbidden, notFound, validationError } from '../../utils/errors.js'

const router = Router({ mergeParams: true })

const MAX_CHAT_FILE = 10 * 1024 * 1024
const MAX_VOICE_FILE = 2 * 1024 * 1024
const MAX_VOICE_DURATION = 120

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(config.uploadsDir, req.group.slug, 'chat')
      fs.mkdirSync(dir, { recursive: true })
      cb(null, dir)
    },
    filename: (req, file, cb) => {
      cb(null, `${uuid()}${path.extname(file.originalname)}`)
    },
  }),
  limits: { fileSize: MAX_CHAT_FILE },
})

router.use(authRequired, requireGroupMember)

function formatMessage(row, groupSlug) {
  const message = {
    id: row.id,
    senderId: row.sender_id,
    type: row.type,
    content: row.content,
    sentAt: row.sent_at,
  }

  if (row.type === 'attachment' && row.file_id) {
    message.attachment = {
      fileName: row.file_name,
      fileSize: row.file_size,
      fileType: row.file_type,
      downloadUrl: `/api/workspaces/${groupSlug}/files/${row.file_id}/download`,
    }
  }

  if (row.type === 'voice' && row.file_id) {
    message.voice = {
      durationSec: row.voice_duration_sec,
      mimeType: row.file_type,
      fileName: row.file_name,
      fileSize: row.file_size,
      streamUrl: `/api/workspaces/${groupSlug}/messages/${row.id}/voice`,
    }
  }

  return message
}

async function fetchMessageRow(messageId) {
  const message = await Message.findOne({ id: messageId }).lean()
  if (!message?.file_id) return message

  const file = await StoredFile.findOne({ id: message.file_id }).lean()
  return {
    ...message,
    file_name: file?.file_name,
    file_size: file?.file_size,
    file_type: file?.file_type,
  }
}

router.get('/', async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 100)

    const messages = await Message.find({ group_id: req.group.id })
      .sort({ sent_at: 1 })
      .limit(limit)
      .lean()

    const fileIds = messages.map((m) => m.file_id).filter(Boolean)
    const files = fileIds.length ? await StoredFile.find({ id: { $in: fileIds } }).lean() : []
    const fileById = Object.fromEntries(files.map((f) => [f.id, f]))

    const rows = messages.map((m) => {
      const file = m.file_id ? fileById[m.file_id] : null
      return {
        ...m,
        file_name: file?.file_name,
        file_size: file?.file_size,
        file_type: file?.file_type,
      }
    })

    res.json({ messages: rows.map((r) => formatMessage(r, req.group.slug)) })
  } catch (error) {
    next(error)
  }
})

router.post('/', upload.single('file'), async (req, res, next) => {
  try {
    const type = req.body.type || 'text'
    const now = new Date().toISOString()
    const messageId = uuid()

    if (type === 'text') {
      const content = req.body.content?.trim()
      if (!content) {
        throw validationError('Message content is required')
      }

      await Message.create({
        id: messageId,
        group_id: req.group.id,
        sender_id: req.user.id,
        type: 'text',
        content,
        sent_at: now,
      })
    } else if (type === 'attachment') {
      if (!req.file) {
        throw validationError('File is required for attachment messages')
      }

      const fileId = uuid()
      await StoredFile.create({
        id: fileId,
        group_id: req.group.id,
        uploaded_by_id: req.user.id,
        file_name: req.file.originalname,
        file_size: req.file.size,
        file_type: req.file.mimetype,
        storage_key: req.file.path,
        purpose: 'chat_attachment',
        uploaded_at: now,
      })

      await Message.create({
        id: messageId,
        group_id: req.group.id,
        sender_id: req.user.id,
        type: 'attachment',
        content: `Shared a file: ${req.file.originalname}`,
        file_id: fileId,
        sent_at: now,
      })
    } else if (type === 'voice') {
      if (!req.file) {
        throw validationError('Voice file is required')
      }
      if (req.file.size > MAX_VOICE_FILE) {
        throw validationError('Voice file too large (max 2MB)')
      }

      const durationSec = Number(req.body.durationSec) || 0
      if (durationSec > MAX_VOICE_DURATION) {
        throw validationError(`Voice notes can be up to ${MAX_VOICE_DURATION} seconds`)
      }

      const fileId = uuid()
      await StoredFile.create({
        id: fileId,
        group_id: req.group.id,
        uploaded_by_id: req.user.id,
        file_name: req.file.originalname,
        file_size: req.file.size,
        file_type: req.file.mimetype,
        storage_key: req.file.path,
        purpose: 'voice',
        uploaded_at: now,
      })

      await Message.create({
        id: messageId,
        group_id: req.group.id,
        sender_id: req.user.id,
        type: 'voice',
        content: 'Sent a voice message',
        file_id: fileId,
        voice_duration_sec: durationSec,
        sent_at: now,
      })
    } else {
      throw validationError('Invalid message type')
    }

    const row = await fetchMessageRow(messageId)
    const message = formatMessage(row, req.group.slug)
    const io = req.app.get('io')
    io?.to(`workspace:${req.group.slug}`).emit('message:new', { groupId: req.group.slug, message })

    res.status(201).json(message)
  } catch (error) {
    next(error)
  }
})

router.get('/:messageId/attachment', async (req, res, next) => {
  try {
    await serveMessageFile(req, res, 'attachment')
  } catch (error) {
    next(error)
  }
})

router.get('/:messageId/voice', async (req, res, next) => {
  try {
    await serveMessageFile(req, res, 'voice')
  } catch (error) {
    next(error)
  }
})

async function serveMessageFile(req, res, expectedType) {
  const message = await Message.findOne({ id: req.params.messageId, group_id: req.group.id }).lean()

  if (!message || message.type !== expectedType || !message.file_id) {
    throw notFound('File not found')
  }

  const file = await StoredFile.findOne({ id: message.file_id }).lean()
  if (!file || !fs.existsSync(file.storage_key)) {
    throw notFound('File not found')
  }

  res.setHeader('Content-Type', file.file_type)
  res.setHeader('Content-Disposition', `inline; filename="${file.file_name}"`)
  fs.createReadStream(file.storage_key).pipe(res)
}

router.delete('/:messageId', async (req, res, next) => {
  try {
    const message = await Message.findOne({ id: req.params.messageId, group_id: req.group.id }).lean()

    if (!message) {
      throw notFound('Message not found')
    }

    if (message.sender_id !== req.user.id) {
      throw forbidden('You can only delete your own messages')
    }

    if (message.file_id) {
      const file = await StoredFile.findOne({ id: message.file_id }).lean()
      if (file && fs.existsSync(file.storage_key)) {
        fs.unlinkSync(file.storage_key)
      }
      await StoredFile.deleteOne({ id: message.file_id })
    }

    await Message.deleteOne({ id: req.params.messageId })
    res.status(204).send()
  } catch (error) {
    next(error)
  }
})

export default router

import path from 'path'
import fs from 'fs'
import { Router } from 'express'
import multer from 'multer'
import mongoose from 'mongoose'
import { v4 as uuid } from 'uuid'
import { Message, StoredFile } from '../../db/models.js'
import { config } from '../../config.js'
import { authRequired, requireGroupMember } from '../../middleware/auth.js'
import { createUploadRateLimiter } from '../../middleware/uploadRateLimit.js'
import { forbidden, notFound, validationError } from '../../utils/errors.js'
import {
  MAX_VOICE_DURATION_SEC,
  buildSharedStoragePath,
  buildVoiceStoragePath,
  contentDisposition,
  downloadUrl,
  formatFileEntry,
  isListableSharedFile,
  newFileId,
  sanitizeFileName,
  sharedStorageDir,
  validateSharedUpload,
  validateVoiceUpload,
  voiceStorageDir,
} from '../../services/workspaceFileService.js'

const router = Router({ mergeParams: true })
const uploadRateLimit = createUploadRateLimiter({ maxUploads: 20 })

function resolveMessageType(req, file) {
  const explicit = String(req.query.type || req.body?.type || '').toLowerCase()
  if (explicit === 'voice' || explicit === 'attachment' || explicit === 'text') {
    return explicit
  }
  if (file) {
    const mime = String(file.mimetype || '').toLowerCase()
    if (mime.startsWith('audio/')) {
      return 'voice'
    }
    return 'attachment'
  }
  return 'text'
}

function createMessageUpload() {
  return multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => {
        const type = resolveMessageType(req, file)
        const dir =
          type === 'voice'
            ? voiceStorageDir(config.uploadsDir, req.group.slug)
            : sharedStorageDir(config.uploadsDir, req.group.slug)
        fs.mkdirSync(dir, { recursive: true })
        cb(null, dir)
      },
      filename: (req, file, cb) => {
        const type = resolveMessageType(req, file)
        if (type === 'voice') {
          const messageId = req.pendingMessageId ?? uuid()
          req.pendingMessageId = messageId
          cb(
            null,
            path.basename(
              buildVoiceStoragePath(config.uploadsDir, req.group.slug, messageId, file.originalname),
            ),
          )
          return
        }

        const fileId = req.pendingUploadFileId ?? newFileId()
        req.pendingUploadFileId = fileId
        cb(
          null,
          path.basename(
            buildSharedStoragePath(config.uploadsDir, req.group.slug, fileId, file.originalname),
          ),
        )
      },
    }),
    limits: { fileSize: 10 * 1024 * 1024 },
  })
}

const messageUpload = createMessageUpload()

function parseMessageUpload(req, res, next) {
  if (!req.is('multipart/form-data')) {
    return next()
  }

  return messageUpload.single('file')(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return next(
          validationError(
            resolveMessageType(req, req.file) === 'voice'
              ? 'Voice file too large (max 2MB)'
              : 'File too large (max 10MB)',
          ),
        )
      }
      return next(validationError(err.message))
    }
    if (err) {
      return next(err)
    }
    return next()
  })
}

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
    const attachment = {
      fileName: row.file_name,
      fileSize: row.file_size,
      fileType: row.file_type,
      downloadUrl: downloadUrl(groupSlug, row.file_id),
    }
    if (row.file_missing) {
      attachment.deleted = true
    }
    message.attachment = attachment
  }

  if (row.type === 'voice') {
    message.voice = {
      durationSec: row.voice_duration_sec,
      mimeType: row.voice_file_type ?? row.file_type,
      fileName: row.voice_file_name ?? row.file_name ?? 'voice.webm',
      fileSize: row.voice_file_size ?? row.file_size,
      streamUrl: `/api/workspaces/${groupSlug}/messages/${row.id}/voice`,
    }
  }

  return message
}

async function enrichMessageRows(messages) {
  const fileIds = messages.filter((m) => m.type === 'attachment' && m.file_id).map((m) => m.file_id)
  const files = fileIds.length ? await StoredFile.find({ id: { $in: fileIds } }).lean() : []
  const fileById = Object.fromEntries(files.map((file) => [file.id, file]))

  return messages.map((message) => {
    if (message.type !== 'attachment' || !message.file_id) {
      if (message.type === 'voice' && message.voice_storage_key) {
        return {
          ...message,
          voice_file_name: message.voice_file_name,
          voice_file_type: message.voice_file_type,
          voice_file_size: message.voice_file_size,
        }
      }

      if (message.type === 'voice' && message.file_id) {
        const legacyVoice = fileById[message.file_id]
        return {
          ...message,
          file_name: legacyVoice?.file_name,
          file_size: legacyVoice?.file_size,
          file_type: legacyVoice?.file_type,
        }
      }

      return message
    }

    const file = fileById[message.file_id]
    return {
      ...message,
      file_name: file?.file_name,
      file_size: file?.file_size,
      file_type: file?.file_type,
      file_missing: !file || !isListableSharedFile(file),
    }
  })
}

async function fetchMessageRow(messageId) {
  const message = await Message.findOne({ id: messageId }).lean()
  if (!message) return null
  const [enriched] = await enrichMessageRows([message])
  return enriched
}

router.get('/', async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 100)

    const messages = await Message.find({ group_id: req.group.id })
      .sort({ sent_at: 1 })
      .limit(limit)
      .lean()

    const rows = await enrichMessageRows(messages)
    res.json({ messages: rows.map((row) => formatMessage(row, req.group.slug)) })
  } catch (error) {
    next(error)
  }
})

router.post('/', uploadRateLimit, parseMessageUpload, async (req, res, next) => {
  const session = await mongoose.startSession()
  let uploadedPath = req.file?.path ?? null

  try {
    const type = resolveMessageType(req, req.file)
    const now = new Date().toISOString()
    const messageId = req.pendingMessageId ?? uuid()

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
      const validationErrorMessage = validateSharedUpload(req.file)
      if (validationErrorMessage) {
        throw validationError(validationErrorMessage)
      }

      const fileId = req.pendingUploadFileId ?? newFileId()
      const safeName = sanitizeFileName(req.file.originalname)
      const content = `Shared a file: ${safeName}`

      session.startTransaction()

      await StoredFile.create(
        [
          {
            id: fileId,
            group_id: req.group.id,
            uploaded_by_id: req.user.id,
            file_name: safeName,
            file_size: req.file.size,
            file_type: req.file.mimetype,
            storage_key: req.file.path,
            source: 'chat',
            purpose: 'chat_attachment',
            uploaded_at: now,
          },
        ],
        { session },
      )

      await Message.create(
        [
          {
            id: messageId,
            group_id: req.group.id,
            sender_id: req.user.id,
            type: 'attachment',
            content,
            file_id: fileId,
            sent_at: now,
          },
        ],
        { session },
      )

      await session.commitTransaction()

      const fileEntry = formatFileEntry(
        {
          id: fileId,
          file_name: safeName,
          file_size: req.file.size,
          file_type: req.file.mimetype,
          uploaded_by_id: req.user.id,
          uploaded_at: now,
          source: 'chat',
          purpose: 'chat_attachment',
        },
        req.group.slug,
        `${req.user.first_name} ${req.user.last_name}`.trim(),
      )

      const row = await fetchMessageRow(messageId)
      const message = formatMessage(row, req.group.slug)
      const io = req.app.get('io')
      io?.to(`workspace:${req.group.slug}`).emit('message:new', { groupId: req.group.slug, message })
      io?.to(`workspace:${req.group.slug}`).emit('file:new', { groupId: req.group.slug, file: fileEntry })

      return res.status(201).json(message)
    } else if (type === 'voice') {
      const validationErrorMessage = validateVoiceUpload(req.file)
      if (validationErrorMessage) {
        throw validationError(validationErrorMessage)
      }

      const durationSec = Number(req.body.durationSec ?? req.body.duration_sec ?? req.body.duration) || 0
      if (durationSec > MAX_VOICE_DURATION_SEC) {
        throw validationError(`Voice notes can be up to ${MAX_VOICE_DURATION_SEC} seconds`)
      }

      const safeName = sanitizeFileName(req.file.originalname)

      await Message.create({
        id: messageId,
        group_id: req.group.id,
        sender_id: req.user.id,
        type: 'voice',
        content: 'Sent a voice message',
        voice_duration_sec: durationSec,
        voice_storage_key: req.file.path,
        voice_file_name: safeName,
        voice_file_type: req.file.mimetype?.split(';')[0]?.trim() || req.file.mimetype,
        voice_file_size: req.file.size,
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
    if (session.inTransaction()) {
      await session.abortTransaction()
    }
    if (uploadedPath && fs.existsSync(uploadedPath)) {
      fs.unlinkSync(uploadedPath)
    }
    next(error)
  } finally {
    session.endSession()
  }
})

router.get('/:messageId/voice', async (req, res, next) => {
  try {
    const message = await Message.findOne({ id: req.params.messageId, group_id: req.group.id }).lean()

    if (!message || message.type !== 'voice') {
      throw notFound('Voice message not found')
    }

    if (message.voice_storage_key && fs.existsSync(message.voice_storage_key)) {
      res.setHeader('Content-Type', message.voice_file_type || 'audio/webm')
      res.setHeader('Content-Disposition', contentDisposition(message.voice_file_name || 'voice.webm', true))
      fs.createReadStream(message.voice_storage_key).pipe(res)
      return
    }

    if (message.file_id) {
      const file = await StoredFile.findOne({ id: message.file_id, purpose: 'voice' }).lean()
      if (file && fs.existsSync(file.storage_key)) {
        res.setHeader('Content-Type', file.file_type)
        res.setHeader('Content-Disposition', contentDisposition(file.file_name, true))
        fs.createReadStream(file.storage_key).pipe(res)
        return
      }
    }

    throw notFound('Voice message not found')
  } catch (error) {
    next(error)
  }
})

router.delete('/:messageId', async (req, res, next) => {
  try {
    const message = await Message.findOne({ id: req.params.messageId, group_id: req.group.id }).lean()

    if (!message) {
      throw notFound('Message not found')
    }

    if (message.sender_id !== req.user.id) {
      throw forbidden('You can only delete your own messages')
    }

    if (message.type === 'voice') {
      if (message.voice_storage_key && fs.existsSync(message.voice_storage_key)) {
        fs.unlinkSync(message.voice_storage_key)
      } else if (message.file_id) {
        const file = await StoredFile.findOne({ id: message.file_id, purpose: 'voice' }).lean()
        if (file?.storage_key && fs.existsSync(file.storage_key)) {
          fs.unlinkSync(file.storage_key)
        }
        await StoredFile.deleteOne({ id: message.file_id })
      }
    }

    await Message.deleteOne({ id: req.params.messageId })
    res.status(204).send()
  } catch (error) {
    next(error)
  }
})

export default router

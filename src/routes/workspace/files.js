import path from 'path'
import fs from 'fs'
import { Router } from 'express'
import multer from 'multer'
import mongoose from 'mongoose'
import { v4 as uuid } from 'uuid'
import { StoredFile, User } from '../../db/models.js'
import { config } from '../../config.js'
import { authRequired, requireGroupMember } from '../../middleware/auth.js'
import { createUploadRateLimiter } from '../../middleware/uploadRateLimit.js'
import { forbidden, notFound, validationError } from '../../utils/errors.js'
import {
  buildSharedStoragePath,
  contentDisposition,
  formatFileEntry,
  isListableSharedFile,
  newFileId,
  sanitizeFileName,
  sharedStorageDir,
  validateSharedUpload,
} from '../../services/workspaceFileService.js'

const router = Router({ mergeParams: true })
const uploadRateLimit = createUploadRateLimiter({ maxUploads: 20 })

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      cb(null, sharedStorageDir(config.uploadsDir, req.group.slug))
    },
    filename: (req, file, cb) => {
      const fileId = newFileId()
      req.pendingUploadFileId = fileId
      cb(null, path.basename(buildSharedStoragePath(config.uploadsDir, req.group.slug, fileId, file.originalname)))
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
})

router.use(authRequired, requireGroupMember)

async function listGroupFiles(groupId, groupSlug) {
  const rows = await StoredFile.find({ group_id: groupId }).sort({ uploaded_at: -1 }).lean()
  const listable = rows.filter(isListableSharedFile)

  const uploaderIds = [...new Set(listable.map((row) => row.uploaded_by_id))]
  const users = uploaderIds.length ? await User.find({ id: { $in: uploaderIds } }).lean() : []
  const userById = Object.fromEntries(users.map((user) => [user.id, user]))

  return listable.map((row) => {
    const uploader = userById[row.uploaded_by_id]
    const uploaderName = uploader ? `${uploader.first_name} ${uploader.last_name}`.trim() : ''
    return formatFileEntry(row, groupSlug, uploaderName)
  })
}

router.get('/', async (req, res, next) => {
  try {
    const files = await listGroupFiles(req.group.id, req.group.slug)
    res.json({ files })
  } catch (error) {
    next(error)
  }
})

router.post('/', uploadRateLimit, upload.single('file'), async (req, res, next) => {
  try {
    const validationErrorMessage = validateSharedUpload(req.file)
    if (validationErrorMessage) {
      if (req.file?.path && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path)
      }
      throw validationError(validationErrorMessage)
    }

    const fileId = req.pendingUploadFileId ?? newFileId()
    const safeName = sanitizeFileName(req.file.originalname)
    const now = new Date().toISOString()

    await StoredFile.create({
      id: fileId,
      group_id: req.group.id,
      uploaded_by_id: req.user.id,
      file_name: safeName,
      file_size: req.file.size,
      file_type: req.file.mimetype,
      storage_key: req.file.path,
      source: 'files',
      purpose: 'shared',
      uploaded_at: now,
    })

    const entry = formatFileEntry(
      {
        id: fileId,
        file_name: safeName,
        file_size: req.file.size,
        file_type: req.file.mimetype,
        uploaded_by_id: req.user.id,
        uploaded_at: now,
        source: 'files',
        purpose: 'shared',
      },
      req.group.slug,
      `${req.user.first_name} ${req.user.last_name}`.trim(),
    )

    const io = req.app.get('io')
    io?.to(`workspace:${req.group.slug}`).emit('file:new', { groupId: req.group.slug, file: entry })
    io?.to(`workspace:${req.group.slug}`).emit('file:uploaded', { groupId: req.group.slug, file: entry })

    res.status(201).json(entry)
  } catch (error) {
    if (req.file?.path && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path)
    }
    next(error)
  }
})

router.get('/:fileId/download', async (req, res, next) => {
  try {
    const file = await StoredFile.findOne({
      id: req.params.fileId,
      group_id: req.group.id,
    }).lean()

    if (!file || !isListableSharedFile(file) || !fs.existsSync(file.storage_key)) {
      throw notFound('File not found')
    }

    res.setHeader('Content-Type', file.file_type)
    res.setHeader('Content-Disposition', contentDisposition(file.file_name))
    fs.createReadStream(file.storage_key).pipe(res)
  } catch (error) {
    next(error)
  }
})

router.delete('/:fileId', async (req, res, next) => {
  try {
    const file = await StoredFile.findOne({
      id: req.params.fileId,
      group_id: req.group.id,
    }).lean()

    if (!file || !isListableSharedFile(file)) {
      throw notFound('File not found')
    }

    if (file.uploaded_by_id !== req.user.id) {
      throw forbidden('You can only delete files you uploaded')
    }

    if (fs.existsSync(file.storage_key)) {
      fs.unlinkSync(file.storage_key)
    }

    await StoredFile.deleteOne({ id: file.id })

    const io = req.app.get('io')
    io?.to(`workspace:${req.group.slug}`).emit('file:deleted', {
      groupId: req.group.slug,
      fileId: file.id,
    })

    res.status(204).send()
  } catch (error) {
    next(error)
  }
})

export default router

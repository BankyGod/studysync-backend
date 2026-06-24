import path from 'path'
import fs from 'fs'
import { Router } from 'express'
import multer from 'multer'
import { v4 as uuid } from 'uuid'
import { StoredFile, User } from '../../db/models.js'
import { config } from '../../config.js'
import { authRequired, requireGroupMember } from '../../middleware/auth.js'
import { forbidden, notFound, validationError } from '../../utils/errors.js'

const router = Router({ mergeParams: true })
const MAX_FILE_SIZE = 10 * 1024 * 1024

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(config.uploadsDir, req.group.slug, 'files')
      fs.mkdirSync(dir, { recursive: true })
      cb(null, dir)
    },
    filename: (req, file, cb) => {
      cb(null, `${uuid()}${path.extname(file.originalname)}`)
    },
  }),
  limits: { fileSize: MAX_FILE_SIZE },
})

router.use(authRequired, requireGroupMember)

router.get('/', async (req, res, next) => {
  try {
    const rows = await StoredFile.find({ group_id: req.group.id, purpose: 'shared' })
      .sort({ uploaded_at: -1 })
      .lean()

    const uploaderIds = [...new Set(rows.map((r) => r.uploaded_by_id))]
    const users = await User.find({ id: { $in: uploaderIds } }).lean()
    const userById = Object.fromEntries(users.map((u) => [u.id, u]))

    res.json({
      files: rows.map((row) => {
        const uploader = userById[row.uploaded_by_id]
        return {
          id: row.id,
          fileName: row.file_name,
          fileSize: row.file_size,
          fileType: row.file_type,
          uploadedBy: uploader ? `${uploader.first_name} ${uploader.last_name}`.trim() : '',
          uploadedById: row.uploaded_by_id,
          uploadedAt: row.uploaded_at,
          downloadUrl: `/api/workspaces/${req.group.slug}/files/${row.id}/download`,
        }
      }),
    })
  } catch (error) {
    next(error)
  }
})

router.post('/', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) {
      throw validationError('File is required')
    }

    const fileId = uuid()
    const now = new Date().toISOString()

    await StoredFile.create({
      id: fileId,
      group_id: req.group.id,
      uploaded_by_id: req.user.id,
      file_name: req.file.originalname,
      file_size: req.file.size,
      file_type: req.file.mimetype,
      storage_key: req.file.path,
      purpose: 'shared',
      uploaded_at: now,
    })

    const entry = {
      id: fileId,
      fileName: req.file.originalname,
      fileSize: req.file.size,
      fileType: req.file.mimetype,
      uploadedBy: `${req.user.first_name} ${req.user.last_name}`.trim(),
      uploadedById: req.user.id,
      uploadedAt: now,
      downloadUrl: `/api/workspaces/${req.group.slug}/files/${fileId}/download`,
    }

    const io = req.app.get('io')
    io?.to(`workspace:${req.group.slug}`).emit('file:uploaded', { groupId: req.group.slug, file: entry })

    res.status(201).json(entry)
  } catch (error) {
    next(error)
  }
})

router.get('/:fileId/download', async (req, res, next) => {
  try {
    const file = await StoredFile.findOne({
      id: req.params.fileId,
      group_id: req.group.id,
      purpose: 'shared',
    }).lean()

    if (!file || !fs.existsSync(file.storage_key)) {
      throw notFound('File not found')
    }

    res.setHeader('Content-Type', file.file_type)
    res.setHeader('Content-Disposition', `attachment; filename="${file.file_name}"`)
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
      purpose: 'shared',
    }).lean()

    if (!file) {
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

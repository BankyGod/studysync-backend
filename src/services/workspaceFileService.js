import path from 'path'
import fs from 'fs'
import { v4 as uuid } from 'uuid'

export const MAX_SHARED_FILE_SIZE = 10 * 1024 * 1024
export const MAX_VOICE_FILE_SIZE = 2 * 1024 * 1024
export const MAX_VOICE_DURATION_SEC = 120

const ALLOWED_SHARED_EXTENSIONS = new Set([
  '.pdf',
  '.txt',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.webp',
  '.heic',
  '.heif',
  '.bmp',
])

const ALLOWED_SHARED_MIME_TYPES = new Set([
  'application/pdf',
  'text/plain',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/heic',
  'image/heif',
  'image/bmp',
])

const ALLOWED_VOICE_MIME_TYPES = new Set([
  'audio/webm',
  'audio/ogg',
  'audio/mpeg',
  'audio/mp4',
  'audio/mp3',
  'audio/wav',
  'audio/x-wav',
  'audio/x-m4a',
  'audio/aac',
])

export function sanitizeFileName(fileName) {
  const base = path.basename(String(fileName || 'file'))
    .replace(/[^\w.\- ()]/g, '_')
    .replace(/_+/g, '_')
    .trim()
  return base.slice(0, 200) || 'file'
}

export function podFilesDir(uploadsDir, groupSlug) {
  return path.join(uploadsDir, groupSlug, 'files')
}

/** @deprecated use podFilesDir */
export function sharedStorageDir(uploadsDir, groupSlug) {
  return podFilesDir(uploadsDir, groupSlug)
}

export function voiceStorageDir(uploadsDir, groupSlug) {
  return path.join(uploadsDir, groupSlug, 'voice')
}

export function extensionFromMime(mimetype) {
  const mime = normalizeMimeType(mimetype)
  const map = {
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/heic': '.heic',
    'image/heif': '.heif',
    'image/bmp': '.bmp',
    'application/pdf': '.pdf',
    'text/plain': '.txt',
  }
  return map[mime] ?? ''
}

export function buildSharedStoragePath(uploadsDir, groupSlug, fileId, originalName, mimetype) {
  let ext = path.extname(originalName).toLowerCase()
  if (!ext || !ALLOWED_SHARED_EXTENSIONS.has(ext)) {
    const fromMime = extensionFromMime(mimetype)
    ext = ALLOWED_SHARED_EXTENSIONS.has(fromMime) ? fromMime : ''
  }
  const dir = podFilesDir(uploadsDir, groupSlug)
  fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, `${fileId}${ext}`)
}

export function buildVoiceStoragePath(uploadsDir, groupSlug, messageId, originalName) {
  const ext = path.extname(originalName).toLowerCase() || '.webm'
  const dir = voiceStorageDir(uploadsDir, groupSlug)
  fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, `${messageId}${ext}`)
}

export function validateSharedUpload(file) {
  if (!file) {
    return 'File is required'
  }
  if (file.size > MAX_SHARED_FILE_SIZE) {
    return 'File too large (max 10MB)'
  }

  const ext = path.extname(file.originalname).toLowerCase()
  const mime = normalizeMimeType(file.mimetype)
  const mimeAllowed =
    ALLOWED_SHARED_MIME_TYPES.has(mime) || mime.startsWith('image/') || mime === 'application/octet-stream'
  const extAllowed = ALLOWED_SHARED_EXTENSIONS.has(ext)

  if (!mimeAllowed && !extAllowed) {
    return 'File type not allowed'
  }

  return null
}

export function normalizeMimeType(mimetype) {
  return String(mimetype || '')
    .split(';')[0]
    .trim()
    .toLowerCase()
}

export function validateVoiceUpload(file) {
  if (!file) {
    return 'Voice file is required'
  }
  if (file.size > MAX_VOICE_FILE_SIZE) {
    return 'Voice file too large (max 2MB)'
  }

  const mime = normalizeMimeType(file.mimetype)
  const ext = path.extname(file.originalname).toLowerCase()
  const voiceExtensions = new Set(['.webm', '.ogg', '.m4a', '.mp4', '.wav', '.mpeg', '.mp3'])

  if (ALLOWED_VOICE_MIME_TYPES.has(mime) || mime.startsWith('audio/')) {
    return null
  }
  if (voiceExtensions.has(ext)) {
    return null
  }

  return 'Invalid voice file type'
}

export function normalizeFileSource(row) {
  if (row.source) return row.source
  if (row.purpose === 'chat_attachment') return 'chat'
  if (row.purpose === 'shared') return 'files'
  return null
}

export function isListableSharedFile(row) {
  const source = normalizeFileSource(row)
  if (source === 'chat' || source === 'files') return true
  // Legacy rows saved before source field existed
  return row.purpose === 'shared' || row.purpose === 'chat_attachment'
}

export function downloadUrl(groupSlug, fileId) {
  return `/api/workspaces/${groupSlug}/files/${fileId}/download`
}

export function formatFileEntry(row, groupSlug, uploaderName) {
  return {
    id: row.id,
    fileName: row.file_name,
    fileSize: row.file_size,
    fileType: row.file_type,
    uploadedBy: uploaderName,
    uploadedById: row.uploaded_by_id,
    uploadedAt: row.uploaded_at,
    source: normalizeFileSource(row),
    downloadUrl: downloadUrl(groupSlug, row.id),
  }
}

export function contentDisposition(fileName, inline = false) {
  const safeName = sanitizeFileName(fileName)
  const type = inline ? 'inline' : 'attachment'
  return `${type}; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(safeName)}`
}

export function newFileId() {
  return uuid()
}

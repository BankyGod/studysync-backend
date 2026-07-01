import crypto from 'crypto'
import fs from 'fs'
import { UserProfile } from '../db/models.js'
import { config } from '../config.js'

const AVATAR_URL_TTL_SEC = 30 * 24 * 60 * 60

const ALLOWED_AVATAR_MIME_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/heic',
  'image/heif',
])

const AVATAR_PROFILE_FIELDS =
  'avatar_mime_type avatar_storage_key avatar_byte_length avatar_data user_id'

export function normalizeAvatarMimeType(mimetype) {
  return String(mimetype || '')
    .split(';')[0]
    .trim()
    .toLowerCase()
}

export function isAllowedAvatarMimeType(mimetype) {
  const normalized = normalizeAvatarMimeType(mimetype)
  return ALLOWED_AVATAR_MIME_TYPES.has(normalized) || normalized.startsWith('image/')
}

export function hasAvatar(profile) {
  if (!profile) return false
  if ((profile.avatar_byte_length ?? 0) > 0) return true
  if (profile.avatar_data?.length > 0) return true
  return Boolean(profile.avatar_storage_key && fs.existsSync(profile.avatar_storage_key))
}

function avatarSig(userId, exp) {
  return crypto.createHmac('sha256', config.jwtSecret).update(`${userId}:${exp}`).digest('hex')
}

export function verifyAvatarSig(userId, exp, sig) {
  const expNum = Number(exp)
  if (!Number.isFinite(expNum) || expNum < Math.floor(Date.now() / 1000)) {
    return false
  }
  if (typeof sig !== 'string' || !sig) {
    return false
  }

  const expected = avatarSig(userId, expNum)
  if (sig.length !== expected.length) {
    return false
  }

  return crypto.timingSafeEqual(Buffer.from(sig, 'utf8'), Buffer.from(expected, 'utf8'))
}

export function signAvatarUrl(userId) {
  const exp = Math.floor(Date.now() / 1000) + AVATAR_URL_TTL_SEC
  const sig = avatarSig(userId, exp)
  const path = `/api/users/${userId}/avatar?exp=${exp}&sig=${sig}`
  return config.publicApiUrl ? `${config.publicApiUrl}${path}` : path
}

export function avatarUrlForUser(userId, profile) {
  if (!hasAvatar(profile)) {
    return undefined
  }
  return signAvatarUrl(userId)
}

export async function loadAvatarProfile(userId, { includeData = false } = {}) {
  const query = UserProfile.findOne({ user_id: userId })
  if (includeData) {
    return query.select(AVATAR_PROFILE_FIELDS).lean()
  }
  return query.select('avatar_mime_type avatar_storage_key avatar_byte_length user_id').lean()
}

export function readAvatarBytes(profile) {
  if (profile?.avatar_data?.length) {
    return profile.avatar_data
  }
  if (profile?.avatar_storage_key && fs.existsSync(profile.avatar_storage_key)) {
    return fs.readFileSync(profile.avatar_storage_key)
  }
  return null
}

export async function formatUserWithAvatar(user) {
  const profile = await loadAvatarProfile(user.id)
  const avatarUrl = avatarUrlForUser(user.id, profile)

  return {
    id: user.id,
    name: `${user.first_name} ${user.last_name}`.trim(),
    email: user.email,
    role: user.role,
    studentId: user.student_id,
    university: user.university,
    program: user.program,
    level: user.level,
    phone: user.phone ?? '',
    ...(avatarUrl ? { avatarUrl } : {}),
  }
}

export function formatProfileResponse(profile, user, { includeEmail = false } = {}) {
  const avatarUrl = avatarUrlForUser(profile.user_id, profile)
  const body = {
    fullName: profile.full_name,
    studentRole: profile.student_role,
    primaryUniversity: profile.primary_university,
    secondaryUniversity: profile.secondary_university ?? '',
    location: profile.location,
    updatedAt: profile.updated_at,
    ...(avatarUrl ? { avatarUrl } : {}),
  }
  if (includeEmail && user?.email) {
    body.email = user.email
  }
  return body
}

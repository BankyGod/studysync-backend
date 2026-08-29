import crypto from 'crypto'
import fs from 'fs'
import { UserProfile } from '../db/models.js'
import { config } from '../config.js'
import { pickAvatarColor } from './helpers.js'

const AVATAR_URL_TTL_SEC = 30 * 24 * 60 * 60

const ALLOWED_AVATAR_MIME_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/gif',
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
  return ALLOWED_AVATAR_MIME_TYPES.has(normalizeAvatarMimeType(mimetype))
}

export function hasAvatar(profile) {
  if (!profile) return false
  if ((profile.avatar_byte_length ?? 0) > 0) return true
  if (profile.avatar_data?.length > 0) return true
  return Boolean(profile.avatar_storage_key && fs.existsSync(profile.avatar_storage_key))
}

/** Prefer PUBLIC_API_URL, then Render's external URL — never leave relative paths in production. */
export function resolvePublicApiBase() {
  const configured = (config.publicApiUrl || '').trim().replace(/\/$/, '')
  if (configured) return configured

  const renderUrl = (process.env.RENDER_EXTERNAL_URL || '').trim().replace(/\/$/, '')
  if (renderUrl) return renderUrl

  return ''
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

/** Absolute API origin from env, or from the incoming request (Render / local). */
export function requestAbsoluteBase(req) {
  const configured = resolvePublicApiBase()
  if (configured) return configured
  if (!req) return ''

  const proto = String(req.get?.('x-forwarded-proto') || req.protocol || 'https')
    .split(',')[0]
    .trim()
  const host = String(req.get?.('x-forwarded-host') || req.get?.('host') || '')
    .split(',')[0]
    .trim()
  if (!host) return ''
  return `${proto}://${host}`.replace(/\/$/, '')
}

/**
 * Signed avatar URL for <img src>. No JWT required — signature is in the query string.
 * Prefer an absolute HTTPS URL whenever a public base is available.
 */
export function signAvatarUrl(userId, { absoluteBase } = {}) {
  const exp = Math.floor(Date.now() / 1000) + AVATAR_URL_TTL_SEC
  const sig = avatarSig(userId, exp)
  const path = `/api/users/${userId}/avatar?exp=${exp}&sig=${sig}`
  const base = String(absoluteBase || resolvePublicApiBase() || '')
    .trim()
    .replace(/\/$/, '')
  return base ? `${base}${path}` : path
}

/** Returns signed URL or null (never undefined — frontend can bind reliably). */
export function avatarUrlForUser(userId, profile, options = {}) {
  if (!hasAvatar(profile)) {
    return null
  }
  return signAvatarUrl(userId, options)
}

/** Ensure initials fallback uses a Tailwind bg-* class, never a hex color. */
export function normalizeAvatarColor(color, seed = 'user') {
  const value = String(color || '').trim()
  if (/^bg-[a-z0-9-]+$/i.test(value)) {
    return value
  }
  return pickAvatarColor(String(seed))
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

export async function formatUserWithAvatar(user, options = {}) {
  const profile = await loadAvatarProfile(user.id)
  const avatarUrl = avatarUrlForUser(user.id, profile, options)

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
    avatarUrl,
  }
}

export function formatProfileResponse(profile, user, { includeEmail = false, absoluteBase } = {}) {
  const avatarUrl = avatarUrlForUser(profile.user_id, profile, { absoluteBase })
  const body = {
    fullName: profile.full_name,
    studentRole: profile.student_role,
    primaryUniversity: profile.primary_university,
    secondaryUniversity: profile.secondary_university ?? '',
    location: profile.location,
    updatedAt: profile.updated_at,
    avatarUrl,
  }
  if (includeEmail && user?.email) {
    body.email = user.email
  }
  return body
}

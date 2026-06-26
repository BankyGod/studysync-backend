import { UserProfile } from '../db/models.js'

export function avatarUrlForUser(userId, profile) {
  if (!profile?.avatar_storage_key) return undefined
  return `/api/users/${userId}/avatar`
}

export async function formatUserWithAvatar(user) {
  const profile = await UserProfile.findOne({ user_id: user.id }).lean()
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

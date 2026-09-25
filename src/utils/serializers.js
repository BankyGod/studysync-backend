import { pickAvatarColor } from './helpers.js'
import { normalizeMemberRole } from '../services/groupLeaderService.js'
import { resolveStaffRole } from '../services/staffPermissions.js'

export function formatUser(row) {
  if (!row) return null
  const staffRole = resolveStaffRole(row)
  return {
    id: row.id,
    name: `${row.first_name} ${row.last_name}`.trim(),
    email: row.email,
    role: row.role,
    ...(staffRole ? { staffRole } : {}),
    studentId: row.student_id,
    university: row.university,
    program: row.program,
    level: row.level,
    phone: row.phone ?? '',
  }
}

export function formatMember(row) {
  const id = row.user_id ?? row.id
  const role = normalizeMemberRole(row.role ?? row.member_role)
  const member = {
    id,
    initials: row.initials,
    name: row.display_name ?? `${row.first_name ?? ''} ${row.last_name ?? ''}`.trim(),
    color: normalizeMemberColor(row.avatar_color, id),
    avatarUrl: row.avatarUrl ?? null,
    role,
    isLeader: role === 'leader',
  }
  const major = row.major ?? row.program
  if (major) member.major = major
  return member
}

function normalizeMemberColor(color, seed) {
  const value = String(color || '').trim()
  if (/^bg-[a-z0-9-]+$/i.test(value)) return value
  return pickAvatarColor(String(seed || 'user'))
}

export function formatUser(row) {
  if (!row) return null
  return {
    id: row.id,
    name: `${row.first_name} ${row.last_name}`.trim(),
    email: row.email,
    role: row.role,
    studentId: row.student_id,
    university: row.university,
    program: row.program,
    level: row.level,
    phone: row.phone ?? '',
  }
}

export function formatMember(row) {
  return {
    id: row.user_id ?? row.id,
    initials: row.initials,
    name: row.display_name ?? `${row.first_name} ${row.last_name}`.trim(),
    color: row.avatar_color,
  }
}

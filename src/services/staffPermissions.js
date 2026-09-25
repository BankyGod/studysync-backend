/** Fine-grained staff RBAC. Portal gate remains users.role (student|instructor|admin). */

export const STAFF_ROLES = [
  'super_admin',
  'cohort_manager',
  'student_officer',
  'reports_viewer',
  'instructor',
]

export const PERMISSIONS = {
  MANAGE_COHORTS: 'manage_cohorts',
  MANAGE_GROUPS: 'manage_groups',
  VIEW_STUDENTS: 'view_students',
  ASSIGN_LEADERS: 'assign_leaders',
  VIEW_REPORTS: 'view_reports',
  PRINT_REPORTS: 'print_reports',
  VIEW_TASK_PROGRESS: 'view_task_progress',
  MANAGE_STAFF: 'manage_staff',
}

const ROLE_PERMISSIONS = {
  super_admin: Object.values(PERMISSIONS),
  instructor: [
    PERMISSIONS.MANAGE_COHORTS,
    PERMISSIONS.MANAGE_GROUPS,
    PERMISSIONS.VIEW_STUDENTS,
    PERMISSIONS.ASSIGN_LEADERS,
    PERMISSIONS.VIEW_REPORTS,
    PERMISSIONS.PRINT_REPORTS,
    PERMISSIONS.VIEW_TASK_PROGRESS,
  ],
  cohort_manager: [
    PERMISSIONS.MANAGE_COHORTS,
    PERMISSIONS.MANAGE_GROUPS,
    PERMISSIONS.ASSIGN_LEADERS,
    PERMISSIONS.VIEW_REPORTS,
    PERMISSIONS.VIEW_TASK_PROGRESS,
  ],
  student_officer: [PERMISSIONS.VIEW_STUDENTS, PERMISSIONS.VIEW_REPORTS],
  reports_viewer: [
    PERMISSIONS.VIEW_REPORTS,
    PERMISSIONS.PRINT_REPORTS,
    PERMISSIONS.VIEW_TASK_PROGRESS,
  ],
}

/** Map legacy portal role → staff_role when staff_role is unset. */
export function resolveStaffRole(user) {
  if (!user) return null
  if (user.staff_role && STAFF_ROLES.includes(user.staff_role)) {
    return user.staff_role
  }
  if (user.role === 'admin') return 'super_admin'
  if (user.role === 'instructor') return 'instructor'
  return null
}

/** staffRole on register → portal role + staff_role. */
export function mapStaffRoleToAccount(staffRole) {
  const normalized = String(staffRole || '')
    .trim()
    .toLowerCase()
    .replace(/-/g, '_')

  if (!STAFF_ROLES.includes(normalized)) {
    return null
  }

  return {
    staffRole: normalized,
    role: normalized === 'super_admin' ? 'admin' : 'instructor',
  }
}

export function permissionsForUser(user) {
  const staffRole = resolveStaffRole(user)
  if (!staffRole) return new Set()
  return new Set(ROLE_PERMISSIONS[staffRole] || [])
}

export function userHasPermission(user, permission) {
  return permissionsForUser(user).has(permission)
}

export function userHasAnyPermission(user, ...perms) {
  const granted = permissionsForUser(user)
  return perms.some((p) => granted.has(p))
}

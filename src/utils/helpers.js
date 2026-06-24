export const AVATAR_COLORS = [
  'bg-sky-500',
  'bg-violet-500',
  'bg-emerald-500',
  'bg-amber-500',
  'bg-rose-500',
  'bg-indigo-500',
  'bg-cyan-500',
  'bg-orange-500',
]

export const GROUP_ACCENTS = ['blue', 'green', 'purple', 'amber']

export function courseToSlug(subject, courseNumber) {
  return `${subject} ${courseNumber}`.toLowerCase().replace(/\s+/g, '-')
}

export function buildGroupTitle(subject, courseNumber) {
  return `${subject} ${courseNumber} Study Group`
}

export function formatCourseLabel(subject, courseNumber) {
  return `${subject} ${courseNumber}`
}

export function getInitials(firstName, lastName) {
  const first = firstName?.trim()?.[0]?.toUpperCase() ?? ''
  const last = lastName?.trim()?.[0]?.toUpperCase() ?? ''
  return `${first}${last}` || '??'
}

export function pickAvatarColor(seed) {
  let hash = 0
  for (let i = 0; i < seed.length; i += 1) {
    hash = seed.charCodeAt(i) + ((hash << 5) - hash)
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length]
}

export function pickGroupAccent(seed) {
  let hash = 0
  for (let i = 0; i < seed.length; i += 1) {
    hash = seed.charCodeAt(i) + ((hash << 5) - hash)
  }
  return GROUP_ACCENTS[Math.abs(hash) % GROUP_ACCENTS.length]
}

export function groupSizeLimit(groupSize) {
  if (groupSize === 'small') return 3
  if (groupSize === 'medium') return 6
  return 12
}

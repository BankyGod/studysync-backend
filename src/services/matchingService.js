import { v4 as uuid } from 'uuid'
import {
  StudyGroup,
  GroupMember,
  OnboardingProfile,
  MatchingJob,
  User,
  UserCourse,
  UserProfile,
} from '../db/models.js'
import {
  courseToSlug,
  formatCourseLabel,
  getInitials,
  groupSizeLimit,
  pickAvatarColor,
} from '../utils/helpers.js'
import { loadProfile } from '../routes/onboarding.js'
import {
  alreadyInGroup,
  conflict,
  forbidden,
  notFound,
  openPodExists,
  validationError,
} from '../utils/errors.js'
import { computeReliabilityBatch, formatReliability } from './reliabilityService.js'
import { formatMember } from '../utils/serializers.js'
import { avatarUrlForUser } from '../utils/profileAvatar.js'

const MATCHING_STEPS = ['course', 'preferences', 'compatibility', 'searching', 'finalizing']
const STEP_PROGRESS = [20, 40, 65, 85, 100]
const MATCHING_STEP_DELAY_MS = 250
/** Default pod capacity for open-slot listing (matches groupSizeLimit('medium')). */
export const DEFAULT_POD_CAPACITY = groupSizeLimit('medium')

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function parseAvailability(value) {
  if (!value) return []
  if (Array.isArray(value)) return value
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function normalizeCourseInput(course = {}) {
  const subject = course.subject ?? course.courseSubject ?? course.course_subject
  const courseNumber =
    course.courseNumber ?? course.course_number ?? course.number ?? course.code

  return {
    subject: subject != null ? String(subject).trim() : '',
    courseNumber: courseNumber != null ? String(courseNumber).trim() : '',
  }
}

async function ensureUserCourseEnrolled(userId, subject, courseNumber) {
  const existing = await UserCourse.findOne({
    user_id: userId,
    subject,
    course_number: courseNumber,
  }).lean()

  if (existing) return

  const primaryCount = await UserCourse.countDocuments({ user_id: userId, is_primary: 1 })

  await UserCourse.create({
    id: uuid(),
    user_id: userId,
    subject,
    course_number: courseNumber,
    is_primary: primaryCount === 0 ? 1 : 0,
  })
}

function courseBaseSlug(subject, courseNumber) {
  return courseToSlug(subject, courseNumber)
}

function formatPodTitle(subject, courseNumber, podNumber) {
  return `${formatCourseLabel(subject, courseNumber)} · Pod ${podNumber}`
}

function numberedPodSlug(subject, courseNumber, podNumber) {
  return `${courseBaseSlug(subject, courseNumber)}-${podNumber}`
}

function extractPodNumber(group) {
  if (!group) return null
  const base = courseBaseSlug(group.subject, group.course_number)
  const slug = String(group.slug || '')
  if (slug === base) return 1
  const slugMatch = slug.match(new RegExp(`^${escapeRegex(base)}-(\\d+)$`, 'i'))
  if (slugMatch) return Number(slugMatch[1])
  const titleMatch = String(group.title || '').match(/Pod\s+(\d+)/i)
  if (titleMatch) return Number(titleMatch[1])
  return null
}

async function findGroupsForCourse(subject, courseNumber) {
  const base = courseBaseSlug(subject, courseNumber)
  const groups = await StudyGroup.find({
    $or: [
      {
        subject: new RegExp(`^${escapeRegex(subject.trim())}$`, 'i'),
        course_number: new RegExp(`^${escapeRegex(courseNumber.trim())}$`, 'i'),
      },
      { slug: base },
      { slug: new RegExp(`^${escapeRegex(base)}-\\d+$`, 'i') },
    ],
  }).lean()

  const byId = new Map()
  for (const g of groups) byId.set(g.id, g)
  return [...byId.values()].sort((a, b) => {
    const na = extractPodNumber(a) ?? 0
    const nb = extractPodNumber(b) ?? 0
    if (na !== nb) return na - nb
    return String(a.created_at).localeCompare(String(b.created_at))
  })
}

async function toPodSummary(group, capacity = DEFAULT_POD_CAPACITY) {
  const memberCount = await GroupMember.countDocuments({ group_id: group.id })
  const podNumber = extractPodNumber(group) ?? 1
  return {
    groupId: group.slug,
    title: group.title,
    podNumber,
    memberCount,
    maxSize: capacity,
    openSlots: Math.max(0, capacity - memberCount),
    courseLabel: formatCourseLabel(group.subject, group.course_number),
    courseCode: courseBaseSlug(group.subject, group.course_number),
  }
}

async function listPodSummariesForCourse(subject, courseNumber) {
  const groups = await findGroupsForCourse(subject, courseNumber)
  return Promise.all(groups.map((g) => toPodSummary(g)))
}

function nextPodNumber(summaries = []) {
  const numbers = summaries
    .map((g) => g.podNumber)
    .filter((n) => typeof n === 'number' && n > 0)
  if (numbers.length > 0) return Math.max(...numbers) + 1
  return summaries.length + 1
}

async function createNumberedPodRecord(subject, courseNumber, podNumber, title) {
  const now = new Date().toISOString()
  const id = uuid()
  const slug = numberedPodSlug(subject, courseNumber, podNumber)
  const podTitle = title?.trim() || formatPodTitle(subject, courseNumber, podNumber)

  try {
    await StudyGroup.create({
      id,
      slug,
      title: podTitle,
      subject,
      course_number: courseNumber,
      created_at: now,
    })
  } catch (error) {
    if (error?.code === 11000) {
      const existing = await StudyGroup.findOne({ slug }).lean()
      if (existing) return existing
    }
    throw error
  }

  return StudyGroup.findOne({ id }).lean()
}

/**
 * Explicit pod create — used by POST /matching/groups.
 * Never creates a second open pod while seats remain.
 */
export async function createCoursePod(user, { course, title, podNumber } = {}) {
  const { subject, courseNumber } = normalizeCourseInput(course)
  if (!subject || !courseNumber) {
    throw validationError('course with subject and courseNumber is required')
  }

  await assertNotInCourseGroup(user.id, subject, courseNumber)
  await ensureUserCourseEnrolled(user.id, subject, courseNumber)

  const summaries = await listPodSummariesForCourse(subject, courseNumber)
  const openGroups = summaries.filter((g) => g.openSlots > 0)
  if (openGroups.length > 0) {
    throw openPodExists(openGroups)
  }

  const assignedNumber = nextPodNumber(summaries)

  const group = await createNumberedPodRecord(subject, courseNumber, assignedNumber, title)
  await addMemberToGroup(group.id, user)

  const summary = await toPodSummary(group)
  return {
    ...summary,
    created: true,
  }
}

async function completeMatchingJob({ jobId, user, subject, courseNumber, studyPreferences, io }) {
  const size = studyPreferences.groupSize ?? 'medium'

  const summaries = await listPodSummariesForCourse(subject, courseNumber)
  const openGroups = summaries
    .filter((g) => g.openSlots > 0)
    .sort((a, b) => b.memberCount - a.memberCount)

  let group
  if (openGroups.length > 0) {
    group = await StudyGroup.findOne({
      $or: [{ slug: openGroups[0].groupId }, { id: openGroups[0].groupId }],
    }).lean()
  } else {
    const n = nextPodNumber(summaries)
    group = await createNumberedPodRecord(subject, courseNumber, n)
  }

  if (!group) {
    throw validationError('Unable to find or create a study pod')
  }

  await assertGroupHasSpace(group.id, size)
  await addMemberToGroup(group.id, user)

  const completedAt = new Date().toISOString()
  await MatchingJob.updateOne(
    { id: jobId },
    {
      status: 'completed',
      progress: 100,
      current_step: 'finalizing',
      result_group_id: group.id,
      completed_at: completedAt,
    },
  )

  const match = await buildMatchPayload(group, user.id)
  const result = { jobId, status: 'completed', progress: 100, currentStep: 'finalizing', match }

  if (io) {
    io.to(`user:${user.id}`).emit('matching:complete', { jobId, match })
  }

  return result
}

async function failMatchingJob(jobId, userId, error, io) {
  const message = error?.message || 'Matching failed'
  await MatchingJob.updateOne(
    { id: jobId },
    {
      status: 'failed',
      error_message: message,
      error_code: error?.code || 'MATCHING_FAILED',
      completed_at: new Date().toISOString(),
    },
  )

  if (io) {
    io.to(`user:${userId}`).emit('matching:failed', { jobId, message })
  }
}

export async function getGroupMembers(groupId) {
  const members = await GroupMember.find({ group_id: groupId }).lean()
  const users = await User.find({ id: { $in: members.map((m) => m.user_id) } }).lean()
  const profiles = await UserProfile.find({ user_id: { $in: members.map((m) => m.user_id) } })
    .select('user_id avatar_mime_type avatar_storage_key avatar_byte_length')
    .lean()
  const userById = Object.fromEntries(users.map((u) => [u.id, u]))
  const profileByUserId = Object.fromEntries(profiles.map((p) => [p.user_id, p]))

  return members.map((m) => {
    const u = userById[m.user_id]
    return {
      user_id: m.user_id,
      initials: m.initials,
      avatar_color: m.avatar_color,
      first_name: u?.first_name,
      last_name: u?.last_name,
      program: u?.program,
      avatarUrl: avatarUrlForUser(m.user_id, profileByUserId[m.user_id]),
    }
  })
}

export async function buildMatchPayload(group, userId) {
  const memberRows = await getGroupMembers(group.id)
  const memberIds = memberRows.map((m) => m.user_id)
  const reliabilityByUser = await computeReliabilityBatch(memberIds, group.id, group.slug)

  const members = memberRows.map((m) => {
    const member = formatMember({
      user_id: m.user_id,
      initials: m.initials,
      avatar_color: m.avatar_color,
      first_name: m.first_name,
      last_name: m.last_name,
      program: m.program,
      avatarUrl: m.avatarUrl,
    })
    member.reliability = formatReliability(reliabilityByUser[m.user_id])
    return member
  })

  const metrics = await computeMatchMetrics(userId, group.id, null)

  return {
    groupId: group.slug,
    groupTitle: group.title,
    courseLabel: formatCourseLabel(group.subject, group.course_number),
    members,
    metrics,
  }
}

async function computeMatchMetrics(userId, groupId, payloadAvailability) {
  const userProfile = await OnboardingProfile.findOne({ user_id: userId }).lean()
  const userSlots =
    payloadAvailability ?? (userProfile ? parseAvailability(userProfile.availability) : [])

  const otherMembers = await GroupMember.find({ group_id: groupId, user_id: { $ne: userId } }).lean()
  const profiles = await OnboardingProfile.find({
    user_id: { $in: otherMembers.map((m) => m.user_id) },
  }).lean()

  let bestOverlap = 0
  profiles.forEach((p) => {
    const slots = parseAvailability(p.availability)
    const overlap = slots.filter((s) => userSlots.includes(s)).length
    bestOverlap = Math.max(bestOverlap, overlap)
  })

  const scheduleMatch = userSlots.length === 0 ? 70 : Math.min(100, 60 + bestOverlap * 10)
  const learningStyleMatch = 75 + Math.floor(Math.random() * 20)
  const avgGrades = 80 + Math.floor(Math.random() * 15)

  return { scheduleMatch, learningStyleMatch, avgGrades }
}

async function countOtherEnrolledStudents(subject, courseNumber, userId) {
  return UserCourse.countDocuments({
    subject: subject.trim(),
    course_number: courseNumber.trim(),
    user_id: { $ne: userId },
  })
}

async function addMemberToGroup(groupId, user) {
  const existing = await GroupMember.findOne({ group_id: groupId, user_id: user.id }).lean()
  if (existing) return

  await GroupMember.create({
    group_id: groupId,
    user_id: user.id,
    joined_at: new Date().toISOString(),
    initials: getInitials(user.first_name, user.last_name),
    avatar_color: pickAvatarColor(user.id),
  })
}

export async function getUserGroupForCourse(userId, subject, courseNumber) {
  const memberships = await GroupMember.find({ user_id: userId }).lean()
  if (!memberships.length) return null

  const groupIds = memberships.map((m) => m.group_id)
  const group = await StudyGroup.findOne({
    id: { $in: groupIds },
    subject: subject.trim(),
    course_number: courseNumber.trim(),
  }).lean()

  if (!group) return null

  const membership = memberships.find((m) => m.group_id === group.id)
  return { group, membership }
}

export async function assertNotInCourseGroup(userId, subject, courseNumber) {
  const existing = await getUserGroupForCourse(userId, subject, courseNumber)
  if (existing) {
    throw alreadyInGroup(
      `You are already in a study group for ${formatCourseLabel(subject, courseNumber)}.`,
    )
  }
}

async function assertGroupHasSpace(groupId, groupSize = 'medium') {
  const memberCount = await GroupMember.countDocuments({ group_id: groupId })
  const limit = groupSizeLimit(groupSize)
  if (memberCount >= limit) {
    throw conflict('This study group is full', {
      memberCount,
      maxSize: limit,
      openSlots: 0,
    })
  }
}

async function assertEnrolledInCourse(userId, subject, courseNumber) {
  const enrolled = await UserCourse.findOne({
    user_id: userId,
    subject,
    course_number: courseNumber,
  }).lean()

  if (!enrolled) {
    throw forbidden('You must be enrolled in this course to join the pod')
  }
}

export async function leaveGroup(userId, groupSlug) {
  const group = await StudyGroup.findOne({
    $or: [{ slug: groupSlug }, { id: groupSlug }],
  }).lean()
  if (!group) {
    throw notFound('Study group not found')
  }

  const result = await GroupMember.deleteOne({ group_id: group.id, user_id: userId })
  if (result.deletedCount === 0) {
    throw notFound('You are not a member of this group')
  }

  return {
    groupId: group.slug,
    courseLabel: formatCourseLabel(group.subject, group.course_number),
  }
}

export async function joinGroup(user, groupSlug, studyPreferences = { groupSize: 'medium' }) {
  const group = await StudyGroup.findOne({
    $or: [{ slug: groupSlug }, { id: groupSlug }],
  }).lean()
  if (!group) {
    throw notFound('Study group not found')
  }

  await assertEnrolledInCourse(user.id, group.subject, group.course_number)

  const alreadyMember = await GroupMember.findOne({ group_id: group.id, user_id: user.id }).lean()
  if (alreadyMember) {
    return buildMatchPayload(group, user.id)
  }

  await assertNotInCourseGroup(user.id, group.subject, group.course_number)
  await assertGroupHasSpace(group.id, studyPreferences.groupSize ?? 'medium')
  await addMemberToGroup(group.id, user)

  return buildMatchPayload(group, user.id)
}

export async function runMatchingForUser(user, payload, io) {
  const profile = await loadProfile(user.id)
  const normalizedCourse = normalizeCourseInput(payload.course ?? profile?.courses?.[0])

  if (!normalizedCourse.subject || !normalizedCourse.courseNumber) {
    throw validationError('course with subject and courseNumber is required')
  }

  const subject = normalizedCourse.subject
  const courseNumber = normalizedCourse.courseNumber

  await assertNotInCourseGroup(user.id, subject, courseNumber)
  await ensureUserCourseEnrolled(user.id, subject, courseNumber)

  const studyPreferences = payload.studyPreferences ?? profile?.studyPreferences ?? { groupSize: 'medium' }
  const jobId = uuid()
  const now = new Date().toISOString()

  await MatchingJob.create({
    id: jobId,
    user_id: user.id,
    course_subject: subject,
    course_number: courseNumber,
    status: 'running',
    progress: 0,
    current_step: 'course',
    created_at: now,
  })

  const emitProgress = async (stepIndex) => {
    const progress = STEP_PROGRESS[stepIndex]
    const currentStep = MATCHING_STEPS[stepIndex]
    await MatchingJob.updateOne({ id: jobId }, { progress, current_step: currentStep })

    if (io) {
      io.to(`user:${user.id}`).emit('matching:progress', {
        jobId,
        progress,
        currentStep,
        status: 'running',
      })
    }
  }

  try {
    for (let step = 0; step < MATCHING_STEPS.length; step += 1) {
      await emitProgress(step)
      if (step < MATCHING_STEPS.length - 1) {
        await sleep(MATCHING_STEP_DELAY_MS)
      }
    }

    return await completeMatchingJob({
      jobId,
      user,
      subject,
      courseNumber,
      studyPreferences,
      io,
    })
  } catch (error) {
    await failMatchingJob(jobId, user.id, error, io)
    throw error
  }
}

export async function getMatchingJob(jobId, userId) {
  const job = await MatchingJob.findOne({ id: jobId, user_id: userId }).lean()
  if (!job) return null

  const result = {
    jobId: job.id,
    status: job.status,
    progress: job.progress,
    currentStep: job.current_step,
    match: null,
  }

  if (job.status === 'waiting') {
    result.errorCode = job.error_code || 'NO_ENROLLED_STUDENTS'
    return result
  }

  if (job.status === 'completed' && job.result_group_id) {
    const group = await StudyGroup.findOne({ id: job.result_group_id }).lean()
    if (group) {
      result.match = await buildMatchPayload(group, userId)
    }
  }

  if (job.status === 'failed') {
    result.error = job.error_message
    result.errorCode = job.error_code
  }

  return result
}

export async function listCourseGroups(courseCode) {
  const slug = decodeURIComponent(String(courseCode || ''))
    .trim()
    .toLowerCase()
  if (!slug) return []

  // Prefer resolving via an existing pod for this course code
  const slugPattern = new RegExp(`^${escapeRegex(slug)}(-\\d+)?$`, 'i')
  const seed = await StudyGroup.findOne({
    $or: [{ slug }, { slug: slugPattern }],
  }).lean()

  if (seed) {
    return listPodSummariesForCourse(seed.subject, seed.course_number)
  }

  // Parse "biology-101" / "computer-science-401" → subject + number
  const parts = slug.split('-').filter(Boolean)
  if (parts.length < 2) return []

  const courseNumber = parts[parts.length - 1]
  const candidates = await StudyGroup.find({
    course_number: new RegExp(`^${escapeRegex(courseNumber)}$`, 'i'),
  }).lean()

  const match = candidates.find((g) => courseBaseSlug(g.subject, g.course_number) === slug)
  if (match) {
    return listPodSummariesForCourse(match.subject, match.course_number)
  }

  // No pods yet — still allow empty list for a well-formed course code
  return []
}

export async function usersShareGroup(userIdA, userIdB) {
  const membershipsA = await GroupMember.find({ user_id: userIdA }).lean()
  if (!membershipsA.length) return false

  const groupIds = membershipsA.map((m) => m.group_id)
  const shared = await GroupMember.findOne({ user_id: userIdB, group_id: { $in: groupIds } }).lean()
  return Boolean(shared)
}

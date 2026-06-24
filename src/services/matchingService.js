import { v4 as uuid } from 'uuid'
import {
  StudyGroup,
  GroupMember,
  OnboardingProfile,
  MatchingJob,
  User,
} from '../db/models.js'
import {
  buildGroupTitle,
  courseToSlug,
  formatCourseLabel,
  getInitials,
  groupSizeLimit,
  pickAvatarColor,
} from '../utils/helpers.js'
import { loadProfile } from '../routes/onboarding.js'

const MATCHING_STEPS = ['course', 'preferences', 'compatibility', 'searching', 'finalizing']
const STEP_PROGRESS = [20, 40, 65, 85, 100]

export async function getGroupMembers(groupId) {
  const members = await GroupMember.find({ group_id: groupId }).lean()
  const users = await User.find({ id: { $in: members.map((m) => m.user_id) } }).lean()
  const userById = Object.fromEntries(users.map((u) => [u.id, u]))

  return members.map((m) => {
    const u = userById[m.user_id]
    return {
      user_id: m.user_id,
      initials: m.initials,
      avatar_color: m.avatar_color,
      first_name: u?.first_name,
      last_name: u?.last_name,
      program: u?.program,
    }
  })
}

export async function buildMatchPayload(group, userId) {
  const members = (await getGroupMembers(group.id)).map((m) => ({
    id: m.user_id,
    name: `${m.first_name} ${m.last_name}`.trim(),
    major: m.program,
    initials: m.initials,
    color: m.avatar_color,
  }))

  const metrics = await computeMatchMetrics(userId, group.id)

  return {
    groupId: group.slug,
    groupTitle: group.title,
    courseLabel: formatCourseLabel(group.subject, group.course_number),
    members,
    metrics,
  }
}

async function computeMatchMetrics(userId, groupId) {
  const userProfile = await OnboardingProfile.findOne({ user_id: userId }).lean()
  const userSlots = userProfile ? JSON.parse(userProfile.availability) : []

  const otherMembers = await GroupMember.find({ group_id: groupId, user_id: { $ne: userId } }).lean()
  const profiles = await OnboardingProfile.find({
    user_id: { $in: otherMembers.map((m) => m.user_id) },
  }).lean()

  let bestOverlap = 0
  profiles.forEach((p) => {
    const slots = JSON.parse(p.availability)
    const overlap = slots.filter((s) => userSlots.includes(s)).length
    bestOverlap = Math.max(bestOverlap, overlap)
  })

  const scheduleMatch = userSlots.length === 0 ? 70 : Math.min(100, 60 + bestOverlap * 10)
  const learningStyleMatch = 75 + Math.floor(Math.random() * 20)
  const avgGrades = 80 + Math.floor(Math.random() * 15)

  return { scheduleMatch, learningStyleMatch, avgGrades }
}

async function findBestGroup(subject, courseNumber, groupSize) {
  const limit = groupSizeLimit(groupSize)

  const groups = await StudyGroup.aggregate([
    { $match: { subject, course_number: courseNumber } },
    {
      $lookup: {
        from: 'group_members',
        localField: 'id',
        foreignField: 'group_id',
        as: 'members',
      },
    },
    { $addFields: { member_count: { $size: '$members' } } },
    { $match: { member_count: { $lt: limit } } },
    { $sort: { member_count: -1 } },
    { $limit: 1 },
  ])

  return groups[0] ?? null
}

async function createGroup(subject, courseNumber) {
  const existing = await StudyGroup.findOne({ slug: courseToSlug(subject, courseNumber) }).lean()
  if (existing) return existing

  const now = new Date().toISOString()
  const id = uuid()

  await StudyGroup.create({
    id,
    slug: courseToSlug(subject, courseNumber),
    title: buildGroupTitle(subject, courseNumber),
    subject,
    course_number: courseNumber,
    created_at: now,
  })

  return StudyGroup.findOne({ id }).lean()
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

export async function runMatchingForUser(user, payload, io) {
  const profile = await loadProfile(user.id)
  const course = payload.course ?? profile?.courses?.[0]

  if (!course?.subject || !course?.courseNumber) {
    throw new Error('No course available for matching')
  }

  const studyPreferences = payload.studyPreferences ?? profile?.studyPreferences ?? { groupSize: 'medium' }
  const jobId = uuid()
  const now = new Date().toISOString()

  await MatchingJob.create({
    id: jobId,
    user_id: user.id,
    course_subject: course.subject,
    course_number: course.courseNumber,
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

  return new Promise((resolve) => {
    let step = 0
    const interval = setInterval(async () => {
      await emitProgress(step)
      step += 1

      if (step >= MATCHING_STEPS.length) {
        clearInterval(interval)

        let group = await findBestGroup(course.subject, course.courseNumber, studyPreferences.groupSize)
        if (!group) {
          group = await createGroup(course.subject, course.courseNumber)
        }

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

        resolve(result)
      }
    }, 400)
  })
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

  if (job.status === 'completed' && job.result_group_id) {
    const group = await StudyGroup.findOne({ id: job.result_group_id }).lean()
    if (group) {
      result.match = await buildMatchPayload(group, userId)
    }
  }

  if (job.status === 'failed') {
    result.error = job.error_message
  }

  return result
}

export async function listCourseGroups(courseCode) {
  const group = await StudyGroup.findOne({ slug: courseCode }).lean()

  const groups = group
    ? [group]
    : await StudyGroup.find({ slug: { $regex: courseCode, $options: 'i' } }).lean()

  return Promise.all(
    groups.map(async (g) => {
      const memberCount = await GroupMember.countDocuments({ group_id: g.id })

      return {
        groupId: g.slug,
        title: g.title,
        memberCount,
        openSlots: Math.max(0, 6 - memberCount),
      }
    }),
  )
}

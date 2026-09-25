import mongoose from 'mongoose'
import { GroupMember, StudyGroup, User } from '../db/models.js'
import { forbidden, notFound, validationError } from '../utils/errors.js'

export function normalizeMemberRole(role) {
  return role === 'leader' ? 'leader' : 'member'
}

export function leaderIdFromMembers(members = []) {
  const leader = members.find((m) => normalizeMemberRole(m.role) === 'leader')
  return leader?.user_id ?? null
}

export async function getGroupLeaderId(groupId) {
  const leader = await GroupMember.findOne({ group_id: groupId, role: 'leader' }).lean()
  return leader?.user_id ?? null
}

export async function isGroupLeader(groupId, userId) {
  if (!groupId || !userId) return false
  const leader = await GroupMember.findOne({
    group_id: groupId,
    user_id: userId,
    role: 'leader',
  }).lean()
  return Boolean(leader)
}

/**
 * Promote targetUserId to leader; demote any previous leader.
 * Target must already be a group member.
 */
export async function setGroupLeader(groupId, targetUserId) {
  if (!targetUserId?.trim()) {
    throw validationError('userId is required')
  }

  const membership = await GroupMember.findOne({
    group_id: groupId,
    user_id: targetUserId,
  }).lean()
  if (!membership) {
    throw validationError('User must be a member of this group')
  }

  const session = await mongoose.startSession()
  try {
    session.startTransaction()

    await GroupMember.updateMany(
      { group_id: groupId, role: 'leader', user_id: { $ne: targetUserId } },
      { $set: { role: 'member' } },
      { session },
    )

    await GroupMember.updateOne(
      { group_id: groupId, user_id: targetUserId },
      { $set: { role: 'leader' } },
      { session },
    )

    await session.commitTransaction()
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction()
    }
    throw error
  } finally {
    session.endSession()
  }

  return getGroupLeaderId(groupId)
}

export async function resolveGroupByIdOrSlug(groupIdOrSlug) {
  const group = await StudyGroup.findOne({
    $or: [{ id: groupIdOrSlug }, { slug: groupIdOrSlug }],
  }).lean()
  if (!group) {
    throw notFound('Study group not found')
  }
  return group
}

/** Workspace transfer: caller must be current leader. */
export async function assertCallerIsLeader(groupId, callerId) {
  const ok = await isGroupLeader(groupId, callerId)
  if (!ok) {
    throw forbidden('Only the current group leader can transfer leadership')
  }
}

export async function formatLeaderTransferResponse(group) {
  const members = await GroupMember.find({ group_id: group.id }).lean()
  const users = await User.find({ id: { $in: members.map((m) => m.user_id) } }).lean()
  const userById = Object.fromEntries(users.map((u) => [u.id, u]))
  const leaderId = leaderIdFromMembers(members)

  return {
    id: group.id,
    groupId: group.slug,
    title: group.title,
    leaderId,
    members: members.map((m) => {
      const u = userById[m.user_id]
      const role = normalizeMemberRole(m.role)
      return {
        id: m.user_id,
        name: u ? `${u.first_name} ${u.last_name}`.trim() : 'Unknown',
        role,
        isLeader: role === 'leader',
        initials: m.initials,
      }
    }),
  }
}

import { v4 as uuid } from 'uuid'
import { config } from '../config.js'
import { VideoCall, Message } from '../db/models.js'
import { conflict, notFound, validationError } from '../utils/errors.js'

function sanitizeRoomToken(value) {
  return String(value || '')
    .replace(/[^a-zA-Z0-9]/g, '')
    .slice(0, 48)
}

export function buildJitsiJoinUrl(roomName, { displayName, userEmail } = {}) {
  const params = new URLSearchParams()
  if (displayName) params.set('userInfo.displayName', displayName)
  if (userEmail) params.set('userInfo.email', userEmail)
  // Skip prejoin for smoother in-app embeds
  params.set('config.prejoinConfig.enabled', 'false')
  params.set('config.disableDeepLinking', 'true')

  const query = params.toString()
  return `https://${config.jitsiDomain}/${roomName}${query ? `?${query}` : ''}`
}

export function formatVideoCall(call, { displayName, userEmail } = {}) {
  return {
    id: call.id,
    groupId: call.group_slug,
    status: call.status,
    provider: call.provider,
    roomName: call.room_name,
    joinUrl: buildJitsiJoinUrl(call.room_name, { displayName, userEmail }),
    startedById: call.started_by_id,
    participantIds: call.participant_ids ?? [],
    participantCount: (call.participant_ids ?? []).length,
    startedAt: call.started_at,
    endedAt: call.ended_at ?? undefined,
    endedById: call.ended_by_id ?? undefined,
  }
}

export async function getActiveCallForGroup(groupId) {
  return VideoCall.findOne({ group_id: groupId, status: 'active' }).lean()
}

export async function startVideoCall({ group, user, title, io }) {
  const existing = await getActiveCallForGroup(group.id)
  if (existing) {
    throw conflict('A video call is already active for this pod', {
      call: formatVideoCall(existing, {
        displayName: `${user.first_name} ${user.last_name}`.trim(),
        userEmail: user.email,
      }),
    })
  }

  const callId = uuid()
  const now = new Date().toISOString()
  const roomName = `StudySync${sanitizeRoomToken(group.slug)}${sanitizeRoomToken(callId).slice(0, 12)}`
  const joinUrl = buildJitsiJoinUrl(roomName, {
    displayName: `${user.first_name} ${user.last_name}`.trim(),
    userEmail: user.email,
  })

  await VideoCall.create({
    id: callId,
    group_id: group.id,
    group_slug: group.slug,
    room_name: roomName,
    join_url: joinUrl,
    provider: 'jitsi',
    status: 'active',
    started_by_id: user.id,
    participant_ids: [user.id],
    started_at: now,
  })

  const messageId = uuid()
  const content = title?.trim()
    ? `Started a video call: ${title.trim()}`
    : 'Started a video call'

  await Message.create({
    id: messageId,
    group_id: group.id,
    sender_id: user.id,
    type: 'call',
    content,
    call_id: callId,
    sent_at: now,
  })

  const call = await VideoCall.findOne({ id: callId }).lean()
  const formatted = formatVideoCall(call, {
    displayName: `${user.first_name} ${user.last_name}`.trim(),
    userEmail: user.email,
  })

  const message = {
    id: messageId,
    senderId: user.id,
    type: 'call',
    content,
    sentAt: now,
    call: {
      id: callId,
      status: 'active',
      joinUrl: formatted.joinUrl,
      roomName: formatted.roomName,
    },
  }

  if (io) {
    io.to(`workspace:${group.slug}`).emit('call:started', {
      groupId: group.slug,
      call: formatted,
      message,
    })
    io.to(`workspace:${group.slug}`).emit('message:new', {
      groupId: group.slug,
      message,
    })
  }

  return { call: formatted, message }
}

export async function joinVideoCall({ group, callId, user, io }) {
  const call = await VideoCall.findOne({ id: callId, group_id: group.id }).lean()
  if (!call) {
    throw notFound('Video call not found')
  }
  if (call.status !== 'active') {
    throw validationError('This video call has ended')
  }

  const participantIds = new Set(call.participant_ids ?? [])
  participantIds.add(user.id)

  await VideoCall.updateOne(
    { id: callId },
    { participant_ids: [...participantIds] },
  )

  const updated = await VideoCall.findOne({ id: callId }).lean()
  const formatted = formatVideoCall(updated, {
    displayName: `${user.first_name} ${user.last_name}`.trim(),
    userEmail: user.email,
  })

  if (io) {
    io.to(`workspace:${group.slug}`).emit('call:participant-joined', {
      groupId: group.slug,
      callId,
      userId: user.id,
      name: `${user.first_name} ${user.last_name}`.trim(),
      call: formatted,
    })
  }

  return formatted
}

export async function leaveVideoCall({ group, callId, user, io }) {
  const call = await VideoCall.findOne({ id: callId, group_id: group.id }).lean()
  if (!call) {
    throw notFound('Video call not found')
  }
  if (call.status !== 'active') {
    return formatVideoCall(call)
  }

  const participantIds = (call.participant_ids ?? []).filter((id) => id !== user.id)

  await VideoCall.updateOne({ id: callId }, { participant_ids: participantIds })

  const updated = await VideoCall.findOne({ id: callId }).lean()
  const formatted = formatVideoCall(updated)

  if (io) {
    io.to(`workspace:${group.slug}`).emit('call:participant-left', {
      groupId: group.slug,
      callId,
      userId: user.id,
      call: formatted,
    })
  }

  // Auto-end when everyone leaves
  if (participantIds.length === 0) {
    return endVideoCall({ group, callId, user, io, reason: 'empty' })
  }

  return formatted
}

export async function endVideoCall({ group, callId, user, io, reason = 'ended' }) {
  const call = await VideoCall.findOne({ id: callId, group_id: group.id }).lean()
  if (!call) {
    throw notFound('Video call not found')
  }
  if (call.status === 'ended') {
    return formatVideoCall(call)
  }

  const now = new Date().toISOString()
  await VideoCall.updateOne(
    { id: callId },
    {
      status: 'ended',
      ended_at: now,
      ended_by_id: user.id,
      participant_ids: [],
    },
  )

  const messageId = uuid()
  const content = reason === 'empty' ? 'Video call ended' : 'Ended the video call'

  await Message.create({
    id: messageId,
    group_id: group.id,
    sender_id: user.id,
    type: 'call',
    content,
    call_id: callId,
    sent_at: now,
  })

  const updated = await VideoCall.findOne({ id: callId }).lean()
  const formatted = formatVideoCall(updated)
  const message = {
    id: messageId,
    senderId: user.id,
    type: 'call',
    content,
    sentAt: now,
    call: {
      id: callId,
      status: 'ended',
      joinUrl: formatted.joinUrl,
      roomName: formatted.roomName,
    },
  }

  if (io) {
    io.to(`workspace:${group.slug}`).emit('call:ended', {
      groupId: group.slug,
      call: formatted,
      message,
    })
    io.to(`workspace:${group.slug}`).emit('message:new', {
      groupId: group.slug,
      message,
    })
  }

  return formatted
}

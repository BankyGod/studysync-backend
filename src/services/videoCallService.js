import { v4 as uuid } from 'uuid'
import { config } from '../config.js'
import { VideoCall, Message } from '../db/models.js'
import { conflict, notFound, validationError } from '../utils/errors.js'

const DEFAULT_ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
]

function sanitizeRoomToken(value) {
  return String(value || '')
    .replace(/[^a-zA-Z0-9]/g, '')
    .slice(0, 48)
}

function parseIceServers() {
  const raw = process.env.WEBRTC_ICE_SERVERS?.trim()
  if (!raw) return DEFAULT_ICE_SERVERS
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) && parsed.length ? parsed : DEFAULT_ICE_SERVERS
  } catch {
    return DEFAULT_ICE_SERVERS
  }
}

export function buildJitsiJoinUrl(roomName, { displayName, userEmail } = {}) {
  const params = new URLSearchParams()
  if (displayName) params.set('userInfo.displayName', displayName)
  if (userEmail) params.set('userInfo.email', userEmail)
  params.set('config.prejoinConfig.enabled', 'false')
  params.set('config.disableDeepLinking', 'true')
  params.set('config.startWithAudioMuted', 'false')
  params.set('config.startWithVideoMuted', 'false')
  // Prefer in-browser experience (helps avoid mobile deep-link redirects)
  params.set('config.disableInviteFunctions', 'true')

  const query = params.toString()
  return `https://${config.jitsiDomain}/${roomName}${query ? `?${query}` : ''}`
}

export function buildEmbedConfig(call, { displayName, userEmail } = {}) {
  if (call.provider === 'webrtc') {
    return {
      mode: 'webrtc',
      callId: call.id,
      groupId: call.group_slug,
      iceServers: parseIceServers(),
      socketRoom: `call:${call.id}`,
      displayName: displayName || undefined,
    }
  }

  return {
    mode: 'jitsi',
    domain: config.jitsiDomain,
    roomName: call.room_name,
    callId: call.id,
    groupId: call.group_slug,
    displayName: displayName || undefined,
    email: userEmail || undefined,
    // Use with Jitsi Meet External API — mount inside your app, do NOT redirect
    options: {
      roomName: call.room_name,
      width: '100%',
      height: '100%',
      parentNode: null,
      userInfo: {
        displayName: displayName || 'StudySync User',
        email: userEmail || undefined,
      },
      configOverwrite: {
        prejoinPageEnabled: false,
        prejoinConfig: { enabled: false },
        disableDeepLinking: true,
        startWithAudioMuted: false,
        startWithVideoMuted: false,
        enableWelcomePage: false,
        disableInviteFunctions: true,
      },
      interfaceConfigOverwrite: {
        DISABLE_JOIN_LEAVE_NOTIFICATIONS: true,
        SHOW_JITSI_WATERMARK: false,
        MOBILE_APP_PROMO: false,
      },
    },
  }
}

export function formatVideoCall(call, { displayName, userEmail } = {}) {
  const joinUrl =
    call.provider === 'webrtc'
      ? null
      : buildJitsiJoinUrl(call.room_name, { displayName, userEmail })

  return {
    id: call.id,
    groupId: call.group_slug,
    status: call.status,
    provider: call.provider,
    roomName: call.room_name,
    // Prefer embed — do not navigate the browser away from StudySync
    joinUrl,
    embed: buildEmbedConfig(call, { displayName, userEmail }),
    startedById: call.started_by_id,
    participantIds: call.participant_ids ?? [],
    participantCount: (call.participant_ids ?? []).length,
    startedAt: call.started_at,
    endedAt: call.ended_at ?? undefined,
    endedById: call.ended_by_id ?? undefined,
  }
}

function callMessagePayload(call, formatted) {
  return {
    id: call.id,
    status: call.status,
    provider: call.provider,
    joinUrl: formatted.joinUrl,
    roomName: formatted.roomName,
    embed: formatted.embed,
  }
}

export async function getActiveCallForGroup(groupId) {
  return VideoCall.findOne({ group_id: groupId, status: 'active' }).lean()
}

export async function startVideoCall({ group, user, title, provider, io }) {
  const existing = await getActiveCallForGroup(group.id)
  if (existing) {
    throw conflict('A video call is already active for this pod', {
      call: formatVideoCall(existing, {
        displayName: `${user.first_name} ${user.last_name}`.trim(),
        userEmail: user.email,
      }),
    })
  }

  const selectedProvider = ['webrtc', 'jitsi'].includes(provider) ? provider : 'webrtc'
  const callId = uuid()
  const now = new Date().toISOString()
  const roomName =
    selectedProvider === 'webrtc'
      ? `webrtc-${sanitizeRoomToken(group.slug)}-${sanitizeRoomToken(callId).slice(0, 12)}`
      : `StudySync${sanitizeRoomToken(group.slug)}${sanitizeRoomToken(callId).slice(0, 12)}`

  const joinUrl =
    selectedProvider === 'jitsi'
      ? buildJitsiJoinUrl(roomName, {
          displayName: `${user.first_name} ${user.last_name}`.trim(),
          userEmail: user.email,
        })
      : `studysync://call/${group.slug}/${callId}`

  await VideoCall.create({
    id: callId,
    group_id: group.id,
    group_slug: group.slug,
    room_name: roomName,
    join_url: joinUrl,
    provider: selectedProvider,
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
    call: callMessagePayload(call, formatted),
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

  await VideoCall.updateOne({ id: callId }, { participant_ids: [...participantIds] })

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
    io.to(`call:${callId}`).emit('call:participant-joined', {
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
    const payload = {
      groupId: group.slug,
      callId,
      userId: user.id,
      call: formatted,
    }
    io.to(`workspace:${group.slug}`).emit('call:participant-left', payload)
    io.to(`call:${callId}`).emit('call:participant-left', payload)
  }

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
    call: callMessagePayload(updated, formatted),
  }

  if (io) {
    io.to(`workspace:${group.slug}`).emit('call:ended', {
      groupId: group.slug,
      call: formatted,
      message,
    })
    io.to(`call:${callId}`).emit('call:ended', {
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

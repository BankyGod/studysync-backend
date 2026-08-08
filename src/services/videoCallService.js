import { v4 as uuid } from 'uuid'
import { config } from '../config.js'
import { VideoCall, Message } from '../db/models.js'
import { conflict, notFound, validationError } from '../utils/errors.js'
import {
  buildAuthenticatedRoomUrl,
  getJitsiAuthMode,
  mintJitsiJwt,
} from './jitsiJwt.js'

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

function buildJitsiCredentials(call, user, { moderator = false } = {}) {
  const auth = getJitsiAuthMode()
  const displayName = `${user.first_name} ${user.last_name}`.trim()
  const userEmail = user.email
  const domain = auth.mode === 'jaas' ? auth.domain || '8x8.vc' : config.jitsiDomain

  const jwtToken = mintJitsiJwt({
    roomName: call.room_name,
    userId: user.id,
    displayName,
    userEmail,
    moderator,
  })

  const appId = auth.mode === 'jaas' ? auth.appId : undefined
  const roomUrl = buildAuthenticatedRoomUrl(domain, call.room_name, jwtToken, {
    displayName,
    userEmail,
    appId,
  })

  return {
    domain,
    jwt: jwtToken,
    roomUrl,
    joinUrl: roomUrl,
    authMode: auth.mode,
    appId,
    displayName,
    userEmail,
    moderator,
  }
}

export function buildEmbedConfig(call, user, { moderator = false } = {}) {
  if (call.provider === 'webrtc') {
    return {
      mode: 'webrtc',
      callId: call.id,
      groupId: call.group_slug,
      iceServers: parseIceServers(),
      socketRoom: `call:${call.id}`,
      displayName: `${user.first_name} ${user.last_name}`.trim(),
    }
  }

  const creds = buildJitsiCredentials(call, user, { moderator })
  const auth = getJitsiAuthMode()

  // Shape for @jitsi/react-sdk — https://jitsi.github.io/handbook/docs/dev-guide/dev-guide-react-sdk
  const reactSdk = {
    component: auth.mode === 'jaas' ? 'JaaSMeeting' : 'JitsiMeeting',
    domain: creds.domain,
    appId: creds.appId,
    roomName: call.room_name,
    jwt: creds.jwt || undefined,
    userInfo: {
      displayName: creds.displayName,
      email: creds.userEmail,
    },
    configOverwrite: {
      prejoinPageEnabled: false,
      prejoinConfig: { enabled: false },
      disableDeepLinking: true,
      startWithAudioMuted: false,
      startWithVideoMuted: false,
      enableWelcomePage: false,
      disableInviteFunctions: true,
      requireDisplayName: false,
    },
    interfaceConfigOverwrite: {
      DISABLE_JOIN_LEAVE_NOTIFICATIONS: true,
      SHOW_JITSI_WATERMARK: false,
      MOBILE_APP_PROMO: false,
    },
  }

  return {
    mode: auth.mode === 'jaas' ? 'jaas' : 'jitsi',
    domain: creds.domain,
    appId: creds.appId,
    roomName: call.room_name,
    jwt: creds.jwt,
    roomUrl: creds.roomUrl,
    callId: call.id,
    groupId: call.group_slug,
    displayName: creds.displayName,
    email: creds.userEmail,
    moderator: creds.moderator,
    authMode: creds.authMode,
    requiresJwt: auth.mode !== 'anonymous',
    jwtConfigured: Boolean(creds.jwt),
    reactSdk,
    options: {
      roomName: call.room_name,
      jwt: creds.jwt || undefined,
      width: '100%',
      height: '100%',
      parentNode: null,
      userInfo: reactSdk.userInfo,
      configOverwrite: reactSdk.configOverwrite,
      interfaceConfigOverwrite: reactSdk.interfaceConfigOverwrite,
    },
  }
}

export function formatVideoCall(call, user, { moderator = false } = {}) {
  if (call.provider === 'webrtc') {
    return {
      id: call.id,
      groupId: call.group_slug,
      status: call.status,
      provider: call.provider,
      roomName: call.room_name,
      joinUrl: null,
      roomUrl: null,
      jwt: null,
      embed: buildEmbedConfig(call, user, { moderator }),
      startedById: call.started_by_id,
      participantIds: call.participant_ids ?? [],
      participantCount: (call.participant_ids ?? []).length,
      startedAt: call.started_at,
      endedAt: call.ended_at ?? undefined,
      endedById: call.ended_by_id ?? undefined,
    }
  }

  const isStarter = user.id === call.started_by_id
  const grantModerator = moderator || isStarter
  const embed = buildEmbedConfig(call, user, { moderator: grantModerator })
  const creds = buildJitsiCredentials(call, user, { moderator: grantModerator })

  return {
    id: call.id,
    groupId: call.group_slug,
    status: call.status,
    provider: call.provider,
    roomName: call.room_name,
    // React SDK / iframe: prefer these
    jwt: creds.jwt,
    roomUrl: creds.roomUrl,
    joinUrl: creds.roomUrl,
    domain: creds.domain,
    appId: creds.appId,
    moderator: grantModerator,
    authMode: creds.authMode,
    jwtConfigured: Boolean(creds.jwt),
    embed,
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
    roomUrl: formatted.roomUrl,
    roomName: formatted.roomName,
    jwt: formatted.jwt,
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
      call: formatVideoCall(existing, user, { moderator: existing.started_by_id === user.id }),
    })
  }

  // Prefer jitsi when JWT is configured (React SDK path); otherwise webrtc
  const auth = getJitsiAuthMode()
  const requested = ['webrtc', 'jitsi'].includes(provider) ? provider : null
  const selectedProvider =
    requested || (auth.mode === 'anonymous' ? 'webrtc' : 'jitsi')

  if (selectedProvider === 'jitsi' && auth.mode === 'anonymous') {
    console.warn(
      'Jitsi call started without JAAS/JWT credentials — participants may see "waiting for moderator". ' +
        'Set JAAS_APP_ID + JAAS_API_KEY_ID + JAAS_PRIVATE_KEY (or JITSI_APP_ID + JITSI_JWT_SECRET).',
    )
  }

  const callId = uuid()
  const now = new Date().toISOString()
  const roomName =
    selectedProvider === 'webrtc'
      ? `webrtc-${sanitizeRoomToken(group.slug)}-${sanitizeRoomToken(callId).slice(0, 12)}`
      : `StudySync${sanitizeRoomToken(group.slug)}${sanitizeRoomToken(callId).slice(0, 12)}`

  const provisionalJoin =
    selectedProvider === 'jitsi'
      ? buildAuthenticatedRoomUrl(
          auth.mode === 'jaas' ? auth.domain || '8x8.vc' : config.jitsiDomain,
          roomName,
          null,
          {
            displayName: `${user.first_name} ${user.last_name}`.trim(),
            userEmail: user.email,
            appId: auth.mode === 'jaas' ? auth.appId : undefined,
          },
        )
      : `studysync://call/${group.slug}/${callId}`

  await VideoCall.create({
    id: callId,
    group_id: group.id,
    group_slug: group.slug,
    room_name: roomName,
    join_url: provisionalJoin,
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
  const formatted = formatVideoCall(call, user, { moderator: true })

  // Persist authenticated URL when JWT available
  if (formatted.roomUrl) {
    await VideoCall.updateOne({ id: callId }, { join_url: formatted.roomUrl })
  }

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
  // Joiner is moderator only if they started the call
  const formatted = formatVideoCall(updated, user, {
    moderator: updated.started_by_id === user.id,
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
    return formatVideoCall(call, user)
  }

  const participantIds = (call.participant_ids ?? []).filter((id) => id !== user.id)

  await VideoCall.updateOne({ id: callId }, { participant_ids: participantIds })

  const updated = await VideoCall.findOne({ id: callId }).lean()
  const formatted = formatVideoCall(updated, user)

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
    return formatVideoCall(call, user)
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
  const formatted = formatVideoCall(updated, user)
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

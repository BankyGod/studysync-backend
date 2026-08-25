import { AccessToken } from 'livekit-server-sdk'

function normalizeLiveKitUrl(raw) {
  const value = (raw || '').trim().replace(/\/$/, '')
  if (!value) return ''
  // Accept https:// and convert to wss:// for the client SDK
  if (value.startsWith('https://')) return `wss://${value.slice('https://'.length)}`
  if (value.startsWith('http://')) return `ws://${value.slice('http://'.length)}`
  return value
}

export function getLiveKitConfig() {
  const url = normalizeLiveKitUrl(process.env.LIVEKIT_URL || process.env.LIVEKIT_WS_URL)
  const apiKey = (process.env.LIVEKIT_API_KEY || '').trim()
  const apiSecret = (process.env.LIVEKIT_API_SECRET || '').trim()

  if (!url || !apiKey || !apiSecret) {
    return null
  }

  return { url, apiKey, apiSecret }
}

export function isLiveKitConfigured() {
  return Boolean(getLiveKitConfig())
}

/**
 * Mint a LiveKit access token for a pod participant.
 * Rooms are created automatically when the first client joins.
 */
export async function mintLiveKitToken({
  roomName,
  identity,
  displayName,
  canPublish = true,
  canSubscribe = true,
  roomAdmin = false,
  ttl = '3h',
} = {}) {
  const cfg = getLiveKitConfig()
  if (!cfg) {
    return null
  }

  const at = new AccessToken(cfg.apiKey, cfg.apiSecret, {
    identity: String(identity),
    name: displayName || undefined,
    ttl,
  })

  at.addGrant({
    roomJoin: true,
    room: roomName,
    canPublish,
    canSubscribe,
    canPublishData: true,
    roomAdmin: Boolean(roomAdmin),
  })

  const token = await at.toJwt()
  return {
    token,
    url: cfg.url,
    roomName,
    identity: String(identity),
  }
}

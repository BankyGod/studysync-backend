import fs from 'fs'
import jwt from 'jsonwebtoken'
import { config } from '../config.js'

function readPrivateKey() {
  const inline = process.env.JAAS_PRIVATE_KEY || process.env.JITSI_PRIVATE_KEY
  if (inline?.trim()) {
    return inline.replace(/\\n/g, '\n').trim()
  }

  const keyPath = process.env.JAAS_PRIVATE_KEY_PATH || process.env.JITSI_PRIVATE_KEY_PATH
  if (keyPath?.trim() && fs.existsSync(keyPath.trim())) {
    return fs.readFileSync(keyPath.trim(), 'utf8')
  }

  return null
}

export function getJitsiAuthMode() {
  const jaasAppId = (process.env.JAAS_APP_ID || process.env.JITSI_JAAS_APP_ID || '').trim()
  const apiKeyId = (process.env.JAAS_API_KEY_ID || process.env.JITSI_API_KEY_ID || '').trim()
  const privateKey = readPrivateKey()
  const hsSecret = (process.env.JITSI_JWT_SECRET || process.env.JITSI_APP_SECRET || '').trim()
  const hsAppId = (process.env.JITSI_APP_ID || '').trim()

  if (jaasAppId && apiKeyId && privateKey) {
    return {
      mode: 'jaas',
      domain: (process.env.JITSI_DOMAIN || '8x8.vc').replace(/^https?:\/\//, '').replace(/\/$/, ''),
      appId: jaasAppId,
      apiKeyId,
      privateKey,
    }
  }

  if (hsSecret && hsAppId) {
    return {
      mode: 'self-hosted',
      domain: config.jitsiDomain,
      appId: hsAppId,
      secret: hsSecret,
    }
  }

  return {
    mode: 'anonymous',
    domain: config.jitsiDomain,
  }
}

/**
 * Mint a Jitsi/JaaS JWT. Starter gets moderator=true so the call can begin
 * (fixes "waiting for the moderator" on locked rooms).
 */
export function mintJitsiJwt({
  roomName,
  userId,
  displayName,
  userEmail,
  moderator = false,
  expiresInSec = 60 * 60 * 3,
} = {}) {
  const auth = getJitsiAuthMode()
  if (auth.mode === 'anonymous') {
    return null
  }

  const now = Math.floor(Date.now() / 1000)
  const userContext = {
    id: userId,
    name: displayName || 'StudySync User',
    email: userEmail || undefined,
    moderator: Boolean(moderator),
    affiliation: moderator ? 'owner' : 'member',
  }

  if (auth.mode === 'jaas') {
    // Room for JaaS is typically "<appId>/<roomName>"
    const fullRoom = roomName.includes('/') ? roomName : `${auth.appId}/${roomName}`
    const payload = {
      aud: 'jitsi',
      iss: 'chat',
      iat: now,
      nbf: now - 10,
      exp: now + expiresInSec,
      sub: auth.appId,
      room: fullRoom.split('/').pop() === '*' ? '*' : roomName,
      context: {
        user: userContext,
        features: {
          livestreaming: false,
          recording: false,
          transcription: false,
          'outbound-call': false,
        },
      },
    }

    // Prefer room scoped to this meeting
    payload.room = roomName

    return jwt.sign(payload, auth.privateKey, {
      algorithm: 'RS256',
      header: {
        alg: 'RS256',
        kid: auth.apiKeyId,
        typ: 'JWT',
      },
    })
  }

  // Self-hosted HS256
  const payload = {
    aud: 'jitsi',
    iss: auth.appId,
    iat: now,
    nbf: now - 10,
    exp: now + expiresInSec,
    sub: auth.domain,
    room: roomName || '*',
    context: {
      user: userContext,
    },
  }

  return jwt.sign(payload, auth.secret, { algorithm: 'HS256' })
}

export function buildAuthenticatedRoomUrl(domain, roomName, token, { displayName, userEmail, appId } = {}) {
  const params = new URLSearchParams()
  if (token) params.set('jwt', token)
  if (displayName) params.set('userInfo.displayName', displayName)
  if (userEmail) params.set('userInfo.email', userEmail)
  params.set('config.prejoinConfig.enabled', 'false')
  params.set('config.disableDeepLinking', 'true')
  params.set('config.enableWelcomePage', 'false')

  const shortRoom = roomName.startsWith('/') ? roomName.slice(1) : roomName
  // JaaS browser URLs are https://8x8.vc/<appId>/<roomName>
  const pathRoom =
    appId && !shortRoom.startsWith(`${appId}/`) ? `${appId}/${shortRoom}` : shortRoom
  return `https://${domain}/${pathRoom}?${params.toString()}`
}

export function resolveJitsiRoomName(baseRoomName) {
  const auth = getJitsiAuthMode()
  if (auth.mode === 'jaas') {
    // JaaSMeeting uses appId separately; roomName is the short room id
    return baseRoomName
  }
  return baseRoomName
}

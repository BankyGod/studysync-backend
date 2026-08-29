import path from 'path'
import { fileURLToPath } from 'url'
import dotenv from 'dotenv'

dotenv.config()

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const backendRoot = path.resolve(__dirname, '..')

const isProduction = process.env.NODE_ENV === 'production' || process.env.RENDER === 'true'

const MONGO_ENV_KEYS = ['MONGODB_URI', 'MONGO_URI', 'MONGODB_URL', 'DATABASE_URL']

function readMongoUri() {
  for (const key of MONGO_ENV_KEYS) {
    const value = process.env[key]?.trim()
    if (value) {
      return { uri: value, key }
    }
  }
  return null
}

const mongoFromEnv = readMongoUri()
const mongoUri =
  mongoFromEnv?.uri || (isProduction ? null : 'mongodb://127.0.0.1:27017/studysync')

if (!mongoUri) {
  const relatedKeys = Object.keys(process.env).filter((key) =>
    /mongo|database|db_uri/i.test(key),
  )

  console.error('MongoDB connection string not found at runtime.')
  console.error(`Expected one of: ${MONGO_ENV_KEYS.join(', ')}`)
  console.error(
    relatedKeys.length
      ? `Similar env keys present: ${relatedKeys.join(', ')}`
      : 'No Mongo-related env keys detected on this service.',
  )
  console.error('Add MONGODB_URI under Render → your Web Service → Environment → Save Changes.')

  throw new Error(
    'MONGODB_URI (or MONGO_URI) is required. Set it in your hosting provider environment variables.',
  )
}

export const config = {
  port: Number(process.env.PORT) || 3000,
  jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-in-production',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  corsOrigins: (process.env.CORS_ORIGIN || 'http://localhost:5173,http://localhost:3000')
    .split(',')
    .map((origin) => origin.trim().replace(/\/$/, ''))
    .filter(Boolean),
  mongoUri,
  uploadsDir: path.resolve(backendRoot, process.env.UPLOADS_DIR || './uploads'),
  publicApiUrl: (
    process.env.PUBLIC_API_URL ||
    process.env.RENDER_EXTERNAL_URL ||
    ''
  )
    .trim()
    .replace(/\/$/, ''),
  jitsiDomain: (process.env.JITSI_DOMAIN || 'meet.jit.si').trim().replace(/^https?:\/\//, '').replace(/\/$/, ''),
  livekitUrl: (process.env.LIVEKIT_URL || process.env.LIVEKIT_WS_URL || '').trim().replace(/\/$/, ''),
}

if (isProduction && !config.publicApiUrl) {
  console.warn(
    'PUBLIC_API_URL is not set. Avatar image URLs may not load on a separate frontend host. ' +
      'Set PUBLIC_API_URL to your API base URL (e.g. https://your-api.onrender.com).',
  )
}

const hasLiveKit =
  Boolean(config.livekitUrl) &&
  Boolean(process.env.LIVEKIT_API_KEY?.trim()) &&
  Boolean(process.env.LIVEKIT_API_SECRET?.trim())

if (!hasLiveKit) {
  console.warn(
    'LiveKit not configured. Pod video defaults to Socket.IO webrtc until you set ' +
      'LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET (LiveKit Cloud or self-hosted).',
  )
}

export function isAllowedCorsOrigin(origin) {
  if (!origin) return true
  const normalizedOrigin = origin.trim().replace(/\/$/, '')

  if (config.corsOrigins.includes('*') || config.corsOrigins.includes(normalizedOrigin)) {
    return true
  }

  // Allow local development frontends (e.g. http://localhost:5173, http://127.0.0.1:5173)
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(normalizedOrigin)) {
    return true
  }

  return false
}

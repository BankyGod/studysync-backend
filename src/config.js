import path from 'path'
import { fileURLToPath } from 'url'
import dotenv from 'dotenv'

dotenv.config()

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const backendRoot = path.resolve(__dirname, '..')

const isProduction = process.env.NODE_ENV === 'production' || process.env.RENDER === 'true'

const mongoUri =
  process.env.MONGODB_URI ||
  process.env.MONGO_URI ||
  (isProduction ? null : 'mongodb://127.0.0.1:27017/studysync')

if (!mongoUri) {
  throw new Error(
    'MONGODB_URI (or MONGO_URI) is required. Set it in your hosting provider environment variables.',
  )
}

export const config = {
  port: Number(process.env.PORT) || 3000,
  jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-in-production',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  mongoUri,
  uploadsDir: path.resolve(backendRoot, process.env.UPLOADS_DIR || './uploads'),
}

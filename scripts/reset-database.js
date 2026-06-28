/**
 * Wipes all MongoDB data and local upload files. Documentation / ops only.
 * Usage: node scripts/reset-database.js
 */
import fs from 'fs'
import path from 'path'
import mongoose from 'mongoose'
import dotenv from 'dotenv'
import { fileURLToPath } from 'url'

dotenv.config()

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')

const MONGO_ENV_KEYS = ['MONGODB_URI', 'MONGO_URI', 'MONGODB_URL', 'DATABASE_URL']

function readMongoUri() {
  for (const key of MONGO_ENV_KEYS) {
    const value = process.env[key]?.trim()
    if (value) return ensureDatabaseName(value, 'studysync')
  }
  return 'mongodb://127.0.0.1:27017/studysync'
}

function ensureDatabaseName(uri, dbName) {
  const match = uri.match(/^(mongodb(?:\+srv)?:\/\/[^/]+)(\/[^?]*)?(\?.*)?$/)
  if (!match) return uri
  const [, base, pathPart, query = ''] = match
  if (pathPart && pathPart.length > 1) return uri
  return `${base}/${dbName}${query}`
}

function clearUploadsDir(uploadsDir) {
  if (!fs.existsSync(uploadsDir)) return 0

  let removed = 0
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(fullPath)
        fs.rmdirSync(fullPath)
      } else {
        fs.unlinkSync(fullPath)
        removed += 1
      }
    }
  }

  walk(uploadsDir)
  return removed
}

async function main() {
  const mongoUri = readMongoUri()
  const uploadsDir = path.resolve(root, process.env.UPLOADS_DIR || './uploads')

  console.log('Connecting to MongoDB...')
  await mongoose.connect(mongoUri)

  const dbName = mongoose.connection.db.databaseName
  console.log(`Dropping database: ${dbName}`)
  await mongoose.connection.dropDatabase()

  await mongoose.disconnect()
  console.log('MongoDB cleared.')

  const filesRemoved = clearUploadsDir(uploadsDir)
  console.log(`Local uploads cleared (${filesRemoved} file(s) removed from ${uploadsDir}).`)
  console.log('Fresh start complete.')
}

main().catch((error) => {
  console.error('Reset failed:', error.message)
  process.exit(1)
})

/**
 * Create or promote a platform admin account.
 * Usage:
 *   node scripts/create-admin.js --email admin@studysync.com --password 'SecurePass1' --name "System Admin"
 */
import bcrypt from 'bcryptjs'
import mongoose from 'mongoose'
import dotenv from 'dotenv'
import { v4 as uuid } from 'uuid'
import { fileURLToPath } from 'url'
import path from 'path'

dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env') })

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

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true
    args[key] = value
  }
  return args
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const email = String(args.email || '').trim().toLowerCase()
  const password = String(args.password || '')
  const name = String(args.name || 'System Admin').trim()
  const [firstName, ...rest] = name.split(/\s+/)
  const lastName = rest.join(' ') || 'Admin'

  if (!email || !password) {
    console.error('Usage: node scripts/create-admin.js --email admin@example.com --password "Secret123" [--name "System Admin"]')
    process.exit(1)
  }

  if (password.length < 8) {
    console.error('Password must be at least 8 characters')
    process.exit(1)
  }

  const mongoUri = readMongoUri()
  await mongoose.connect(mongoUri)

  const users = mongoose.connection.collection('users')
  const profiles = mongoose.connection.collection('user_profiles')
  const existing = await users.findOne({ email })

  const now = new Date().toISOString()
  const passwordHash = bcrypt.hashSync(password, 10)

  if (existing) {
    await users.updateOne(
      { id: existing.id },
      {
        $set: {
          role: 'admin',
          password_hash: passwordHash,
          first_name: firstName,
          last_name: lastName,
          updated_at: now,
        },
      },
    )
    await profiles.updateOne(
      { user_id: existing.id },
      {
        $set: {
          full_name: `${firstName} ${lastName}`.trim(),
          updated_at: now,
        },
      },
      { upsert: true },
    )
    console.log(`Promoted existing user to admin: ${email} (${existing.id})`)
  } else {
    const userId = uuid()
    const studentId = `ADMIN-${Date.now()}`
    await users.insertOne({
      id: userId,
      email,
      password_hash: passwordHash,
      first_name: firstName,
      last_name: lastName,
      student_id: studentId,
      phone: null,
      university: 'Ghana Communication Technology University (GCTU)',
      program: 'Administration',
      level: '400',
      role: 'admin',
      created_at: now,
      updated_at: now,
    })
    await profiles.insertOne({
      user_id: userId,
      full_name: `${firstName} ${lastName}`.trim(),
      student_role: 'Administration',
      primary_university: 'GCTU',
      secondary_university: null,
      location: '',
      avatar_storage_key: null,
      avatar_mime_type: null,
      avatar_data: null,
      avatar_byte_length: 0,
      updated_at: now,
    })
    console.log(`Created admin user: ${email} (${userId})`)
  }

  await mongoose.disconnect()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

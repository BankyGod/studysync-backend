import bcrypt from 'bcryptjs'
import { v4 as uuid } from 'uuid'
import { User, UserProfile } from '../db/models.js'

/**
 * Optionally create/promote a default admin from env on startup.
 * Set ADMIN_EMAIL + ADMIN_PASSWORD (min 8 chars). Safe to run every boot.
 */
export async function ensureDefaultAdmin() {
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase()
  const password = process.env.ADMIN_PASSWORD?.trim()
  const name = (process.env.ADMIN_NAME || 'System Admin').trim()

  if (!email || !password) {
    return { created: false, skipped: true, reason: 'ADMIN_EMAIL/ADMIN_PASSWORD not set' }
  }

  if (password.length < 8) {
    console.warn('ADMIN_PASSWORD must be at least 8 characters — skipping default admin bootstrap')
    return { created: false, skipped: true, reason: 'password too short' }
  }

  const [firstName, ...rest] = name.split(/\s+/)
  const lastName = rest.join(' ') || 'Admin'
  const now = new Date().toISOString()
  const existing = await User.findOne({ email }).lean()

  if (existing) {
    if (existing.role === 'admin') {
      return { created: false, skipped: false, promoted: false, id: existing.id, email }
    }

    await User.updateOne(
      { id: existing.id },
      {
        role: 'admin',
        password_hash: bcrypt.hashSync(password, 10),
        first_name: firstName,
        last_name: lastName,
        updated_at: now,
      },
    )
    await UserProfile.updateOne(
      { user_id: existing.id },
      {
        $set: {
          full_name: `${firstName} ${lastName}`.trim(),
          updated_at: now,
        },
      },
      { upsert: true },
    )
    console.log(`Default admin promoted: ${email}`)
    return { created: false, skipped: false, promoted: true, id: existing.id, email }
  }

  const userId = uuid()
  const studentId = `ADMIN-${Date.now()}`

  await User.create({
    id: userId,
    email,
    password_hash: bcrypt.hashSync(password, 10),
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

  await UserProfile.create({
    user_id: userId,
    full_name: `${firstName} ${lastName}`.trim(),
    student_role: 'Administration',
    primary_university: 'GCTU',
    location: '',
    updated_at: now,
  })

  console.log(`Default admin created: ${email}`)
  return { created: true, skipped: false, promoted: false, id: userId, email }
}

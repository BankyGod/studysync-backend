/**
 * Delete all users with role "instructor" (+ related profiles).
 * Usage: node scripts/delete-instructors.js
 */
import dotenv from 'dotenv'
import mongoose from 'mongoose'
import path from 'path'
import { fileURLToPath } from 'url'

dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env') })

const uri = process.env.MONGODB_URI
if (!uri) {
  console.error('MONGODB_URI is not set')
  process.exit(1)
}

await mongoose.connect(uri)
const db = mongoose.connection.db

const instructors = await db
  .collection('users')
  .find({ role: 'instructor' }, { projection: { id: 1, email: 1, first_name: 1, last_name: 1 } })
  .toArray()

const ids = instructors.map((u) => u.id)

const users = await db.collection('users').deleteMany({ role: 'instructor' })
const profiles = await db.collection('user_profiles').deleteMany({ user_id: { $in: ids } })
const onboarding = await db.collection('onboarding_profiles').deleteMany({ user_id: { $in: ids } })
const remaining = await db.collection('users').countDocuments({ role: 'instructor' })

console.log(
  JSON.stringify(
    {
      deletedEmails: instructors.map((u) => u.email),
      deletedUsers: users.deletedCount,
      deletedProfiles: profiles.deletedCount,
      deletedOnboarding: onboarding.deletedCount,
      remainingInstructors: remaining,
    },
    null,
    2,
  ),
)

await mongoose.disconnect()

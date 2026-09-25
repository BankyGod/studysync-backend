import dns from 'node:dns'
import mongoose from 'mongoose'
import { config } from '../config.js'
import { GroupMember, Task, User } from './models.js'
import * as models from './models.js'

// Set public DNS fallback for MongoDB Atlas SRV resolution
try {
  dns.setServers(['8.8.8.8', '1.1.1.1'])
} catch (err) {
  // Ignore if DNS server configuration fails
}

export { models }
export * from './models.js'

async function backfillTaskCreators() {
  const missing = await Task.countDocuments({
    $or: [{ creator_id: null }, { creator_id: '' }],
  })
  if (missing === 0) return

  console.log(`Note: ${missing} task(s) have no creator_id — edit/delete UI hidden until recreated`)
}

async function backfillStaffRoles() {
  const adminResult = await User.updateMany(
    { role: 'admin', $or: [{ staff_role: null }, { staff_role: { $exists: false } }] },
    { $set: { staff_role: 'super_admin' } },
  )
  const instructorResult = await User.updateMany(
    { role: 'instructor', $or: [{ staff_role: null }, { staff_role: { $exists: false } }] },
    { $set: { staff_role: 'instructor' } },
  )
  const touched = (adminResult.modifiedCount || 0) + (instructorResult.modifiedCount || 0)
  if (touched > 0) {
    console.log(`Backfilled staff_role on ${touched} staff user(s)`)
  }
}

/** Ensure each pod has at most one leader; assign earliest member if none. */
async function backfillGroupLeaders() {
  const memberMissingRole = await GroupMember.updateMany(
    { $or: [{ role: null }, { role: { $exists: false } }] },
    { $set: { role: 'member' } },
  )
  if (memberMissingRole.modifiedCount) {
    console.log(`Set default member role on ${memberMissingRole.modifiedCount} membership(s)`)
  }

  const groupIds = await GroupMember.distinct('group_id')
  let assigned = 0
  for (const groupId of groupIds) {
    const leaders = await GroupMember.find({ group_id: groupId, role: 'leader' })
      .sort({ joined_at: 1 })
      .lean()

    if (leaders.length > 1) {
      const keepId = leaders[0].user_id
      await GroupMember.updateMany(
        { group_id: groupId, role: 'leader', user_id: { $ne: keepId } },
        { $set: { role: 'member' } },
      )
    }

    if (leaders.length === 0) {
      const first = await GroupMember.findOne({ group_id: groupId }).sort({ joined_at: 1 }).lean()
      if (first) {
        await GroupMember.updateOne(
          { group_id: groupId, user_id: first.user_id },
          { $set: { role: 'leader' } },
        )
        assigned += 1
      }
    }
  }

  if (assigned > 0) {
    console.log(`Assigned default leaders to ${assigned} group(s)`)
  }
}

export async function initDb() {
  await mongoose.connect(config.mongoUri)
  console.log('MongoDB connected')
  await backfillTaskCreators()
  await backfillStaffRoles()
  await backfillGroupLeaders()
  return mongoose.connection
}

export function getDb() {
  if (mongoose.connection.readyState !== 1) {
    throw new Error('Database not initialized. Call initDb() first.')
  }
  return models
}

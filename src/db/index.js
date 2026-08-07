import dns from 'node:dns'
import mongoose from 'mongoose'
import { config } from '../config.js'
import { Task } from './models.js'
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

export async function initDb() {
  await mongoose.connect(config.mongoUri)
  console.log('MongoDB connected')
  await backfillTaskCreators()
  return mongoose.connection
}

export function getDb() {
  if (mongoose.connection.readyState !== 1) {
    throw new Error('Database not initialized. Call initDb() first.')
  }
  return models
}

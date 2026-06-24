import mongoose from 'mongoose'
import { config } from '../config.js'
import * as models from './models.js'

export { models }
export * from './models.js'

export async function initDb() {
  await mongoose.connect(config.mongoUri)
  console.log('MongoDB connected')
  return mongoose.connection
}

export function getDb() {
  if (mongoose.connection.readyState !== 1) {
    throw new Error('Database not initialized. Call initDb() first.')
  }
  return models
}

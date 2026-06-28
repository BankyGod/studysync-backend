import express from 'express'
import cors from 'cors'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import swaggerUi from 'swagger-ui-express'
import YAML from 'yaml'
import { isAllowedCorsOrigin } from './config.js'
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js'
import authRoutes from './routes/auth.js'
import onboardingRoutes from './routes/onboarding.js'
import usersRoutes from './routes/users.js'
import matchingRoutes from './routes/matching.js'
import workspacesRoutes from './routes/workspaces.js'
import adminRoutes from './routes/admin.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export function createApp() {
  const app = express()

  fs.mkdirSync(config.uploadsDir, { recursive: true })

  app.use(
    cors({
      origin(origin, callback) {
        if (isAllowedCorsOrigin(origin)) {
          callback(null, true)
          return
        }
        callback(null, false)
      },
      credentials: true,
    }),
  )
  app.use(express.json({ limit: '2mb' }))

  const openapiPath = path.resolve(__dirname, '../openapi.yaml')
  const openapiDoc = YAML.parse(fs.readFileSync(openapiPath, 'utf8'))
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(openapiDoc, { explorer: true }))
  app.get('/api-docs.json', (req, res) => res.json(openapiDoc))

  app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'studysync-api' })
  })

  app.use('/api/auth', authRoutes)
  app.use('/api/onboarding', onboardingRoutes)
  app.use('/api/users', usersRoutes)
  app.use('/api/matching', matchingRoutes)
  app.use('/api/workspaces', workspacesRoutes)
  app.use('/api/admin', adminRoutes)

  app.use(notFoundHandler)
  app.use(errorHandler)

  return app
}

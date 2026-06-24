import http from 'http'
import { config } from './config.js'
import { initDb } from './db/index.js'
import { createApp } from './app.js'
import { initSocket } from './socket.js'

try {
  await initDb()
} catch (error) {
  console.error(`Failed to connect to MongoDB (${config.mongoUri})`)
  console.error(error.message)
  process.exit(1)
}

const app = createApp()
const server = http.createServer(app)
initSocket(server, app)

const host = process.env.HOST || '0.0.0.0'

server.listen(config.port, host, () => {
  console.log(`StudySync API running on port ${config.port}`)
  console.log(`Swagger UI: http://localhost:${config.port}/api-docs`)
  console.log(`OpenAPI JSON: http://localhost:${config.port}/api-docs.json`)
})

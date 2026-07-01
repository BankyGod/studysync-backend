# StudySync Backend

REST API + Socket.IO for StudySync. Uses MongoDB. No demo data is seeded on startup — the database starts empty.

## Quick start

**Prerequisites:** MongoDB running locally (or a remote `MONGODB_URI`).

```bash
cp .env.example .env   # optional — defaults work for local dev
npm install
npm run dev
```

| Resource | URL |
|----------|-----|
| **Swagger UI** | http://localhost:3000/api-docs |
| OpenAPI JSON | http://localhost:3000/api-docs.json |
| Health check | http://localhost:3000/health |
| API base | http://localhost:3000/api |

The frontend Vite dev server proxies `/api` and `/socket.io` to port `3000`.

## Environment

Copy `.env.example` to `.env` and adjust if needed:

- `PORT` — default `3000`
- `JWT_SECRET` — change in production
- `CORS_ORIGIN` — default `http://localhost:5173`
- `MONGODB_URI` — MongoDB connection string (or `MONGO_URI`; local default `mongodb://127.0.0.1:27017/studysync`)
- `UPLOADS_DIR` — file upload storage

## Typical flow (via Swagger or frontend)

1. `POST /api/auth/register` — create account
2. `POST /api/onboarding/profile` — save learning profile
3. `POST /api/matching/find-group` — get matched into a pod (only if not already in a group for that course)
4. Use `/api/workspaces/{groupId}/*` for tasks, chat, files, sessions

**Changing groups:** you cannot search/match again while already in a group for the same course. Leave first, then join or match again:

- `DELETE /api/matching/groups/{groupId}/leave` — leave your current group
- `GET /api/matching/course/{courseCode}` — browse open groups
- `POST /api/matching/groups/{groupId}/join` — join a specific group

## Workspace files

Chat attachments and Files tab uploads share one pod folder and one `stored_files` row per file:

```
uploads/{groupSlug}/files/{fileId}.ext
```

| Upload path | DB `source` | Chat message |
|-------------|-------------|--------------|
| `POST .../messages` (`type=attachment`) | `chat` | Yes |
| `POST .../files` | `files` | No |

Both appear in **`GET /workspaces/:groupId/files`**. Voice notes stay chat-only under `uploads/{groupSlug}/voice/`.

## Production

The app is ready for platforms like Render, Railway, or Heroku:

- **Start command:** `npm start` → runs `node src/index.js`
- **Port:** Set automatically via `PORT` env var (falls back to `3000` locally)
- **Required env vars on Render:**
  - `MONGODB_URI` — your Atlas connection string (include `/studysync` database name)
  - `JWT_SECRET` — a long random secret
  - `CORS_ORIGIN` — your deployed frontend URL (e.g. `https://your-app.vercel.app`)
  - `PUBLIC_API_URL` — your deployed API URL (e.g. `https://your-api.onrender.com`) so profile photos load after login

Render does **not** read your local `.env` file. Add these under **Environment** in the Render dashboard, then redeploy.

**Render settings:**
- Root directory: leave blank (`package.json` is at repo root)
- Build command: `npm install`
- Start command: `npm start`

## Scripts

- `npm run dev` — start with auto-reload (`node --watch`)
- `npm start` — production-style start

# StudySync Backend

REST API + Socket.IO for StudySync. Uses MongoDB. No demo data is seeded on startup — the database starts empty.

## Quick start

**Prerequisites:** MongoDB running locally (or a remote `MONGODB_URI`).

```bash
cd backend
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
- `MONGODB_URI` — default `mongodb://127.0.0.1:27017/studysync`
- `UPLOADS_DIR` — file upload storage

## Typical flow (via Swagger or frontend)

1. `POST /api/auth/register` — create account
2. `POST /api/onboarding/profile` — save learning profile
3. `POST /api/matching/find-group` — get matched into a pod
4. Use `/api/workspaces/{groupId}/*` for tasks, chat, files, sessions

## Production

The app is ready for platforms like Render, Railway, or Heroku:

- **Start command:** `npm start` → runs `node src/index.js`
- **Port:** Set automatically via `PORT` env var (falls back to `3000` locally)
- **Required env vars:** `MONGODB_URI`, `JWT_SECRET`, `CORS_ORIGIN` (your frontend URL)

On your host, set `PORT` if the platform does not inject it automatically (most PaaS providers do).

## Scripts

- `npm run dev` — start with auto-reload (`node --watch`)
- `npm start` — production-style start

From repo root: `npm run dev:backend`

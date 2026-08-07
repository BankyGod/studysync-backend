# Admin Portal API

Backend contract for the **admin subdomain** SPA (e.g. `https://admin.your-app.onrender.com`).

## Auth

1. Prefer **`POST /api/auth/admin/login`** for the admin subdomain (rejects students).
2. Or use `POST /api/auth/login` — then check `user.role` is `admin` or `instructor`.
3. Store the JWT and send `Authorization: Bearer <token>` on every admin request.
4. Gate the portal UI with `user.role === 'admin' || user.role === 'instructor'`.
5. `POST /api/admin/users` (create staff) requires **`admin` only**.
6. Session check: `GET /api/auth/admin/me`

Students cannot access `/api/admin/*` (403).

Public registration (`POST /api/auth/register`) only allows `student` / `instructor` — never `admin`.

### Bootstrap first admin

**Option A — env (auto on server start):**

```
ADMIN_EMAIL=admin@studysync.com
ADMIN_PASSWORD=SecurePass1
ADMIN_NAME=System Admin
```

**Option B — script:**

```bash
node scripts/create-admin.js --email admin@studysync.com --password "SecurePass1" --name "System Admin"
```

## CORS (Render)

Set on the **backend** service:

```
CORS_ORIGIN=https://study-sync-rb7b.onrender.com,https://admin.study-sync-rb7b.onrender.com
PUBLIC_API_URL=https://studysync-backend-5i2a.onrender.com
```

Replace with your real student app + admin subdomain URLs (no trailing slash).

## Base URL

```
https://studysync-backend-5i2a.onrender.com/api
```

## Portal screens → endpoints

| Screen | Endpoints |
|--------|-----------|
| Dashboard | `GET /admin/dashboard` |
| Overview report | `GET /admin/reports/overview` |
| Engagement | `GET /admin/reports/engagement` |
| Pod health | `GET /admin/reports/pods` |
| Reliability | `GET /admin/reports/reliability?limit=20` |
| Courses | `GET /admin/reports/courses` |
| Activity chart | `GET /admin/reports/activity?days=30` |
| Students list | `GET /admin/students?q=&level=&program=&onboarding=&matched=&page=1&limit=20` |
| Student detail | `GET /admin/students/:userId` |
| Pods list | `GET /admin/groups?subject=&courseNumber=&cohortId=` |
| Pod detail | `GET /admin/groups/:groupId` |
| Cohorts | `GET/POST /admin/cohorts` |
| Create staff | `POST /admin/users` (admin only) |

## Sample: `GET /admin/dashboard`

```json
{
  "overview": {
    "users": { "students": 42, "instructors": 2, "admins": 1, "total": 45 },
    "pods": { "total": 8, "memberships": 36 },
    "tasks": { "todo": 12, "inProgress": 5, "completed": 20, "total": 37 },
    "messages": 120,
    "files": 18,
    "matching": { "total": 50, "completed": 40, "waiting": 5, "failed": 5 }
  },
  "engagement": {
    "totalStudents": 42,
    "onboardingCompleted": 30,
    "onboardingRate": 71,
    "matched": 28,
    "matchedRate": 67,
    "withAssignedTasks": 22,
    "withMessages": 25,
    "inactiveStudents": 8
  },
  "recentActivity": {
    "days": 7,
    "series": [
      {
        "date": "2026-08-01",
        "signups": 2,
        "matchesCompleted": 1,
        "messages": 14,
        "tasksCompleted": 3
      }
    ]
  }
}
```

## Sample: create staff `POST /admin/users`

```json
{
  "email": "instructor@gctu.edu.gh",
  "password": "SecurePass1",
  "firstName": "Ama",
  "lastName": "Mensah",
  "role": "instructor"
}
```

`role` must be `instructor` or `admin`.

## Notes for the admin SPA

- Use the same API host as the student app; only the frontend origin differs (subdomain).
- Do not rely on cookies across subdomains — use Bearer JWT in `localStorage` / memory.
- Swagger: `GET /api-docs` on the backend lists these routes under **Admin**.

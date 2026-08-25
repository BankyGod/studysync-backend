# Admin Portal API — frontend integration

Backend contract for the **admin subdomain** SPA (e.g. `https://admin.your-app.onrender.com`).

All counts and lists come from **live MongoDB data**.  
**Zero / empty arrays mean there is no data yet** — not broken endpoints or dummy placeholders.

---

## Base URL

```
https://studysync-backend-5i2a.onrender.com/api
```

Swagger: `GET /api-docs` (Admin tag).

---

## Auth

| Step | Endpoint |
|------|----------|
| Login (admin SPA) | `POST /auth/admin/login` |
| Session check | `GET /auth/admin/me` |

1. Prefer **`POST /auth/admin/login`** — rejects students.
2. Or `POST /auth/login`, then require `user.role` is `admin` or `instructor`.
3. Store the JWT; send `Authorization: Bearer <token>` on every `/admin/*` request.
4. Gate UI: `role === 'admin' || role === 'instructor'`.
5. `POST /admin/users` (create staff) requires **`admin` only**.

Students get **403** on `/admin/*`.

Public register never creates `admin` (only `student` / `instructor`).

### Bootstrap first admin

```bash
# Option A — env on server start
ADMIN_EMAIL=admin@studysync.com
ADMIN_PASSWORD=SecurePass1
ADMIN_NAME=System Admin

# Option B — script
node scripts/create-admin.js --email admin@studysync.com --password "SecurePass1" --name "System Admin"
```

---

## CORS (Render)

On the **backend** service:

```
CORS_ORIGIN=https://study-sync-rb7b.onrender.com,https://admin.study-sync-rb7b.onrender.com
PUBLIC_API_URL=https://studysync-backend-5i2a.onrender.com
```

No trailing slashes. Use Bearer JWT (not cross-subdomain cookies).

---

## Screens → endpoints

| Screen | Method | Path |
|--------|--------|------|
| Login | `POST` | `/auth/admin/login` |
| Session | `GET` | `/auth/admin/me` |
| Dashboard | `GET` | `/admin/dashboard` |
| Students list | `GET` | `/admin/students?q=&level=&program=&onboarding=&matched=&page=1&limit=20` |
| Student detail | `GET` | `/admin/students/:userId` |
| Pods list | `GET` | `/admin/groups?subject=&courseNumber=&cohortId=` |
| Pod detail | `GET` | `/admin/groups/:groupId` |
| Cohorts list | `GET` | `/admin/cohorts` |
| Create cohort | `POST` | `/admin/cohorts` |
| Create staff | `POST` | `/admin/users` (**admin only**) |

### Optional report pages

| Screen | Path |
|--------|------|
| Overview | `GET /admin/reports/overview` |
| Engagement | `GET /admin/reports/engagement` |
| Pod health | `GET /admin/reports/pods` |
| Reliability | `GET /admin/reports/reliability?limit=20` |
| Courses | `GET /admin/reports/courses` |
| Activity chart | `GET /admin/reports/activity?days=30` |

**Removed (do not call):** `POST /admin/seed`, `POST /admin/matching/run` — these were demo/stub endpoints.

---

## Field glossary

| Field | Meaning |
|-------|---------|
| `id` | Stable UUID for the entity (user, group, cohort) |
| `groupId` | Pod **slug** (URL-friendly course key), not the UUID |
| `cohortId` | UUID of the cohort a pod belongs to (or `null`) |
| `matched` | Student is in at least one pod |
| `atRisk` | Reliability score present and **&lt; 60** |
| `summary.*` | Dashboard card counts — bind these for Students / Pods / Cohorts / Matched |

---

## `GET /admin/dashboard`

Bind overview cards to **`summary` only**:

```json
{
  "summary": {
    "students": 42,
    "pods": 8,
    "cohorts": 2,
    "matched": 28
  },
  "overview": {
    "students": 42,
    "pods": 8,
    "cohorts": 2,
    "matched": 28,
    "users": { "students": 42, "instructors": 2, "admins": 1, "total": 45 },
    "podStats": { "total": 8, "memberships": 36 },
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

| Card | Bind |
|------|------|
| Students | `summary.students` |
| Pods | `summary.pods` |
| Cohorts | `summary.cohorts` |
| Matched | `summary.matched` |

There are **no** top-level duplicate `students` / `pods` aliases anymore.

---

## `GET /admin/cohorts`

```json
{
  "cohorts": [
    {
      "id": "...",
      "name": "Default Cohort",
      "term": "2026",
      "studentCount": 12,
      "podCount": 3,
      "pods": [{ "id": "...", "groupId": "cs101", "title": "CS 101 Pod" }],
      "createdAt": "..."
    }
  ],
  "total": 1
}
```

**Default Cohort:** if pods exist with no `cohort_id` and no cohorts exist yet, the API creates one **Default Cohort** and attaches those pods. That is real grouping, not fake students.

Create:

```http
POST /admin/cohorts
{ "name": "Fall 2026", "term": "2026" }
```

---

## `POST /admin/users` (admin only)

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

---

## Students & pods (quick)

**Students list** → `{ students, page, limit, total, totalPages }`  
**Student detail** → profile, onboarding, courses, groups, reliability  

**Pods list** → `{ groups: [{ id, groupId, title, members[], atRiskCount, ... }] }`  
**Pod detail** → members + `stats` (tasks / messages / files)

---

## Notes for the admin SPA

- Same API host as the student app; only the frontend origin differs.
- Do not invent client-side demo numbers — use API responses as-is.
- Matching for students still runs on the student app matching APIs, not an admin batch stub.

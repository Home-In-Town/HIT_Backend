# HomeInTown Backend

Production backend for the HomeInTown real estate platform. Deployed on Google Cloud Run.

**Live URL:** `https://sales-website-backend-624770114041.asia-south1.run.app`  
**GCP Project:** `homeintown-486304`  
**Current revision:** `00046-rrs`

---

## Tech Stack

- **Runtime:** Node.js
- **Framework:** Express 5
- **Database:** MongoDB Atlas (Mongoose)
- **Real-time:** Socket.io
- **Auth:** JWT (HTTP-only cookies) + bcryptjs
- **File uploads:** Multer → Cloudflare R2
- **Validation:** Joi
- **Rate limiting:** express-rate-limit

---

## Features

- **Project Management** — CRUD + publish with auto-generated public slugs
- **Media Uploads** — proxy upload to Cloudflare R2 (`sales-assets` bucket)
- **Analytics Tracking** — pageviews, time spent, CTA clicks per project
- **CRM Pipeline** — lead management with stages
- **Chat** — Socket.io real-time messaging between builders/agents
- **Marketplace** — property marketplace listings
- **Employee Tracking** — GPS location history
- **Organizations** — builder → agent hierarchies
- **Notifications** — real-time via Socket.io
- **Role-based Auth** — `admin`, `builder`, `agent`, `employee`, `user`

---

## Quick Start

```bash
npm install
npm run dev   # development with --watch
npm start     # production
```

Create `.env`:
```env
PORT=5001
MONGODB_URI=your_mongodb_connection_string
JWT_SECRET=your_jwt_secret
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET_NAME=sales-assets
```

---

## Key API Routes

### Projects (`/api/projects`)
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/` | List all projects |
| `POST` | `/` | Create project |
| `GET` | `/:id` | Get project |
| `PUT` | `/:id` | Update project |
| `DELETE` | `/:id` | Delete project |
| `POST` | `/:id/publish` | Publish (generates slug) |

### Public (`/api/public`)
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/projects` | All published projects (used by AI Voice Agent) |
| `GET` | `/projects/:slug` | Project by slug |

### Files (`/api/files`)
| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/proxy-upload` | Upload file → R2, saves to project via `$push` |

### Analytics (`/api/track`, `/api/analytics`)
| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/track/pageview` | Track page view |
| `POST` | `/track/time` | Track time spent |
| `POST` | `/track/cta` | Track CTA click |
| `GET` | `/analytics/overview` | System-wide overview |
| `GET` | `/analytics/projects/:id` | Per-project analytics |

### Auth (`/api/auth`)
Phone + MPIN login with MSG91 SMS OTP (DLT registration pending — see `.kiro/SESSION_CONTEXT.md`).

---

## Deploy

```bash
gcloud run deploy sales-website-backend \
  --source . \
  --project homeintown-486304 \
  --region asia-south1 \
  --allow-unauthenticated \
  --port 8080
```

---

## Project Structure

```
HIT_Backend/
├── config/          — DB connection, app config, R2 client
├── controllers/     — Request handlers
├── middleware/      — Auth, validation, rate limiter, error handler
├── models/          — Mongoose schemas
├── repositories/    — Data access layer (flatten for partial $set updates)
├── routes/          — Express routers
├── services/        — Business logic (MSG91, email, etc.)
├── sockets/         — Socket.io event handlers
├── utils/           — Helpers
└── server.js        — Entry point
```

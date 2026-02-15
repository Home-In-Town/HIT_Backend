# Sales Website Backend

This is the backend service for the Sales Website application. It handles project management, data storage (MongoDB), and analytics tracking for real estate projects. It provides a RESTful API for the frontend application.

## 🚀 Features

- **Project Management**: Create, read, update, and delete real estate project details.
- **Publishing System**: Publish projects to generate unique, publicly accessible URLs (slugs).
- **Public API**: Serve project data to public-facing pages.
- **Analytics Tracking**: Track visitor interactions including page views, time spent, and CTA clicks (WhatsApp/Call).

## 🛠️ Tech Stack

- **Runtime**: Node.js
- **Framework**: Express.js
- **Database**: MongoDB (via Mongoose)
- **Utilities**: 
  - `axios` for external API requests
  - `cors` for cross-origin resource sharing
  - `dotenv` for environment configuration
  - `joi` for validation

## 📦 Installation

1. Navigate to the backend directory:
   ```bash
   cd backend
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Configure Environment Variables:
   Create a `.env` file in the root with the following:
   ```env
   PORT=5001
   MONGODB_URI=your_mongodb_connection_string
   ```

## 🏃‍♂️ Running the Server

### Development Mode
Runs the server with hot-reloading (using `--watch` or nodemon).
```bash
npm run dev
```

### Production Start
```bash
npm start
```

## 🔌 API Endpoints

The server runs on `http://localhost:5001` by default.

### Project Management (`/api/projects`)

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/` | List all projects |
| `POST` | `/` | Create a new project |
| `GET` | `/:projectId` | Get details of a specific project |
| `PUT` | `/:projectId` | Update a project |
| `DELETE` | `/:projectId` | Delete a project |
| `POST` | `/:projectId/publish` | Publish a project (generates public slug) |

### Public Access (`/api/public`)

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/projects/:slug` | Get public project details by slug |

### Analytics Tracking (`/api/track`)

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `POST` | `/pageview` | Track a page view event |
| `POST` | `/time` | Track time spent on page |
| `POST` | `/cta` | Track CTA clicks (Call/WhatsApp) |

### Analytics Reporting (`/api/analytics`)

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/overview` | Get system-wide analytics overview |
| `GET` | `/projects/:projectId` | Get aggregated analytics for a project |


## ⚙️ Configuration

- **PORT**: Defaults to `5001`.
- **Database**: Requires a valid MongoDB connection string.

## 📂 Project Structure

```
backend/
├── config/
│   ├── db.js             # Database connection logic
│   └── index.js          # App-wide configuration
├── controllers/          # Request handlers
├── models/               # Mongoose schemas (Project, Visit, CallLog, etc.)
├── repositories/         # Data access layer
├── routes/               # API route definitions
├── services/             # Business logic layer
├── utils/                # Helper functions
├── server.js             # Entry point
└── package.json          # Dependencies
```

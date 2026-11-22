# JobPilot Backend

A Node.js and TypeScript API for the JobPilot frontend. It handles Google sign-in, Gmail synchronization, email processing, application tracking, and review of unassigned emails.

## Requirements

- Node.js and npm (Node.js 26 has been used with this project)
- PostgreSQL with SSL enabled
- RabbitMQ
- Google OAuth credentials with the Gmail API enabled
- An OpenAI API key for processing job-related emails

## Run locally

Install dependencies and create an environment file:

```bash
npm install
cp .env.example .env
```

On Windows PowerShell, use `Copy-Item .env.example .env` instead of `cp`.

Edit `.env` with your PostgreSQL and RabbitMQ connection URLs, Google OAuth credentials, and OpenAI API key. Register `GOOGLE_REDIRECT_URI` as an authorized redirect URI in your Google OAuth client. The example uses `http://localhost:5000/api/auth/google/callback`.

Run the database migrations, then start the API and its email pipeline worker:

```bash
npm run db:migrate
npm run dev
```

The API listens on `http://localhost:5000` by default. Check `http://localhost:5000/health` to verify it is running. The frontend defaults to `http://localhost:5173`.

## Configuration

See `.env.example` for the available settings. Key variables include:

- `PORT`: API port (default `5000`).
- `CLIENT_URL`: frontend URL (default `http://localhost:5173`).
- `ALLOWED_CLIENT_ORIGINS`: optional comma-separated additional origins for browser requests. The origin of `CLIENT_URL` is always allowed.
- `DATABASE_URL`: PostgreSQL connection URL. The database connection is configured to use SSL.
- `RABBITMQ_URL`: RabbitMQ connection URL.
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`: Google OAuth configuration.
- `OPENAI_API_KEY`: enables AI processing of job-related emails. `OPENAI_MODEL` optionally overrides the default model.
- `GMAIL_PUBSUB_TOPIC`: Google Cloud Pub/Sub topic for Gmail watch notifications.
- `GMAIL_PUBSUB_AUDIENCE` and `GMAIL_PUBSUB_SERVICE_ACCOUNT_EMAIL`: configure authenticated Pub/Sub push notifications; set both together. The push endpoint must be publicly reachable.
- `SESSION_COOKIE_SAME_SITE`: session cookie SameSite setting (`lax`, `strict`, or `none`).

Gmail push notifications require a configured Google Cloud Pub/Sub topic and push subscription. Replace the example Pub/Sub placeholders with your own values, or leave them empty if push notifications are not configured.

## Test and build

```bash
npm test
npm run build
npm start
```

`npm start` runs the compiled application from `dist/`. Use `npm run test:watch` to run tests in watch mode.

## API endpoints

- `GET /health` — health check
- `GET /api/auth/google` — start Google sign-in
- `GET /api/auth/google/callback` — Google OAuth callback
- `GET /api/auth/me` — current session
- `POST /api/auth/logout` — log out
- `GET /api/applications` — list applications
- `GET /api/applications/:id/timeline` — application timeline
- `GET /api/emails/review` — list emails awaiting review
- `GET /api/emails/:id` — stored email details
- `PATCH /api/emails/:id/associate` — associate an email with an application
- `PATCH /api/emails/:id/reassign` — reassign an email
- `PATCH /api/emails/:id/unassociate` — remove an email association
- `POST /api/emails/:id/create-application` — create an application from an email
- `DELETE /api/emails/:id/review` — dismiss an email from review
- `POST /api/gmail/webhook` — receive Gmail Pub/Sub notifications

## Project structure

```text
src/
├── app.ts             # Express app and routes
├── server.ts          # API and worker startup
├── config/            # Environment and database configuration
├── database/          # Entities and migrations
├── middleware/        # CORS, request logging, and error handling
├── modules/           # Auth, applications, emails, and Gmail
├── utils/             # Shared helpers
└── workers/           # Email pipeline
tests/                 # API, module, database, and worker tests
```

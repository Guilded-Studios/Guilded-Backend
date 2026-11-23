# Guilded Backend

The self-hostable backend for Guilded, a community communication platform. Each operator runs their own instance and connects it to a PostgreSQL database they control. Supabase is supported but not required.

> **Project status:** Active development. This release contains the backend foundation and account authentication. It is not yet a complete production chat platform.

## Stack

- Node.js 22+ and TypeScript
- Express 5 REST API
- Socket.IO realtime transport
- PostgreSQL with Prisma 6
- Zod request validation
- Helmet, CORS allowlist, and authentication rate limiting
- Node.js scrypt password hashing

## Implemented API

| Method | Endpoint | Purpose | Authentication |
| --- | --- | --- | --- |
| GET | /api/v1/health | Health check | No |
| POST | /api/v1/auth/register | Create account and session | No |
| POST | /api/v1/auth/login | Sign in and create session | No |
| POST | /api/v1/auth/logout | Revoke current session | Cookie |
| GET | /api/v1/auth/me | Get current account | Cookie |
| PATCH | /api/v1/users/me | Update display name | Cookie |

Authentication uses a random opaque session token in an HTTP-only cookie. Only a SHA-256 hash of the token is stored in PostgreSQL. Passwords are hashed with scrypt; plaintext passwords are never stored. Cookies use SameSite=Lax and HttpOnly, and Secure in production. Registration and login are rate-limited. Socket.IO handshakes require a valid session cookie.

## Self-hosting

### Requirements

- Node.js 22 or newer
- pnpm 9 or newer
- PostgreSQL 14 or newer

### Setup

1. Clone this repository.
2. Install dependencies with pnpm install.
3. Copy .env.example to .env.
4. Create a PostgreSQL database and set your own DATABASE_URL.
5. Generate Prisma Client and apply migrations:

   ```bash
   pnpm db:generate
   pnpm db:deploy
   ```

6. Start the server with pnpm dev.

The API listens on http://localhost:4000 by default.

## Environment

| Variable | Description |
| --- | --- |
| NODE_ENV | development, test, or production |
| HOST | Interface to bind to |
| PORT | HTTP and Socket.IO port |
| CLIENT_ORIGINS | Comma-separated exact frontend origins |
| SESSION_TTL_DAYS | Session lifetime, 1–90 days; default 30 |
| DATABASE_URL | Connection string for your PostgreSQL database |

Never commit .env, database passwords, API keys, signing secrets, or production credentials.

## API examples

Registration:

```http
POST /api/v1/auth/register
Content-Type: application/json

{
  "username": "sample_user",
  "displayName": "Sample User",
  "email": "sample@example.com",
  "password": "a-long-unique-password"
}
```

Login:

```http
POST /api/v1/auth/login
Content-Type: application/json

{
  "identifier": "sample_user",
  "password": "a-long-unique-password"
}
```

Browser clients must send requests with credentials enabled, for example fetch(url, { credentials: "include" }). The frontend origin must be listed in CLIENT_ORIGINS.

## Database and private infrastructure

The Prisma schema and migrations describe the public database structure required by self-hosted instances. They are not Guilded Studios' production database, production records, credentials, or private operational tooling.

Each operator uses their own database. The backend connects to PostgreSQL server-side through DATABASE_URL. Do not expose database credentials or privileged Supabase keys to browser clients. RLS is enabled on the mirrored Supabase tables, with no public policies.

## Development principles

- Validate all external input.
- Authenticate protected REST and realtime operations.
- Enforce resource-level authorization on every server, channel, and message operation.
- Keep self-hosted instance data separate from Guilded's official services.
- Version every schema change with a migration.
- Never commit production credentials.

## License

Guilded Backend is licensed under GNU GPL v3.0. See LICENSE. The license does not grant rights to Guilded Studios trademarks, branding, hosted services, private databases, or separately maintained proprietary components.

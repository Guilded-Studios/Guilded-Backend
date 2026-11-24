# Guilded Backend

The self-hostable backend for Guilded, a community communication platform. Each operator runs their own instance and connects it to a PostgreSQL database they control. Supabase Auth is currently required for account registration and login; each operator manages their own PostgreSQL database.

> **Project status:** Active development. The backend currently includes account authentication, server membership, channels, text messaging, realtime channel subscriptions, configurable roles and channel permissions, friends and direct messages, events and join applications, moderation records and audit logs, message reactions, and signed file uploads/downloads. These features still require deployment-level configuration and broader integration testing.

## Stack

- Node.js 22+ and TypeScript
- Express 5 REST API
- Socket.IO realtime transport
- PostgreSQL with Prisma 6
- Zod request validation
- Helmet, CORS allowlist, and authentication rate limiting
- Node.js scrypt password hashing

## Implemented API

| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET | /api/v1/health | Health check |
| POST | /api/v1/auth/register | Create account and session |
| POST | /api/v1/auth/login | Sign in and create session |
| POST | /api/v1/auth/logout | Revoke current session |
| GET | /api/v1/auth/me | Get current account |
| PATCH | /api/v1/users/me | Update display name |
| GET | /api/v1/servers | List joined servers |
| POST | /api/v1/servers | Create a server and its general channel |
| POST | /api/v1/servers/join | Join using an invite code |
| GET | /api/v1/servers/:serverId | Get server and channel list |
| PATCH | /api/v1/servers/:serverId | Update server name/description (owner/admin) |
| POST | /api/v1/servers/:serverId/leave | Leave a server |
| POST | /api/v1/servers/:serverId/channels | Create a channel (owner/admin) |
| GET | /api/v1/channels/:channelId/messages | Read channel messages |
| POST | /api/v1/channels/:channelId/messages | Send a channel message |
| PATCH | /api/v1/channels/:channelId/messages/:messageId | Edit your own message |
| DELETE | /api/v1/channels/:channelId/messages/:messageId | Delete your message or moderate a channel |

All server and channel reads/writes verify membership. Server and channel creation is restricted to owners and administrators. Messages are limited to 4,000 characters, and message history supports cursor pagination.

## Realtime events

Socket.IO connections require a valid session cookie. After connecting:

- Emit channel:join with a channel ID to subscribe. The server checks membership before joining the room.
- Emit channel:leave with a channel ID to leave a room.
- Listen for message:new, message:update, and message:delete to receive message events in joined channels.
- Emit system:ping to test the connection.

The server only broadcasts messages to authorized channel rooms.

## Authentication

Authentication uses a random opaque session token in an HTTP-only cookie. Only a SHA-256 hash of the token is stored in PostgreSQL. Passwords are hashed with scrypt; plaintext passwords are never stored. Cookies use SameSite=Lax and HttpOnly, and Secure in production. Registration and login are rate-limited.

For browser clients, send requests with credentials enabled, for example fetch(url, { credentials: "include" }). The frontend origin must be listed in CLIENT_ORIGINS.

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
| SUPABASE_URL | Supabase project URL used by Supabase Auth and Storage |
| SUPABASE_ANON_KEY | Supabase publishable/anon key used by the backend Auth requests |
| SUPABASE_SERVICE_ROLE_KEY | Optional server-only key required for signed file uploads and downloads; never expose it to the frontend |
| GUILDED_STORAGE_BUCKET | Optional Supabase Storage bucket name; defaults to `guilded-uploads` |

Never commit .env, database passwords, API keys, signing secrets, or production credentials.

## Database and private infrastructure

The Prisma schema and migrations describe the public database structure required by self-hosted instances. They are not Guilded Studios' production database, production records, credentials, or private operational tooling.

Each operator uses their own database. The backend connects to PostgreSQL server-side through DATABASE_URL. Do not expose database credentials or privileged Supabase keys to browser clients. Do not assume database row-level security is enabled automatically; the API enforces authorization in application code, and operators should configure database access policies appropriate to their deployment.

## Development principles

- Validate all external input.
- Authenticate protected REST and realtime operations.
- Enforce resource-level authorization on every server, channel, and message operation.
- Keep self-hosted instance data separate from Guilded's official services.
- Version every schema change with a migration.
- Never commit production credentials.

## License

Guilded Backend is licensed under GNU GPL v3.0. See LICENSE. The license does not grant rights to Guilded Studios trademarks, branding, hosted services, private databases, or separately maintained proprietary components.

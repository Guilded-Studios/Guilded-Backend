# Guilded Backend

The self-hostable backend for Guilded, a community communication platform. Run your own instance and connect it to a PostgreSQL database that you control.

> **Project status:** Early development. This repository currently contains the backend foundation, not a production-ready chat service.

## Included foundation

- TypeScript and Node.js application
- REST API built with Express
- Realtime connection layer built with Socket.IO
- PostgreSQL data layer using Prisma
- Configurable CORS and security headers
- Health endpoint for deployment checks

## Self-hosting

Each self-hosted installation must use its own database and environment configuration. Guilded Studios does not provide access to its official production database, hosted services, credentials, or private infrastructure through this repository.

### Requirements

- Node.js 22 or newer
- pnpm 9 or newer
- PostgreSQL

### Setup

1. Clone this repository.
2. Install dependencies:

   ```bash
   pnpm install
   ```

3. Copy `.env.example` to `.env`.
4. Create a PostgreSQL database for your instance and set `DATABASE_URL` in `.env`.
5. Generate the Prisma client and create your first development migration:

   ```bash
   pnpm db:generate
   pnpm db:migrate
   ```

6. Start the development server:

   ```bash
   pnpm dev
   ```

The API health endpoint is available at `http://localhost:4000/api/v1/health`.

## Configuration

| Variable | Description |
| --- | --- |
| `NODE_ENV` | Runtime environment |
| `HOST` | Interface to bind to |
| `PORT` | HTTP and Socket.IO port |
| `CLIENT_ORIGINS` | Comma-separated allowed frontend origins |
| `DATABASE_URL` | Connection string for your own PostgreSQL database |

Never commit your real `.env` file, database passwords, signing secrets, API keys, or production credentials.

## Database and private infrastructure

The Prisma schema and migrations required to create and update a self-hosted instance belong in this repository. They describe the database structure needed by the public backend; they are not Guilded Studios' production database, production records, credentials, or private operational tooling.

Guilded's official production data and private infrastructure remain separate and are not included here.

## Development principles

- Keep self-hosted instance data separate from Guilded's official services.
- Never add production credentials or private infrastructure configuration to this repository.
- Version-control schema changes and migrations so self-hosters can create and update their own databases.
- Validate input and enforce authorization on every protected operation before adding user-facing features.

## License

Guilded Backend is licensed under the GNU General Public License v3.0. See [LICENSE](./LICENSE).

GPL-3.0 applies to this repository's licensed source code. It does not grant rights to Guilded Studios trademarks, branding, hosted services, private databases, or separately maintained proprietary components.

# AGENTS.md

## Project

BardBoard is a Discord soundboard with a browser UI. The bot/API uses Express 5,
discord.js 14, and `@discordjs/voice`; the UI uses Next.js 16 App Router and
React 19. Node.js 24 is required.

## Layout

- `server/app.js` — Express app, authentication/session middleware, Discord client,
  API routes, and graceful startup/shutdown.
- `server/services/discordAudio.js` — per-guild playback state, queues, voice
  connections, and FFmpeg processing.
- `server/routes/` — audio, playlist, and file/category API route factories.
- `server/middleware/upload.js` — multipart upload handling.
- `server/utils/` — environment configuration, path safety, and validation.
- `server/docs/openapi.js` — OpenAPI document served at `/api-docs.json`.
- `app/` — Next.js App Router pages and client components.
- `app/lib/soundboardApi.mjs` — frontend API client and response handling.
- `test/` — `node --test` unit, API, and process-lifecycle suites.
- `test-support/` — shared HTTP and Docker test helpers.
- `e2e/` — Playwright browser tests.
- `next.config.js` — rewrites `/api/*`, `/api-docs`, and `/api-docs.json` to
  `BACKEND_URL` (default `http://localhost:3001`).

## Commands

- `npm ci` — install exact dependencies.
- `npm run dev` — run the bot/API and Next.js dev server together.
- `npm run build` — create a production Next.js build.
- `npm start` — run the production bot/API and Next.js server together.
- `npm run lint` — run ESLint.
- `npm test` — run unit, API, and process-lifecycle tests.
- `npm run test:coverage` — run tests with coverage gates of 90% lines, 70%
  branches, and 85% functions.
- `npm run test:e2e` — build, then run Playwright against Chromium.
- `npm run test:docker` — run the Docker Compose smoke test.

Use `npm install` only when intentionally changing dependencies so
`package-lock.json` is updated.

After changes, run `npm run lint` and `npm test`. Run `npm run build` for
frontend or Next.js configuration changes. Playwright requires a one-time
`npx playwright install chromium`; the Docker smoke test requires Docker with
Compose.

## Configuration

- `server/app.js` calls `ensureEnvFile()`, then loads `.env` from
  `BARDBOARD_ENV_PATH` or the repository root.
- First-boot setup writes credentials to `.env`. The file is git-ignored; never
  commit tokens, passwords, session secrets, or generated configuration.
- `SESSION_SECRET` is generated when missing. Do not restore a hardcoded default.
- `SESSION_DIR` defaults to `sessions/`; audio files live in `audio-files/`.
- In Docker, `WEB_PORT`, `BOT_PORT`, `BACKEND_URL`, `UPLOAD_MAX_MB`, and
  `SESSION_DIR` come from the deployment environment and override persisted
  values. Bot credentials remain authoritative in the persisted config volume.
- `/health` is public. Other bot APIs require authentication unless no admin or
  readonly account is configured.

## Testing Notes

- Unit and API tests issue real HTTP requests to temporary Express servers and
  replace Discord voice primitives with in-memory doubles. They require no bot
  token, FFmpeg binary, or Discord connection.
- Playwright tests mock most Discord responses and require ports `3001` and
  `3100` to be free.
- Keep regression tests in the same commit as the fix they verify.
- The production lifecycle suite starts real server processes. Discord imports
  can be slow, so health checks wait up to 30 seconds.

## Code Conventions

- Server code uses CommonJS. Next.js app code uses client components and ESM
  imports.
- Follow the existing style, naming, and response shapes in neighboring files.
- Use `next/navigation` router navigation or `window.location.replace` for
  internal redirects. Avoid relative `window.location.href` assignments; the
  Next.js lint rule flags them.
- Route frontend API requests through `app/lib/soundboardApi.mjs`.
- Validate file paths and categories with `server/utils/path.js` and
  `server/utils/validation.js`.
- Do not add code comments unless they are necessary to explain non-obvious
  behavior.

## UI/UX

- Always research best practices for simple, intuitive dashboard web UI design before making UI/UX decisions.
- For voice-agent/dashboard interfaces prefer clear states (idle/connecting/playing), explicit affordances, stop/interrupt controls, error recovery, and confirmation for destructive actions.
- Use verb-noun CTAs that mirror the question/title, prefer accessible controls, and follow existing design patterns.

## Commits

Follow the [Capitalized Conventional Commits Dialect](https://gist.github.com/Akkitto/92154570147ba475e6bca70e709368ff).

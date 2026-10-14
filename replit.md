# Discord Voice Bot

A Node.js Discord bot that joins a server voice channel, plays the owner's intro audio, and plays owner-provided audio files.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm --filter @workspace/discord-voice-bot run dev` — run the Discord voice bot
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required secrets: `DISCORD_BOT_TOKEN` for the voice bot; `DATABASE_URL` for the API server

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `services/discord-voice-bot` — Discord bot commands and voice playback
- `services/discord-voice-bot/audio` — local audio files played by `/play`
- `artifacts/api-server` — shared API server
- `lib/api-spec/openapi.yaml` — API contract
- `lib/db/src/schema` — database schema

## Architecture decisions

- The voice bot is a separate worker package because it uses a persistent Discord gateway connection rather than HTTP routes.
- Audio playback uses local files and FFmpeg; the bot does not download or stream tracks from external services.
- The owner supplies `services/discord-voice-bot/audio/intro.mp3`; the bot uses the local file for voice-channel intros.

## Product

- The bot supports `/join`, `/play`, `/stop`, and `/leave` in Discord servers, with an intro when it joins or someone enters its voice channel.

## User preferences

_No additional user preferences recorded._

## Gotchas

- Invite the bot with both `bot` and `applications.commands` scopes and grant Connect and Speak permissions.
- Install FFmpeg in the environment running the bot.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details

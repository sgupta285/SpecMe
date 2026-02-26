# SpecMe

SpecMe is a web and desktop tool that converts product feedback into file-level implementation plans.

## Overview

The app lets you:

- connect a GitHub repository or local project folder
- index project files for context
- generate a structured implementation plan from feedback
- review proposed file changes and diffs
- apply changes, undo recent apply attempts, and push changes in GitHub mode

## Tech Stack

- React + TypeScript + Vite
- Tailwind + shadcn/ui
- Express (Node.js)
- Supabase (auth and data)
- Gemini API (`@google/generative-ai`)
- Electron
- Vitest + Testing Library

## Project Layout

```txt
SpecMe/
├── src/
│   ├── pages/
│   ├── components/
│   ├── integrations/supabase/
│   └── lib/
├── server/
│   ├── server.js
│   ├── dashboard.html
│   ├── codebase_context.txt      # generated
│   ├── active_project.json       # generated
│   ├── run_projects.json         # generated
│   ├── apply_sessions/           # generated
│   └── external_repos/           # generated for GitHub mode
├── supabase/
│   └── migrations/
├── main.cjs
└── package.json
```

## Prerequisites

- Node.js 18+
- npm
- Git
- Supabase project
- Gemini API key

## Environment Variables

Create `/.env.local`:

```env
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your_supabase_anon_key
VITE_API_URL=http://localhost:4000
```

Create `/server/.env.local`:

```env
GEMINI_API_KEY=your_gemini_api_key
FRONTEND_ORIGINS=http://localhost:5173,http://localhost:8080,http://localhost:8081
# Optional:
# GITHUB_TOKEN=ghp_...
# PORT=4000
# HOST=127.0.0.1
```

## Setup

```bash
npm install
```

Apply the Supabase migration in:

- `supabase/migrations/20260219045314_b417ecd5-1b45-431f-8af0-d10ffe4fbbc7.sql`

## Run

```bash
npm run dev       # frontend + backend
npm run dev:web   # frontend only
npm run server    # backend only
npm start         # frontend + backend + electron
```

## Scripts

- `npm run build`
- `npm run preview`
- `npm run lint`
- `npm run test`
- `npm run test:watch`

## API Endpoints

Base URL: `http://localhost:4000`

- `GET /`
- `GET /api/project`
- `GET /api/save-local-destination`
- `GET /api/project/history`
- `DELETE /api/project/history/:runId`
- `POST /api/project/disconnect`
- `POST /api/runs/project`
- `POST /api/runs/activate`
- `POST /api/save-local-changes`
- `GET /api/attempt/latest`
- `POST /api/attempt/start`
- `POST /api/attempt/undo`
- `POST /api/analyze`
- `POST /api/save`
- `POST /api/sync`
- `POST /api/push`

## Typical Workflow

1. Sign in.
2. Connect a project from the Sync page.
3. Submit feedback from the Upload page.
4. Review generated changes in Run Detail.
5. Apply selected files.
6. Undo if needed.
7. Push when working in GitHub mode.

## Notes

- The backend blocks writes to `.env*` files and lockfiles.
- GitHub mode uses safety branches for apply/push flows.
- Internal server state files are generated and gitignored.
- `package-lock.json` should be committed for reproducible installs.

## License

Private project.

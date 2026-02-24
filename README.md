# SpecMe — Feedback to Implementation

> Turn your customer feedback or bug report into a production-ready implementation plan.  
> Review exact files to change with side-by-side diffs, then apply updates in one click.

---

## Table of Contents

1. [What is SpecMe?](#what-is-specme)
2. [Architecture](#architecture)
3. [Project Structure](#project-structure)
4. [Tech Stack](#tech-stack)
5. [Prerequisites](#prerequisites)
6. [Environment Variables](#environment-variables)
7. [Getting Started](#getting-started)
8. [How It Works](#how-it-works)
9. [API Reference](#api-reference)
10. [Database Schema](#database-schema)
11. [What's Built vs. What's Next](#whats-built-vs-whats-next)
12. [Security](#security)

---

## What is SpecMe?

SpecMe helps you move from high-level feedback to concrete code changes faster.  
Instead of manually translating long transcripts or bug reports, you get a structured plan with file-level updates you can review and apply.

**Your workflow:**

```
Feedback / Bug Report
        ↓
  Gemini 2.5 Flash
  (reads full codebase context)
        ↓
  Technical Spec + Files to Change
  (with side-by-side diffs)
        ↓
  Human Reviews & Approves
        ↓
  Written directly to disk
  (on a new Git branch, automatically)
```

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        SpecMe v3.0                          │
│                                                             │
│  ┌───────────────┐     ┌─────────────────────────────────┐  │
│  │  Electron     │     │  Vite + React Frontend (src/)   │  │
│  │  Shell        │────▶│  Dashboard, Upload, RunDetail   │  │
│  │  (main.cjs)   │     │  Auth via Supabase              │  │
│  └───────────────┘     └──────────────┬──────────────────┘  │
│                                       │ fetch /api/*        │
│                        ┌─────────────▼──────────────────┐  │
│                        │  Express Backend (server.js)    │  │
│                        │  ├── GET  /          dashboard  │  │
│                        │  ├── POST /api/sync  re-index   │  │
│                        │  ├── POST /api/analyze  AI call │  │
│                        │  └── POST /api/save   write file│  │
│                        └─────────────┬──────────────────┘  │
│                                      │                      │
│              ┌───────────────────────┼────────────────┐    │
│              │                       │                │    │
│   ┌──────────▼───────┐  ┌────────────▼─────┐  ┌──────▼──┐ │
│   │  Gemini 2.5 Flash│  │  codebase_context│  │  Git    │ │
│   │  (Google AI API) │  │  .txt (local)    │  │  Safety │ │
│   └──────────────────┘  └──────────────────┘  └─────────┘ │
│                                                             │
│                    ┌────────────────────┐                  │
│                    │   Supabase (cloud) │                  │
│                    │  user_settings     │                  │
│                    │  feedback          │                  │
│                    │  runs              │                  │
│                    │  run_messages      │                  │
│                    └────────────────────┘                  │
└─────────────────────────────────────────────────────────────┘
```

---

## Project Structure

```
SpecMe/
├── main.cjs               # Electron shell entry point
├── package.json           # Master orchestrator — all deps merged
├── index.html             # Vite HTML entry
├── vite.config.ts         # Vite dev server (port 5173)
├── tailwind.config.ts     # Tailwind CSS theme
├── postcss.config.cjs     # PostCSS (Tailwind + Autoprefixer)
├── components.json        # shadcn/ui config
├── tsconfig.json          # TypeScript root config
├── tsconfig.app.json      # TypeScript app config
├── tsconfig.node.json     # TypeScript node config
├── eslint.config.js       # ESLint
├── vitest.config.ts       # Test runner config
├── .gitignore             # Ignores secrets, node_modules, context
├── .env.local             # Supabase keys (gitignored)
│
├── server/                # THE BRAIN — AI Architect Engine
│   ├── server.js          # Express API (analyze, save, sync)
│   ├── dashboard.html     # Standalone local diff UI (served on GET /)
│   ├── .env.local         # Gemini API key (gitignored)
│   └── codebase_context.txt  # AI knowledge base (gitignored, auto-generated)
│
├── src/                   # THE FACE — React Dashboard
│   ├── main.tsx           # React DOM entry
│   ├── App.tsx            # Router + providers
│   ├── index.css          # Tailwind base + design tokens
│   ├── vite-env.d.ts      # Vite type shims
│   │
│   ├── pages/
│   │   ├── Index.tsx      # Root redirect
│   │   ├── Login.tsx      # Email/password auth
│   │   ├── Dashboard.tsx  # Home — recent runs + quick actions
│   │   ├── Sync.tsx       # Link GitHub repo
│   │   ├── Upload.tsx     # Submit feedback → trigger AI run
│   │   ├── RunDetail.tsx  # View spec, diffs, apply changes
│   │   └── NotFound.tsx   # 404
│   │
│   ├── components/
│   │   ├── AppLayout.tsx  # Header + command bar + auth menu
│   │   ├── NavLink.tsx    # Router link wrapper
│   │   ├── ProtectedRoute.tsx  # Auth guard HOC
│   │   └── ui/            # 60+ shadcn/ui components (Radix-based)
│   │
│   ├── hooks/
│   │   ├── useAuth.ts     # Supabase session state
│   │   ├── use-toast.ts   # Toast notifications
│   │   └── use-mobile.tsx # Responsive breakpoint hook
│   │
│   ├── integrations/
│   │   └── supabase/
│   │       ├── client.ts  # Supabase client (reads .env.local)
│   │       └── types.ts   # Generated DB type definitions
│   │
│   ├── lib/
│   │   ├── utils.ts       # cn() Tailwind class merge utility
│   │   ├── sampleData.ts  # Sample feedback for demos
│   │   └── mockGenerator.ts  # Offline mock AI output (dev only)
│   │
│   └── test/
│       ├── setup.ts       # Vitest + jsdom setup
│       └── example.test.ts
│
└── supabase/
    └── migrations/
        └── *.sql          # Full schema: user_settings, feedback, runs, run_messages
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| **Desktop Shell** | Electron 33 |
| **Frontend** | React 18, TypeScript 5, Vite 5 |
| **UI Components** | shadcn/ui (Radix UI primitives) |
| **Styling** | Tailwind CSS 3, tailwindcss-animate |
| **Routing** | React Router DOM 6 |
| **State / Data** | TanStack React Query 5 |
| **Auth + DB** | Supabase (PostgreSQL + Row Level Security) |
| **Backend** | Node.js, Express 4 |
| **AI** | Google Gemini 2.5 Flash (`@google/generative-ai`) |
| **Diff Engine** | `diff` npm package → `createTwoFilesPatch` |
| **Diff UI** | `diff2html` (served in `dashboard.html`) |
| **Git Safety** | `execa` → `git checkout -b spec-me/<name>-<timestamp>` |
| **Testing** | Vitest 3, Testing Library React |

---

## Prerequisites

- **Node.js** ≥ 18
- **Git** (required for the Git Safety Layer — auto-branching before file writes)
- A **Google AI Studio** account → [Get a Gemini API key](https://aistudio.google.com/app/apikey)
- A **Supabase** project → [supabase.com](https://supabase.com)

---

## Environment Variables

### `/.env.local` — Frontend (Supabase)

```env
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your_supabase_anon_key
VITE_API_URL=http://localhost:4000
```

### `/server/.env.local` — Backend (Gemini)

```env
GEMINI_API_KEY=your_gemini_api_key
FRONTEND_ORIGINS=http://localhost:5173,http://localhost:8080
```

> ⚠️ **Never commit either `.env.local` file.** Both are listed in `.gitignore`.

---

## Getting Started

### 1. Clone & Install

```bash
git clone https://github.com/your-org/spec-me.git
cd spec-me
npm install
```

### 2. Set Up Environment Variables

```bash
# Root — Supabase keys
cp .env.example .env.local
# Edit .env.local with your Supabase URL and anon key

# Server — Gemini key
echo "GEMINI_API_KEY=your_key_here" > server/.env.local
```

---

## Copyright

© 2026 SpecMe. All rights reserved.

### 3. Apply the Supabase Schema

Run the migration in your Supabase dashboard SQL editor:

```bash
# Copy the contents of:
supabase/migrations/20260219045314_b417ecd5-1b45-431f-8af0-d10ffe4fbbc7.sql
```

Or use the Supabase CLI:

```bash
supabase db push
```

### 4. Run in Development (Web)

```bash
# Start Vite (port 5173) + Express (port 4000) together
npm run dev       # frontend only
npm run server    # backend only
# or both at once:
npm start         # also launches Electron
```

Then open: `http://localhost:5173`

### 5. Sync Your Codebase

In the React dashboard → **Sync GitHub** page, enter your repo URL.  
This triggers `POST /api/sync` which walks your project and writes `server/codebase_context.txt` — the AI's knowledge base.

Alternatively, open the local dashboard directly at `http://localhost:4000` and click **Sync Project Knowledge**.

### 6. Run as Desktop App (Electron)

```bash
npm start
# Launches: Vite dev server + Express backend + Electron window
```

---

## How It Works

### Step 1 — Sync Context
`POST /api/sync` recursively walks the project root, reads every `.ts`, `.tsx`, `.js`, `.jsx`, `.json`, `.sql`, `.css`, `.md`, `.html` file, and writes them all into `server/codebase_context.txt`. This is the AI's grounding document.

### Step 2 — Analyze
`POST /api/analyze` sends the full codebase context + user's feedback message to **Gemini 2.5 Flash**. The model returns a strict JSON object:

```json
{
  "summary": "...",
  "technical_rationale": "...",
  "project_type": "React + TypeScript",
  "risks": ["..."],
  "files_to_modify": [
    {
      "fileName": "src/pages/Upload.tsx",
      "explanation": "Why this file needs to change",
      "fullCode": "// complete file contents...",
      "diffPatch": "--- a/src/...\n+++ b/src/..."
    }
  ],
  "next_steps": ["npm install", "npm run dev"]
}
```

Each file also gets a `diffPatch` generated server-side via `createTwoFilesPatch`.

### Step 3 — Review
The React `RunDetail` page (or the standalone `dashboard.html`) displays:
- Executive Summary + Technical Rationale
- Risks + Next Steps
- Per-file **side-by-side diff** (green = additions, red = deletions)
- "Apply Selected" / "Apply All" buttons

### Step 4 — Apply (Git Safety)
`POST /api/save` writes the file to disk. **Before writing**, the server:
1. Stashes any dirty changes (`git stash save "Spec Me Auto-Stash"`)
2. Creates a new branch: `spec-me/<filename>-<timestamp>`
3. Writes the file

If anything goes wrong, the user can always return to main:
```bash
git checkout main
```

---

## API Reference

All endpoints are on `http://localhost:4000`.

### `GET /`
Serves the standalone `dashboard.html` diff UI. No auth required.

---

### `POST /api/sync`
Re-indexes the entire project into `server/codebase_context.txt`.

**Response:**
```json
{ "success": true, "message": "Context Re-Indexed (47 files)" }
```

---

### `POST /api/analyze`
Sends a request to Gemini and returns the full spec with diffs.

**Request body:**
```json
{ "message": "Add rate limiting to the WebSocket server" }
```

**Response:**
```json
{
  "success": true,
  "data": {
    "summary": "...",
    "technical_rationale": "...",
    "project_type": "Node.js + Express",
    "risks": ["..."],
    "files_to_modify": [{ "fileName": "...", "fullCode": "...", "diffPatch": "..." }],
    "next_steps": ["npm install express-rate-limit"]
  }
}
```

---

### `POST /api/save`
Writes a single file to disk, after creating a safety Git branch.

**Request body:**
```json
{ "fileName": "src/pages/Upload.tsx", "fullCode": "// full file content" }
```

**Response:**
```json
{
  "success": true,
  "message": "Applied to src/pages/Upload.tsx",
  "branch": "spec-me/upload.tsx-1708123456789"
}
```

**Protected paths** — the following will always be rejected:
- Any path containing `.env`
- Any path ending in `lock.json`
- Any path outside the project root (path traversal protection)

---

## Database Schema

### `user_settings`
| Column | Type | Notes |
|---|---|---|
| `user_id` | uuid PK | References `auth.users` |
| `repo_url` | text | GitHub URL |
| `repo_branch` | text | Default: `main` |
| `updated_at` | timestamptz | |

### `feedback`
| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `user_id` | uuid FK | References `auth.users` |
| `title` | text | |
| `content` | text | The transcript / bug report |
| `created_at` | timestamptz | |

### `runs`
| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `user_id` | uuid FK | |
| `feedback_id` | uuid FK | |
| `status` | text | `queued` / `running` / `done` / `error` |
| `spec_output` | jsonb | Full Gemini response |
| `error_message` | text | Set if status = error |
| `created_at` | timestamptz | |

### `run_messages`
| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `run_id` | uuid FK | |
| `user_id` | uuid FK | |
| `role` | text | `user` or `assistant` |
| `content` | text | Chat message text |
| `spec_output` | jsonb | Attached spec (assistant messages only) |
| `created_at` | timestamptz | |

All tables have **Row Level Security (RLS)** enabled — users can only read/write their own rows.

---

## What's Built vs. What's Next

### ✅ Built (Core Engine)
- [x] Gemini 2.5 Flash integration with full codebase context
- [x] Recursive codebase scanner (`/api/sync`)
- [x] Secure file writer with path traversal protection (`/api/save`)
- [x] Git Safety Layer — auto-branches before every write
- [x] Side-by-side diff viewer (React + standalone HTML)
- [x] Supabase auth, feedback, runs, conversation memory
- [x] Electron shell (double-click to launch)
- [x] Conversation thread with per-run message history

### 🔲 Roadmap
- [ ] **RAG / Vector Memory** — replace full-file context with ChromaDB/LanceDB semantic search (enables enterprise-scale repos with 1000s of files)
- [ ] **SSE Streaming** — stream `technical_rationale` word-by-word using Server-Sent Events
- [ ] **Closed-Loop Feedback** — Supabase Realtime trigger: user submits bug report → AI diff appears in dashboard within 30 seconds

---

## Security

- **API Keys** — `GEMINI_API_KEY` lives only in `server/.env.local` (gitignored, never sent to the frontend)
- **Supabase Anon Key** — safe for client-side use; all data access is gated by Row Level Security policies
- **Path Traversal** — `/api/save` resolves all paths with `path.resolve` and verifies the target is inside `PROJECT_ROOT` before writing
- **Protected Files** — `.env*` and `*lock.json` files are blocklisted and can never be overwritten by the AI
- **Git Isolation** — every write happens on a fresh `spec-me/*` branch; main/master is never directly modified
- **CORS** — only origins listed in `FRONTEND_ORIGINS` (+ Electron, which has no origin) can reach the backend

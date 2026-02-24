-- ============================================================
-- SpecMe — Live Database Schema
-- Matches the TypeScript types in src/integrations/supabase/types.ts
-- ============================================================

-- ──────────────────────────────────────────
-- USER SETTINGS (replaces the old projects table)
-- One row per user; stores repo url/branch for the AI context engine
-- ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.user_settings (
  user_id     uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  repo_url    text,
  repo_branch text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.user_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own settings"
  ON public.user_settings FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can upsert own settings"
  ON public.user_settings FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own settings"
  ON public.user_settings FOR UPDATE
  USING (auth.uid() = user_id);


-- ──────────────────────────────────────────
-- FEEDBACK
-- Stores user-submitted transcripts / bug reports
-- ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.feedback (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title       text NOT NULL,
  content     text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.feedback ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own feedback"
  ON public.feedback FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own feedback"
  ON public.feedback FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own feedback"
  ON public.feedback FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own feedback"
  ON public.feedback FOR DELETE
  USING (auth.uid() = user_id);


-- ──────────────────────────────────────────
-- RUNS
-- Each run = one AI analysis execution
-- spec_output holds the full JSON from Gemini
-- ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  feedback_id   uuid NOT NULL REFERENCES public.feedback(id) ON DELETE CASCADE,
  status        text NOT NULL DEFAULT 'queued',
  spec_output   jsonb,
  error_message text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own runs"
  ON public.runs FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own runs"
  ON public.runs FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own runs"
  ON public.runs FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own runs"
  ON public.runs FOR DELETE
  USING (auth.uid() = user_id);


-- ──────────────────────────────────────────
-- RUN MESSAGES (Conversation Memory / Thread)
-- Persists the back-and-forth between user and AI per run
-- ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.run_messages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id      uuid NOT NULL REFERENCES public.runs(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role        text NOT NULL CHECK (role IN ('user', 'assistant')),
  content     text NOT NULL DEFAULT '',
  spec_output jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.run_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own run messages"
  ON public.run_messages FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own run messages"
  ON public.run_messages FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own run messages"
  ON public.run_messages FOR DELETE
  USING (auth.uid() = user_id);

interface MockOutput {
  result_files: { path: string; reason: string }[];
  result_spec: string;
  cursor_prompt: string;
}

export function generateMockOutput(
  feedbackTitle: string,
  feedbackContent: string,
  repoUrl: string
): MockOutput {
  const contentLower = feedbackContent.toLowerCase();

  const fileMap: { keywords: string[]; path: string; reason: string }[] = [
    { keywords: ["login", "auth", "sign in", "token", "credentials"], path: "src/auth/AuthProvider.tsx", reason: "Auth state management and token validation logic" },
    { keywords: ["login", "sign in", "password", "email"], path: "src/pages/Login.tsx", reason: "Login form UI and error messaging" },
    { keywords: ["auth", "token", "session", "persist"], path: "src/lib/session.ts", reason: "Session persistence and token refresh logic" },
    { keywords: ["api", "endpoint", "request", "fetch"], path: "src/api/client.ts", reason: "API client configuration and error handling" },
    { keywords: ["ui", "button", "component", "display"], path: "src/components/ui/Button.tsx", reason: "UI component styling and interaction states" },
    { keywords: ["error", "message", "toast", "notification"], path: "src/components/ErrorBoundary.tsx", reason: "Error boundary and user-facing error messages" },
    { keywords: ["database", "query", "data", "store"], path: "src/lib/database.ts", reason: "Database query layer and data access" },
    { keywords: ["route", "navigate", "redirect", "page"], path: "src/router/routes.ts", reason: "Route configuration and redirect logic" },
    { keywords: ["config", "env", "setting"], path: "src/config/index.ts", reason: "Application configuration and environment variables" },
    { keywords: ["test", "spec", "coverage"], path: "src/__tests__/auth.test.ts", reason: "Test coverage for authentication flows" },
  ];

  const matched = fileMap
    .map((f) => ({ ...f, score: f.keywords.filter((k) => contentLower.includes(k)).length }))
    .filter((f) => f.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);

  const result_files =
    matched.length >= 3
      ? matched.map((f) => ({ path: f.path, reason: f.reason }))
      : [
          { path: "src/auth/AuthProvider.tsx", reason: "Core authentication and session management" },
          { path: "src/pages/Login.tsx", reason: "Login page UI and form validation" },
          { path: "src/lib/session.ts", reason: "Session persistence layer" },
        ];

  const result_spec = `# Technical Spec: ${feedbackTitle}

## User Problem

${feedbackContent}

## Root Cause Analysis

Based on the reported issue, the problem likely stems from:
1. **Token validation failure** — The auth token is not being properly validated or refreshed on page load
2. **State persistence gap** — Auth state is lost between page refreshes due to missing session persistence
3. **Poor error UX** — Users see raw error codes instead of actionable messages

## Technical Fix

### 1. Fix Token Validation (\`${result_files[0].path}\`)
- Implement proper token refresh logic with retry mechanism
- Add error boundary for expired/invalid tokens
- Ensure auth state listener is initialized before route guards

### 2. Update Login Flow (\`${result_files[1].path}\`)
- Add clear, user-friendly error messages for common auth failures
- Implement loading states during authentication
- Add "Remember me" functionality for session persistence

### 3. Session Persistence (\`${result_files[2].path}\`)
- Store session tokens in secure httpOnly storage
- Implement token refresh before expiration
- Add fallback for corrupted session data

## Acceptance Criteria

- [ ] Users can log in without seeing "Token invalid" errors
- [ ] Auth state persists across page refreshes
- [ ] Clear error messages shown for invalid credentials
- [ ] No unnecessary redirects to /login when session is valid
- [ ] Loading state shown during authentication

## Implementation Plan

1. **Phase 1 (30min):** Fix token validation in \`${result_files[0].path}\`
2. **Phase 2 (20min):** Update error messaging in \`${result_files[1].path}\`
3. **Phase 3 (15min):** Implement session persistence in \`${result_files[2].path}\`
4. **Phase 4 (10min):** Add integration tests for the complete auth flow
`;

  const cursor_prompt = `Repository: ${repoUrl}

Fix the following issue: "${feedbackTitle}"

Context from customer feedback:
${feedbackContent}

Files to modify:
${result_files.map((f) => `- ${f.path}: ${f.reason}`).join("\n")}

Steps:
1. Open ${result_files[0].path} and fix the token validation logic. Ensure the auth state listener initializes before any route guards check authentication.
2. Open ${result_files[1].path} and update error messages to be user-friendly. Replace raw error codes with actionable messages like "Invalid email or password. Please try again."
3. Open ${result_files[2].path} and implement proper session persistence. Store tokens securely and add a refresh mechanism.
4. Test the complete login flow: enter credentials → verify no "Token invalid" error → refresh page → verify session persists.
5. Add error boundary to catch and display auth failures gracefully.`;

  return { result_files, result_spec, cursor_prompt };
}

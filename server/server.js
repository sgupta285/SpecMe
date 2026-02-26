import express from "express";
import dotenv from "dotenv";
import { GoogleGenerativeAI } from "@google/generative-ai";
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { fileURLToPath } from "url";
import cors from "cors";
import { createTwoFilesPatch } from "diff";
import { execa } from "execa";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, ".env.local") });

const app = express();
const PORT = Number(process.env.PORT || 4000);
const HOST = process.env.HOST || "127.0.0.1";
const NODE_ENV = process.env.NODE_ENV || "development";
const IS_PROD = NODE_ENV === "production";

const PROJECT_ROOT = path.resolve(__dirname, "..");
const CONTEXT_PATH = path.join(__dirname, "codebase_context.txt");
const ACTIVE_PROJECT_PATH = path.join(__dirname, "active_project.json");
const EXTERNAL_REPOS_ROOT = path.join(__dirname, "external_repos");
const APPLY_SESSIONS_ROOT = path.join(__dirname, "apply_sessions");
const RUN_PROJECTS_PATH = path.join(__dirname, "run_projects.json");
const LOCAL_SAVE_DESTINATIONS_PATH = path.join(__dirname, "local_save_destinations.json");

const GEMINI_API_KEY = process.env.GEMINI_API_KEY?.trim() || "";
if (!GEMINI_API_KEY) {
  console.warn("⚠️ GEMINI_API_KEY missing in server/.env.local. /api/analyze will fail until set.");
}

const allowedOrigins = (
  process.env.FRONTEND_ORIGINS ||
  "http://localhost:5173,http://localhost:8080,http://localhost:8081"
)
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

function parseOrigin(origin) {
  try {
    return new URL(origin);
  } catch {
    return null;
  }
}

function isPrivateLanHost(hostname) {
  if (!hostname) return false;
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") return true;
  if (hostname.endsWith(".local")) return true;
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true;
  const match172 = hostname.match(/^172\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
  if (match172) {
    const second = Number(match172[1]);
    if (second >= 16 && second <= 31) return true;
  }
  return false;
}

function isOriginAllowed(origin) {
  if (!origin) return true; // Electron / server-to-server
  if (allowedOrigins.includes(origin)) return true;
  const parsed = parseOrigin(origin);
  if (!parsed) return false;
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (!IS_PROD && isPrivateLanHost(parsed.hostname)) return true;
  return false;
}

function buildReconnectError(mode, error) {
  if (error?.code === "branch_selection_required") {
    return {
      code: "branch_selection_required",
      message: "Could not detect a default branch automatically. Select a branch manually and retry sync.",
      availableBranches: Array.isArray(error?.availableBranches) ? error.availableBranches : [],
    };
  }

  if (error?.code === "branch_missing") {
    return {
      code: "branch_missing",
      message: error.message || "Branch not found on remote. Select or type a valid branch and retry sync.",
      availableBranches: Array.isArray(error?.availableBranches) ? error.availableBranches : [],
    };
  }

  if (error?.code === "head_invalid") {
    return {
      code: "head_invalid",
      message: error.message || "Repository state is invalid or no branch is checked out.",
      availableBranches: [],
    };
  }

  const raw = `${error?.shortMessage || ""}\n${error?.stderr || ""}\n${error?.message || ""}`.toLowerCase();
  if (mode === "github") {
    if (raw.includes("repository not found")) {
      return { code: "repo_not_found", message: "Repository not found. Verify repo URL and access rights." };
    }
    if (raw.includes("authentication failed") || raw.includes("permission denied") || raw.includes("could not read from remote repository")) {
      return { code: "auth_failed", message: "Authentication failed. Check GitHub token/SSH access and repo permissions." };
    }
    if (raw.includes("could not resolve host") || raw.includes("network") || raw.includes("timed out")) {
      return { code: "network_error", message: "Network error while reaching GitHub. Check internet/VPN and retry." };
    }
    if (raw.includes("remote branch") && raw.includes("not found")) {
      return { code: "branch_missing", message: "Branch not found on remote. Verify branch name and retry." };
    }
    if (raw.includes("is not a commit") || raw.includes("cannot be created from it")) {
      return { code: "branch_missing", message: "Branch not found on remote. Select a valid branch and retry sync." };
    }
    return { code: "github_sync_failed", message: error?.message || "GitHub sync failed." };
  }

  if (mode === "local") {
    if (raw.includes("no such file") || raw.includes("not found")) {
      return { code: "folder_missing", message: "Local folder not found. It may have been moved or deleted." };
    }
    if (raw.includes("eacces") || raw.includes("permission")) {
      return { code: "permission_denied", message: "Permission denied for local folder. Grant access and retry." };
    }
    return { code: "local_reconnect_failed", message: error?.message || "Local project reconnect failed." };
  }

  return { code: "connection_failed", message: error?.message || "Connection failed." };
}

function reconnectNextSteps(reasonCode) {
  if (reasonCode === "repo_not_found") {
    return "Check repository URL and confirm your account has access.";
  }
  if (reasonCode === "auth_failed") {
    return "Reconnect GitHub with valid credentials and required token scopes.";
  }
  if (reasonCode === "network_error") {
    return "Check internet/VPN settings and retry sync.";
  }
  if (reasonCode === "branch_missing" || reasonCode === "branch_selection_required") {
    return "Select a valid existing branch and retry sync.";
  }
  if (reasonCode === "permission_denied") {
    return "Grant folder access permissions or select a different local folder.";
  }
  if (reasonCode === "folder_missing") {
    return "Verify the local folder path still exists and reconnect.";
  }
  if (reasonCode === "head_invalid") {
    return "Choose a branch manually or make sure the repository has at least one commit.";
  }
  return "Reconnect from Sync and retry.";
}

function makeBranchSelectionError(availableBranches = []) {
  const err = new Error("Could not detect a usable default branch.");
  err.code = "branch_selection_required";
  err.availableBranches = availableBranches;
  return err;
}

function makeBranchMissingError(branchName, availableBranches = []) {
  const err = new Error(`Branch '${branchName}' was not found on remote.`);
  err.code = "branch_missing";
  err.availableBranches = availableBranches;
  return err;
}

async function getStoredBranchHints(repoUrl) {
  const hints = new Set();
  const normalizedRepo = redactRepoUrl(repoUrl);

  try {
    const active = await loadActiveProject();
    if (
      active?.mode === "github" &&
      active?.repoUrl &&
      redactRepoUrl(active.repoUrl) === normalizedRepo &&
      active?.branch?.trim()
    ) {
      hints.add(active.branch.trim());
    }
  } catch {
    // Ignore.
  }

  try {
    const map = await loadRunProjectsMap();
    for (const meta of Object.values(map || {})) {
      if (
        meta?.projectType === "github" &&
        meta?.repoUrl &&
        redactRepoUrl(meta.repoUrl) === normalizedRepo &&
        meta?.branch?.trim()
      ) {
        hints.add(meta.branch.trim());
      }
    }
  } catch {
    // Ignore.
  }

  return [...hints];
}

function makeHeadInvalidError(detail = "") {
  const msg = detail
    ? `Repository state is invalid: ${detail}. The repository may be empty or have no commits yet.`
    : "Repository state is invalid or no branch is checked out. The repository may be empty or have no commits yet.";
  const err = new Error(msg);
  err.code = "head_invalid";
  return err;
}

function extractPushExactReason(pushError) {
  const stderrLines = `${pushError?.stderr || ""}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const useful = stderrLines.find((line) => {
    const lower = line.toLowerCase();
    if (lower.startsWith("error:")) return false;
    if (lower.startsWith("fatal:")) return false;
    if (lower.startsWith("to ")) return false;
    if (lower.startsWith("remote:")) return true;
    return true;
  });
  if (!useful) return "";
  return useful.replace(/^remote:\s*/i, "").trim();
}

function classifyPushFailure(pushError) {
  const rawFull = `${pushError?.shortMessage || ""}\n${pushError?.stderr || ""}\n${pushError?.message || ""}`;
  const raw = rawFull.toLowerCase();
  const exactReason = extractPushExactReason(pushError);
  const result = {
    reason: "push_failed",
    reasonMessage: "Push to GitHub failed.",
    nextSteps: "Retry the push. If it keeps failing, review repository permissions and branch rules.",
    exactReason: exactReason || "",
  };

  if (raw.includes("src refspec") || raw.includes("does not match any")) {
    result.reason = "local_branch_missing";
    result.reasonMessage = "Local branch reference is missing or invalid.";
    result.nextSteps = "Check out the correct branch locally, then retry the push.";
    return result;
  }
  if (raw.includes("unknown revision") || raw.includes("ambiguous argument 'head'")) {
    result.reason = "head_invalid";
    result.reasonMessage = "Repository HEAD is invalid.";
    result.nextSteps = "Ensure the repository has a valid commit history and checked-out branch.";
    return result;
  }
  if (raw.includes("repository not found")) {
    result.reason = "repo_not_found";
    result.reasonMessage = "Repository not found.";
    result.nextSteps = "Verify the repository URL, ownership, and that your account can access it.";
    return result;
  }
  if (
    raw.includes("authentication failed") ||
    raw.includes("invalid username or password") ||
    raw.includes("could not read username") ||
    raw.includes("token expired") ||
    raw.includes("bad credentials")
  ) {
    result.reason = "auth_failed";
    result.reasonMessage = "Authentication failed.";
    result.nextSteps = "Sign in again or update your GitHub token/SSH credentials, then retry.";
    return result;
  }
  if (
    raw.includes("permission denied") ||
    raw.includes("403") ||
    raw.includes("access denied") ||
    raw.includes("write access to repository not granted")
  ) {
    result.reason = "permission_denied";
    result.reasonMessage = "You do not have permission to push to this repository.";
    result.nextSteps = "Check repository access rights, token scopes, and organization permissions.";
    return result;
  }
  if (
    raw.includes("protected branch") ||
    raw.includes("protected branch hook declined") ||
    raw.includes("gh006") ||
    raw.includes("remote rejected")
  ) {
    result.reason = "remote_rejected";
    result.reasonMessage = "GitHub rejected the push due to branch protection or repository rules.";
    result.nextSteps = "Push to a feature branch and open a pull request, or adjust branch protection settings.";
    return result;
  }
  if (raw.includes("non-fast-forward") || raw.includes("fetch first")) {
    result.reason = "non_fast_forward";
    result.reasonMessage = "Remote branch has new commits and rejected a non-fast-forward push.";
    result.nextSteps = "Pull/rebase the latest changes, resolve conflicts if needed, then push again.";
    return result;
  }
  if (
    raw.includes("could not resolve host") ||
    raw.includes("timed out") ||
    raw.includes("failed to connect") ||
    raw.includes("network is unreachable")
  ) {
    result.reason = "network_error";
    result.reasonMessage = "Network error while trying to reach GitHub.";
    result.nextSteps = "Check your internet/VPN/proxy connection and retry the push.";
    return result;
  }

  return result;
}

function classifyLocalSaveError(error) {
  const raw = `${error?.code || ""}\n${error?.message || ""}`.toLowerCase();
  const result = {
    reason: "save_local_failed",
    reasonMessage: "Saving changes to the selected folder failed.",
    exactReason: error?.message || "Unable to write files to destination folder.",
    nextSteps: "Choose a different folder path and make sure the app has write access.",
    technicalDetails: `${error?.code || "unknown"}\n${error?.message || ""}`.trim(),
  };

  if (raw.includes("eacces") || raw.includes("eperm") || raw.includes("permission denied")) {
    result.reason = "permission_denied";
    result.reasonMessage = "Permission denied for the selected folder.";
    result.nextSteps =
      "Grant folder access permissions, pick another writable folder, then try again.";
    return result;
  }
  if (raw.includes("enoent") || raw.includes("no such file or directory")) {
    result.reason = "path_not_found";
    result.reasonMessage = "Destination folder path was not found.";
    result.nextSteps = "Verify the destination path exists or create a new folder and retry.";
    return result;
  }

  return result;
}

function classifyAnalyzeError(error) {
  const rawFull = `${error?.status || ""}\n${error?.message || ""}\n${error?.response?.text || ""}`;
  const raw = rawFull.toLowerCase();
  const result = {
    reason: "analyze_failed",
    reasonMessage: "Spec generation failed.",
    exactReason: error?.message || "The AI request could not be completed.",
    nextSteps: "Retry generation. If this continues, verify API configuration and connectivity.",
    technicalDetails: rawFull.trim(),
  };

  if (raw.includes("429") || raw.includes("rate limit") || raw.includes("quota")) {
    result.reason = "gemini_rate_limited";
    result.reasonMessage = "The AI service rate limit was reached.";
    result.nextSteps = "Wait a minute and retry, or increase your Gemini quota limits.";
    return result;
  }
  if (
    raw.includes("404") ||
    raw.includes("model not found") ||
    (raw.includes("models/") && raw.includes("not found"))
  ) {
    result.reason = "gemini_model_not_found";
    result.reasonMessage = "The configured Gemini model was not found.";
    result.nextSteps = "Update the model name in server configuration and retry.";
    return result;
  }
  if (
    raw.includes("could not resolve host") ||
    raw.includes("network") ||
    raw.includes("timed out") ||
    raw.includes("econnrefused")
  ) {
    result.reason = "network_error";
    result.reasonMessage = "Network error while contacting the AI service.";
    result.nextSteps = "Check internet or VPN connection, then retry generation.";
    return result;
  }

  return result;
}

function extractJsonErrorPosition(message) {
  const match = `${message || ""}`.match(/position\s+(\d+)/i);
  if (!match) return null;
  const position = Number(match[1]);
  return Number.isFinite(position) ? position : null;
}

function extractJsonPayload(raw) {
  const text = `${raw || ""}`.trim();
  if (!text) return "";

  const firstObj = text.indexOf("{");
  const firstArr = text.indexOf("[");
  const first =
    firstObj >= 0 && firstArr >= 0 ? Math.min(firstObj, firstArr) : Math.max(firstObj, firstArr);
  const lastObj = text.lastIndexOf("}");
  const lastArr = text.lastIndexOf("]");
  const last = Math.max(lastObj, lastArr);
  if (first < 0 || last < 0 || last <= first) return text;
  return text.slice(first, last + 1).trim();
}

function tryParseJsonLenient(raw, contextLabel = "JSON") {
  const candidates = [];
  const trimmed = `${raw || ""}`.replace(/^\uFEFF/, "").trim();
  if (trimmed) candidates.push(trimmed);
  const extracted = extractJsonPayload(trimmed);
  if (extracted && !candidates.includes(extracted)) candidates.push(extracted);

  let lastError = `${contextLabel} is empty.`;
  for (const candidate of candidates) {
    try {
      return { ok: true, value: JSON.parse(candidate) };
    } catch (error) {
      lastError = error?.message || String(error);
    }
  }

  const position = extractJsonErrorPosition(lastError);
  const sampleBase = candidates[0] || trimmed;
  const snippet =
    position !== null && Number.isFinite(position)
      ? `\nAround position ${position}:\n${sampleBase.slice(Math.max(0, position - 80), Math.min(sampleBase.length, position + 80))}`
      : "";
  return {
    ok: false,
    error: `Invalid ${contextLabel}${position !== null ? ` at position ${position}` : ""}: ${lastError}${snippet}`,
  };
}

function toStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => (typeof v === "string" ? v : v == null ? "" : String(v)))
    .map((v) => v.trim())
    .filter(Boolean);
}

function normalizeAnalyzeDataSchema(value) {
  const root = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const filesRaw = Array.isArray(root.files_to_modify) ? root.files_to_modify : [];
  const files = [];
  for (const file of filesRaw) {
    if (!file || typeof file !== "object" || Array.isArray(file)) continue;
    const fileName = `${file.fileName ?? ""}`.trim();
    const fullCode = file.fullCode == null ? "" : String(file.fullCode);
    if (!fileName) continue;
    files.push({
      fileName,
      explanation: file.explanation == null ? "" : String(file.explanation),
      fullCode,
    });
  }

  return {
    summary: `${root.summary ?? ""}`.trim() || "Generated update plan.",
    technical_rationale: `${root.technical_rationale ?? ""}`.trim(),
    project_type: `${root.project_type ?? ""}`.trim(),
    risks: toStringArray(root.risks),
    files_to_modify: files,
    next_steps: toStringArray(root.next_steps),
  };
}

function validateAnalyzeDataSchema(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { valid: false, reason: "Root JSON must be an object." };
  }
  if (!Array.isArray(value.files_to_modify)) {
    return { valid: false, reason: "files_to_modify must be an array." };
  }
  for (const file of value.files_to_modify) {
    if (!file || typeof file !== "object" || Array.isArray(file)) {
      return { valid: false, reason: "Each files_to_modify entry must be an object." };
    }
    if (typeof file.fileName !== "string" || !file.fileName.trim()) {
      return { valid: false, reason: "Each files_to_modify entry requires fileName." };
    }
    if (typeof file.fullCode !== "string") {
      return { valid: false, reason: "Each files_to_modify entry requires fullCode string." };
    }
  }
  return { valid: true, reason: "" };
}

function buildRepairPrompt(rawText, parseOrSchemaError) {
  return (
    "Return ONLY valid JSON for this schema: " +
    '{"summary":"string","technical_rationale":"string","project_type":"string","risks":["string"],' +
    '"files_to_modify":[{"fileName":"string","explanation":"string","fullCode":"string"}],"next_steps":["string"]}.\n' +
    "Rules: no markdown, no comments, no trailing commas, escape all quotes/backslashes/newlines correctly.\n" +
    `Error to fix: ${parseOrSchemaError}\n` +
    `Text to repair:\n${rawText}`
  );
}

async function buildGuaranteedAnalyzeData(model, userMessage, rawModelText) {
  const maxAttempts = 4;
  let currentText = `${rawModelText || ""}`;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const parsed = tryParseJsonLenient(currentText, "model JSON output");
    if (parsed.ok) {
      const normalized = normalizeAnalyzeDataSchema(parsed.value);
      const validation = validateAnalyzeDataSchema(normalized);
      if (validation.valid) {
        return normalized;
      }
      currentText = JSON.stringify(normalized, null, 2);
      continue;
    }

    if (attempt < maxAttempts) {
      const repairPrompt = buildRepairPrompt(currentText, parsed.error);
      const repairResult = await model.generateContent(repairPrompt);
      currentText = `${repairResult.response.text() || ""}`;
    }
  }

  // Guaranteed-valid fallback object to prevent user-visible JSON failures.
  return {
    summary: "Generated update plan.",
    technical_rationale: "",
    project_type: "",
    risks: [],
    files_to_modify: [],
    next_steps: ["Retry generation for a richer plan if needed."],
  };
}

const corsDelegate = (req, callback) => {
  const origin = req.header("Origin");
  const allowed = isOriginAllowed(origin);
  callback(null, {
    origin: allowed ? (origin || true) : false,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    optionsSuccessStatus: 204,
  });
};

app.use((req, res, next) => {
  const origin = req.header("Origin");
  if (origin && !isOriginAllowed(origin)) {
    return res.status(403).json({
      success: false,
      error: `CORS blocked: ${origin}`,
      reason: "origin_not_allowed",
      reasonMessage: "This app origin is not allowed by backend CORS policy.",
      exactReason: `CORS blocked: ${origin}`,
      nextSteps:
        "Allow this frontend origin in FRONTEND_ORIGINS, restart the server, then retry.",
      technicalDetails: `Origin header: ${origin}`,
    });
  }
  return next();
});
app.use(cors(corsDelegate));
app.options("*", cors(corsDelegate));
app.use(express.json({ limit: "100mb" }));

const genAI = GEMINI_API_KEY ? new GoogleGenerativeAI(GEMINI_API_KEY) : null;

const SYSTEM_PROMPT = `
You are Spec Me, an Elite AI Technical Lead and Autonomous System Architect.
You analyze the provided codebase context and provide high-fidelity, production-ready solutions.

STRICT CONSTRAINTS:
1. GROUNDING: Use the project's existing stack: Vite, React, TypeScript, Tailwind, shadcn/ui, and Supabase.
2. ATOMIC GENERATION: Return the COMPLETE source code for every file. No ellipses ("...") or "// rest of code".
3. PATH SAFETY: You may modify any file path inside the currently connected project root. Never target paths outside that root.
4. OUTPUT: Return ONLY a valid JSON object — no markdown fences, no preamble.

SCHEMA:
{
  "summary": "High-level fix description",
  "technical_rationale": "Deep-dive architectural choices",
  "project_type": "Detected framework/language",
  "risks": ["Performance or security risks"],
  "files_to_modify": [
    { "fileName": "README.md", "explanation": "Why this change?", "fullCode": "Complete code" }
  ],
  "next_steps": ["Terminal commands to run"]
}`;

const toPosix = (p) => p.split(path.sep).join("/");

const defaultActiveProject = () => ({
  mode: "workspace",
  root: PROJECT_ROOT,
  source: "workspace",
  repoUrl: null,
  branch: null,
  connectionStatus: "disconnected",
  lastConnectionError: null,
});

async function loadActiveProject() {
  try {
    const raw = await fs.readFile(ACTIVE_PROJECT_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    // Allow empty root for failed state (don't reset to default)
    if (parsed?.connectionStatus === "failed") {
      return {
        mode: parsed.mode || "workspace",
        root: parsed.root || "",
        source: parsed.source || "workspace",
        repoUrl: parsed.repoUrl ?? null,
        branch: parsed.branch ?? null,
        connectionStatus: "failed",
        lastConnectionError: parsed.lastConnectionError ?? null,
      };
    }
    if (!parsed?.root || typeof parsed.root !== "string") return defaultActiveProject();
    return {
      mode: parsed.mode || "workspace",
      root: parsed.root,
      source: parsed.source || "workspace",
      repoUrl: parsed.repoUrl ?? null,
      branch: parsed.branch ?? null,
      connectionStatus: parsed.connectionStatus || (parsed.mode && parsed.mode !== "workspace" ? "connected" : "disconnected"),
      lastConnectionError: parsed.lastConnectionError ?? null,
    };
  } catch {
    return defaultActiveProject();
  }
}

async function saveActiveProject(project) {
  await fs.writeFile(ACTIVE_PROJECT_PATH, JSON.stringify(project, null, 2), "utf-8");
}

async function loadRunProjectsMap() {
  try {
    const raw = await fs.readFile(RUN_PROJECTS_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return parsed;
  } catch {
    return {};
  }
}

async function saveRunProjectsMap(map) {
  await fs.writeFile(RUN_PROJECTS_PATH, JSON.stringify(map, null, 2), "utf-8");
}

async function loadLocalSaveDestinationsMap() {
  try {
    const raw = await fs.readFile(LOCAL_SAVE_DESTINATIONS_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return parsed;
  } catch {
    return {};
  }
}

async function saveLocalSaveDestinationsMap(map) {
  await fs.writeFile(LOCAL_SAVE_DESTINATIONS_PATH, JSON.stringify(map, null, 2), "utf-8");
}

async function canonicalizePath(inputPath) {
  const resolved = path.resolve(inputPath);
  try {
    return await fs.realpath(resolved);
  } catch {
    return resolved;
  }
}

async function getProjectDestinationKey(project) {
  if (!project?.mode) throw new Error("Project mode is missing.");
  if (project.mode === "github") {
    const repo = (project.repoUrl || "").trim();
    const branch = (project.branch || "").trim();
    if (!repo) throw new Error("GitHub project is missing repository URL.");
    return `github:${redactRepoUrl(repo)}#${branch || "<default>"}`;
  }
  if (project.mode === "local") {
    const root = (project.root || "").trim();
    if (!root) throw new Error("Local project is missing root folder.");
    const canonicalRoot = await canonicalizePath(root);
    return `local:${canonicalRoot}`;
  }
  throw new Error("No connected project. Connect a GitHub repository or local folder first.");
}

async function rememberLocalSaveDestination(project, destinationPath) {
  const key = await getProjectDestinationKey(project);
  const canonicalDestination = await canonicalizePath(destinationPath);
  const map = await loadLocalSaveDestinationsMap();
  map[key] = {
    destinationPath: canonicalDestination,
    updatedAt: new Date().toISOString(),
  };
  await saveLocalSaveDestinationsMap(map);
  return {
    key,
    destinationPath: canonicalDestination,
  };
}

async function getRememberedLocalSaveDestination(project) {
  const key = await getProjectDestinationKey(project);
  const map = await loadLocalSaveDestinationsMap();
  const entry = map[key];
  if (!entry?.destinationPath) {
    return {
      key,
      destinationPath: null,
      exists: false,
      missingReason: "",
    };
  }
  const destinationPath = path.resolve(entry.destinationPath);
  const stat = await fs.stat(destinationPath).catch(() => null);
  const exists = Boolean(stat && stat.isDirectory());
  return {
    key,
    destinationPath,
    exists,
    missingReason: exists
      ? ""
      : "Your previously saved destination folder no longer exists. Choose a new folder path.",
  };
}

function makeAttemptId() {
  return `attempt-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function getAttemptMetaPath(attemptId) {
  return path.join(APPLY_SESSIONS_ROOT, `${attemptId}.json`);
}

function getAttemptBackupDir(attemptId) {
  return path.join(APPLY_SESSIONS_ROOT, attemptId);
}

async function loadAttempt(attemptId) {
  const raw = await fs.readFile(getAttemptMetaPath(attemptId), "utf-8");
  return JSON.parse(raw);
}

async function saveAttempt(attempt) {
  await fs.mkdir(APPLY_SESSIONS_ROOT, { recursive: true });
  await fs.writeFile(getAttemptMetaPath(attempt.id), JSON.stringify(attempt, null, 2), "utf-8");
}

async function createApplyAttempt(project) {
  const id = makeAttemptId();
  const attempt = {
    id,
    status: "active",
    createdAt: new Date().toISOString(),
    projectRoot: project.root,
    projectMode: project.mode,
    source: project.source,
    files: [],
  };
  await saveAttempt(attempt);
  return attempt;
}

async function findLatestActiveAttempt(projectRoot) {
  await fs.mkdir(APPLY_SESSIONS_ROOT, { recursive: true });
  const entries = await fs.readdir(APPLY_SESSIONS_ROOT, { withFileTypes: true });
  const jsonFiles = entries.filter((e) => e.isFile() && e.name.endsWith(".json")).map((e) => e.name);
  let newest = null;
  for (const file of jsonFiles) {
    try {
      const raw = await fs.readFile(path.join(APPLY_SESSIONS_ROOT, file), "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed.status !== "active") continue;
      if (path.resolve(parsed.projectRoot) !== path.resolve(projectRoot)) continue;
      if (!newest || new Date(parsed.createdAt).getTime() > new Date(newest.createdAt).getTime()) {
        newest = parsed;
      }
    } catch {
      // Ignore invalid session file.
    }
  }
  return newest;
}

async function snapshotOriginalFile(attemptId, projectRoot, relativePath) {
  const attempt = await loadAttempt(attemptId);
  if (attempt.status !== "active") {
    throw new Error("Apply attempt is no longer active.");
  }
  if (path.resolve(attempt.projectRoot) !== path.resolve(projectRoot)) {
    throw new Error("Apply attempt belongs to a different project.");
  }

  const existing = attempt.files.find((f) => f.relativePath === relativePath);
  if (existing) return attempt;

  const { target } = resolvePathInRoot(projectRoot, relativePath);
  const existed = fsSync.existsSync(target);
  const backupFileName = `${attempt.files.length + 1}.bak`;
  const backupRelativePath = backupFileName;
  const backupDir = getAttemptBackupDir(attemptId);
  const backupPath = path.join(backupDir, backupFileName);
  await fs.mkdir(backupDir, { recursive: true });

  if (existed) {
    await fs.copyFile(target, backupPath);
  }

  attempt.files.push({
    relativePath,
    existed,
    backupRelativePath: existed ? backupRelativePath : null,
  });
  await saveAttempt(attempt);
  return attempt;
}

async function undoApplyAttempt(attemptId) {
  const attempt = await loadAttempt(attemptId);
  if (attempt.status !== "active") {
    return { restoredCount: 0, alreadyClosed: true };
  }

  const reversed = [...attempt.files].reverse();
  let restoredCount = 0;

  for (const fileEntry of reversed) {
    const { target } = resolvePathInRoot(attempt.projectRoot, fileEntry.relativePath);
    if (fileEntry.existed) {
      const backupPath = path.join(getAttemptBackupDir(attemptId), fileEntry.backupRelativePath);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(backupPath, target);
    } else {
      await fs.rm(target, { force: true });
    }
    restoredCount++;
  }

  attempt.status = "undone";
  attempt.undoneAt = new Date().toISOString();
  await saveAttempt(attempt);
  return { restoredCount, alreadyClosed: false };
}

const normalizeRelativePath = (relPath) => path.normalize(relPath).replace(/^([/\\])+/, "");

function isSameOrInsidePath(root, candidate) {
  const rootResolved = path.resolve(root);
  const candidateResolved = path.resolve(candidate);
  return (
    candidateResolved === rootResolved ||
    candidateResolved.startsWith(`${rootResolved}${path.sep}`)
  );
}

function getBlockedInternalRoots() {
  return [PROJECT_ROOT, EXTERNAL_REPOS_ROOT, APPLY_SESSIONS_ROOT, __dirname].map((p) =>
    path.resolve(p)
  );
}

function resolvePathInRoot(root, relPath) {
  const normalized = normalizeRelativePath(relPath);
  const target = path.resolve(root, normalized);
  const rootResolved = path.resolve(root);
  if (target !== rootResolved && !target.startsWith(`${rootResolved}${path.sep}`)) {
    throw new Error("Path Violation: target is outside selected project root.");
  }
  return { target, normalized };
}

function parseGithubRepoUrl(repoUrl) {
  const raw = repoUrl.trim();
  if (!raw) throw new Error("Repository URL is required.");

  // Supports SSH form: git@github.com:owner/repo(.git)
  const sshMatch = raw.match(/^git@github\.com:(.+)$/i);
  if (sshMatch?.[1]) {
    const repoPath = sshMatch[1].replace(/\.git$/i, "").replace(/^\/+/, "");
    if (!repoPath.includes("/")) throw new Error("Invalid GitHub SSH URL.");
    return {
      kind: "ssh",
      cloneUrl: raw,
      redactedUrl: `git@github.com:${repoPath}.git`,
      repoPath,
    };
  }

  const parsed = new URL(raw);
  const host = parsed.hostname.toLowerCase();
  if (host !== "github.com" && host !== "www.github.com") {
    throw new Error("Only github.com repository URLs are currently supported.");
  }
  const repoPath = parsed.pathname.replace(/^\/+/, "").replace(/\.git$/i, "");
  if (!repoPath.includes("/")) throw new Error("Invalid GitHub repository path.");
  return {
    kind: "https",
    cloneUrl: raw,
    redactedUrl: `https://github.com/${repoPath}.git`,
    repoPath,
  };
}

const redactRepoUrl = (repoUrl) => {
  try {
    return parseGithubRepoUrl(repoUrl).redactedUrl;
  } catch {
    return repoUrl;
  }
};

const sanitizeRepoSlug = (repoUrl) => {
  const parsed = parseGithubRepoUrl(repoUrl);
  return parsed.repoPath.replace(/[^a-zA-Z0-9/_-]/g, "-").replace(/\//g, "__");
};

const ensureGithubRepo = (repoUrl) => {
  parseGithubRepoUrl(repoUrl);
};

const withGithubCredentials = (repoUrl) => {
  const token = process.env.GITHUB_TOKEN?.trim();
  if (!token) return repoUrl;
  if (repoUrl.startsWith("git@github.com:")) return repoUrl;
  const parsed = new URL(repoUrl);
  if (parsed.username || parsed.password) return repoUrl;
  parsed.username = "x-access-token";
  parsed.password = token;
  return parsed.toString();
};

const runGit = async (args, options = {}) => {
  return execa("git", args, {
    ...options,
    env: {
      ...process.env,
      ...(options.env || {}),
      GIT_TERMINAL_PROMPT: "0",
    },
  });
};

async function ensureGitRepoRoot(root) {
  await runGit(["rev-parse", "--is-inside-work-tree"], { cwd: root });
}

async function isValidGitRepo(dir) {
  try {
    await runGit(["rev-parse", "--is-inside-work-tree"], { cwd: dir });
    return true;
  } catch {
    return false;
  }
}

async function hasValidHead(repoRoot) {
  try {
    await runGit(["rev-parse", "HEAD"], { cwd: repoRoot });
    return true;
  } catch {
    return false;
  }
}

async function getCurrentBranchName(repoRoot) {
  // Works on older Git versions too.
  try {
    const { stdout } = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repoRoot });
    const branch = stdout.trim();
    if (branch && branch !== "HEAD") return branch;
  } catch {
    // Ignore and fall through.
  }

  try {
    const { stdout } = await runGit(["symbolic-ref", "--short", "HEAD"], { cwd: repoRoot });
    const branch = stdout.trim();
    if (branch && branch !== "HEAD") return branch;
  } catch {
    // Ignore and fall through.
  }

  try {
    const { stdout } = await runGit(["branch"], { cwd: repoRoot });
    const activeLine = stdout
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.startsWith("* "));
    const branch = (activeLine || "").replace(/^\*\s+/, "").trim();
    if (branch && branch !== "HEAD" && !branch.startsWith("(HEAD detached")) return branch;
  } catch {
    // Ignore and return null.
  }

  return null;
}

async function getGitSyncStatus(repoRoot, branchHint = "") {
  await ensureGitRepoRoot(repoRoot);

  const headValid = await hasValidHead(repoRoot);

  let head = null;
  let branch = null;
  let porcelain = "";

  if (headValid) {
    const [headResult, branchResult, statusResult] = await Promise.all([
      runGit(["rev-parse", "HEAD"], { cwd: repoRoot }),
      runGit(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repoRoot }),
      runGit(["status", "--porcelain"], { cwd: repoRoot }),
    ]);
    head = headResult.stdout.trim();
    branch = branchResult.stdout.trim();
    porcelain = statusResult.stdout;
  } else {
    // Unborn HEAD: try to get the branch name from symbolic ref
    try {
      const { stdout } = await runGit(["symbolic-ref", "--short", "HEAD"], { cwd: repoRoot });
      branch = stdout.trim() || null;
    } catch {
      branch = null;
    }
    try {
      const { stdout } = await runGit(["status", "--porcelain"], { cwd: repoRoot });
      porcelain = stdout;
    } catch {
      porcelain = "";
    }
  }

  let ahead = null;
  let behind = null;
  const branchName = branchHint || branch || "";
  if (headValid && branchName && branchName !== "HEAD") {
    try {
      const { stdout } = await runGit(
        ["rev-list", "--left-right", "--count", `${branchName}...origin/${branchName}`],
        { cwd: repoRoot }
      );
      const [aheadRaw, behindRaw] = stdout.trim().split(/\s+/);
      ahead = Number(aheadRaw);
      behind = Number(behindRaw);
    } catch {
      ahead = null;
      behind = null;
    }
  }

  return {
    branch: branch || branchHint || null,
    head: head || null,
    dirty: Boolean((porcelain || "").trim()),
    ahead,
    behind,
    headValid,
  };
}

async function createSafetyBranch(repoRoot, fileName) {
  try {
    if (!(await isValidGitRepo(repoRoot))) {
      console.warn("⚠️ Git safety layer disabled: not a git repo at", repoRoot);
      return null;
    }

    const headValid = await hasValidHead(repoRoot);

    if (headValid) {
      const currentBranch = await getCurrentBranchName(repoRoot);
      if (currentBranch?.startsWith("spec-me/")) {
        return currentBranch;
      }
    }

    const timestamp = Date.now();
    const cleanFileName = path.basename(fileName).replace(/[^a-z0-9]/gi, "-").toLowerCase();
    const branchName = `spec-me/${cleanFileName}-${timestamp}`;

    if (headValid) {
      await runGit(["checkout", "-b", branchName], { cwd: repoRoot });
    } else {
      // Orphan branch for repos with no commits yet
      await runGit(["checkout", "--orphan", branchName], { cwd: repoRoot });
    }
    return branchName;
  } catch (error) {
    console.warn("⚠️ Git safety layer disabled:", error.message);
    return null;
  }
}

async function syncRemoteGithubRepo(repoUrl, repoBranch, branchHints = []) {
  ensureGithubRepo(repoUrl);

  const requestedBranch = repoBranch?.trim() || "";
  const knownBranchHints = [...new Set((branchHints || []).map((b) => (b || "").trim()).filter(Boolean))];
  const parsedRepo = parseGithubRepoUrl(repoUrl);
  const cloneUrl = withGithubCredentials(parsedRepo.cloneUrl);
  const slug = sanitizeRepoSlug(repoUrl);
  const repoDir = path.join(EXTERNAL_REPOS_ROOT, slug);
  await fs.mkdir(EXTERNAL_REPOS_ROOT, { recursive: true });

  const normalizeBranchList = (branches) =>
    [...new Set((branches || []).map((b) => (b || "").trim()).filter(Boolean))]
      .filter((b) => b !== "HEAD" && !b.startsWith("spec-me/"));

  const getRemoteBranchesFromLocal = async () => {
    const { stdout } = await runGit(
      ["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin"],
      { cwd: repoDir }
    );
    const branches = stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => s.replace(/^origin\//, ""))
      .filter((s) => s && s !== "HEAD");
    return normalizeBranchList(branches);
  };

  const getRemoteBranchesFromOrigin = async () => {
    const { stdout } = await runGit(["ls-remote", "--heads", "origin"], { cwd: repoDir });
    const branches = stdout
      .split("\n")
      .map((line) => {
        const match = line.match(/refs\/heads\/(.+)$/);
        return match?.[1]?.trim() || "";
      })
      .filter(Boolean);
    return normalizeBranchList(branches);
  };

  const remoteHasBranch = async (branchName) => {
    const clean = (branchName || "").trim();
    if (!clean) return false;
    try {
      const { stdout } = await runGit(["ls-remote", "--heads", "origin", `refs/heads/${clean}`], {
        cwd: repoDir,
      });
      return Boolean(stdout.trim());
    } catch {
      return false;
    }
  };

  const getRemoteBranches = async () => {
    const origin = await getRemoteBranchesFromOrigin().catch(() => []);
    if (origin.length > 0) return origin;
    return await getRemoteBranchesFromLocal().catch(() => []);
  };

  const resolveDefaultBranch = async () => {
    // 1) Try stored branch hints first.
    for (const hint of knownBranchHints) {
      if (await remoteHasBranch(hint)) {
        console.log(`  Branch detection step 1: using stored branch hint -> ${hint}`);
        return hint;
      }
    }

    // 2) Use current branch if HEAD is valid and remote has that branch.
    const headValid = await hasValidHead(repoDir);
    if (headValid) {
      try {
        const current = (await getCurrentBranchName(repoDir)) || "";
        if (current && current !== "HEAD" && (await remoteHasBranch(current))) {
          console.log(`  Branch detection step 2: using current branch -> ${current}`);
          return current;
        }
      } catch (err) {
        console.log(`  Branch detection step 2 (current branch): ${err.message || "failed"}`);
      }
    } else {
      console.log(`  Branch detection step 2: skipped (HEAD is invalid/unborn)`);
    }

    // 3) Try origin/HEAD symbolic ref if available.
    try {
      await runGit(["remote", "set-head", "origin", "-a"], { cwd: repoDir }).catch(() => {});
      const { stdout } = await runGit(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], {
        cwd: repoDir,
      });
      const match = stdout.trim().match(/^origin\/(.+)$/);
      if (match?.[1]) {
        console.log(`  Branch detection step 3: found origin/HEAD -> ${match[1]}`);
        return match[1];
      }
    } catch (err) {
      console.log(`  Branch detection step 3 (origin/HEAD): ${err.message || "failed"}`);
    }

    // 4) Try remote metadata: git ls-remote --symref origin HEAD
    try {
      const { stdout } = await runGit(["ls-remote", "--symref", "origin", "HEAD"], { cwd: repoDir });
      const line = stdout
        .split("\n")
        .find((l) => l.startsWith("ref: refs/heads/") && l.endsWith("\tHEAD"));
      if (line) {
        const branch = line.replace("ref: refs/heads/", "").replace(/\tHEAD$/, "").trim();
        if (branch) {
          console.log(`  Branch detection step 4: found via ls-remote -> ${branch}`);
          return branch;
        }
      }
    } catch (err) {
      console.log(`  Branch detection step 4 (ls-remote): ${err.message || "failed"}`);
    }

    // 5) Prefer origin/main then origin/master.
    if (await remoteHasBranch("main")) {
      console.log(`  Branch detection step 5: found main on remote`);
      return "main";
    }
    if (await remoteHasBranch("master")) {
      console.log(`  Branch detection step 5: found master on remote`);
      return "master";
    }

    // 6) Fallback to best match from authoritative remote branch list.
    const originBranches = await getRemoteBranchesFromOrigin().catch(() => []);
    if (originBranches.length === 1) {
      console.log(`  Branch detection step 6: using only remote branch -> ${originBranches[0]}`);
      return originBranches[0];
    }
    if (originBranches.length > 1) {
      const preferred = ["develop", "dev", "trunk", "release"];
      const pick = preferred.find((b) => originBranches.includes(b));
      if (pick) {
        console.log(`  Branch detection step 6: using preferred fallback branch -> ${pick}`);
        return pick;
      }
      console.log(`  Branch detection step 6: ambiguous default branch. Manual selection required.`);
      throw makeBranchSelectionError(originBranches);
    }

    const localBranches = await getRemoteBranchesFromLocal().catch(() => []);
    if (localBranches.length > 0) {
      console.log(`  Branch detection: origin list unavailable; offering local branch refs for manual selection.`);
      throw makeBranchSelectionError(localBranches);
    }

    console.log(`  Branch detection: all steps failed. Available remote branches: []`);
    throw makeBranchSelectionError([]);
  };

  const checkoutTrackedBranch = async (branchName) => {
    try {
      await runGit(
        [
          "fetch",
          "--prune",
          "--depth",
          "1",
          "origin",
          `+refs/heads/${branchName}:refs/remotes/origin/${branchName}`,
        ],
        { cwd: repoDir }
      );
    } catch (error) {
      const raw = `${error?.shortMessage || ""}\n${error?.stderr || ""}\n${error?.message || ""}`.toLowerCase();
      if (raw.includes("couldn't find remote ref") || raw.includes("remote branch") || raw.includes("not found")) {
        throw makeBranchMissingError(branchName, await getRemoteBranches());
      }
      throw error;
    }
    try {
      await runGit(["rev-parse", "--verify", `refs/remotes/origin/${branchName}`], { cwd: repoDir });
    } catch {
      throw makeBranchMissingError(branchName, await getRemoteBranches());
    }
    await runGit(["checkout", "-B", branchName, `origin/${branchName}`], { cwd: repoDir });
    return branchName;
  };

  if (!fsSync.existsSync(repoDir)) {
    try {
      if (requestedBranch) {
        await runGit(["clone", "--depth", "1", "--branch", requestedBranch, cloneUrl, repoDir], {
          cwd: PROJECT_ROOT,
        });
        const gitStatus = await getGitSyncStatus(repoDir, requestedBranch).catch(() => null);
        return { repoDir, branch: requestedBranch, gitStatus };
      }
      throw new Error("No branch requested; cloning default branch.");
    } catch (cloneErr) {
      // If requested branch clone failed, try default clone
      if (!fsSync.existsSync(repoDir)) {
        await runGit(["clone", "--depth", "1", cloneUrl, repoDir], { cwd: PROJECT_ROOT });
      }

      // After clone, detect branch safely (HEAD may be unborn for empty repos)
      let branch = "unknown";
      const headValid = await hasValidHead(repoDir);
      if (headValid) {
        try {
          const active = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repoDir });
          branch = active.stdout.trim() || "unknown";
        } catch {
          branch = "unknown";
        }
      } else {
        // Unborn HEAD: try symbolic-ref to get the configured branch name
        try {
          const { stdout } = await runGit(["symbolic-ref", "--short", "HEAD"], { cwd: repoDir });
          branch = stdout.trim() || "unknown";
        } catch {
          branch = "unknown";
        }
        console.log(`  Cloned repo has unborn HEAD (empty repo?). Branch: ${branch}`);
      }
      const gitStatus = await getGitSyncStatus(repoDir, branch).catch(() => null);
      return { repoDir, branch, gitStatus };
    }
  }

  // Validate existing repo; if corrupted, wipe and re-clone
  try {
    await ensureGitRepoRoot(repoDir);
    await runGit(["remote", "set-url", "origin", cloneUrl], { cwd: repoDir });
    await runGit(["fetch", "--all", "--prune"], { cwd: repoDir });
  } catch (existingRepoErr) {
    const errStr = `${existingRepoErr?.stderr || ""} ${existingRepoErr?.message || ""}`.toLowerCase();
    const isNetworkOrAuth =
      errStr.includes("authentication") ||
      errStr.includes("could not resolve") ||
      errStr.includes("permission denied") ||
      errStr.includes("timed out") ||
      errStr.includes("repository not found") ||
      errStr.includes("could not read from remote");
    if (isNetworkOrAuth) throw existingRepoErr;
    // Local corruption: wipe and re-clone
    console.log(`  Existing repo at ${repoDir} appears corrupted. Removing for fresh clone.`);
    await fs.rm(repoDir, { recursive: true, force: true });
    await runGit(["clone", "--depth", "1", cloneUrl, repoDir], { cwd: PROJECT_ROOT });
    await runGit(["remote", "set-url", "origin", cloneUrl], { cwd: repoDir });
    await runGit(["fetch", "--all", "--prune"], { cwd: repoDir });
  }

  // Check if remote has any branches at all (empty repo detection)
  const remoteBranches = await getRemoteBranches();
  if (remoteBranches.length === 0) {
    // Truly empty remote repo: no branches exist. Accept the current state.
    console.log("  Remote repo is empty (no branches). Accepting current local clone state.");
    let branch = requestedBranch || "main";
    try {
      const { stdout } = await runGit(["symbolic-ref", "--short", "HEAD"], { cwd: repoDir });
      if (stdout.trim()) branch = stdout.trim();
    } catch {
      // keep default
    }
    const gitStatus = await getGitSyncStatus(repoDir, branch).catch(() => null);
    return { repoDir, branch, gitStatus };
  }

  try {
    if (!requestedBranch) {
      throw new Error("No requested branch to check out directly.");
    }
    const checked = await checkoutTrackedBranch(requestedBranch);
    const gitStatus = await getGitSyncStatus(repoDir, checked).catch(() => null);
    return { repoDir, branch: checked, gitStatus };
  } catch (requestedErr) {
    if (requestedErr?.code === "branch_missing") {
      const branches = await getRemoteBranches();
      if (branches.length) {
        throw makeBranchSelectionError(branches);
      }
      throw requestedErr;
    }
    const defaultBranch = await resolveDefaultBranch().catch((err) => {
      if (err?.code === "branch_selection_required") {
        throw makeBranchSelectionError(remoteBranches);
      }
      throw err;
    });
    const checked = await checkoutTrackedBranch(defaultBranch);
    const gitStatus = await getGitSyncStatus(repoDir, checked).catch(() => null);
    return { repoDir, branch: checked, gitStatus };
  }
}

function normalizeProjectDescriptor(project) {
  return {
    mode: project.mode || "workspace",
    root: project.root,
    source: project.source || "workspace",
    repoUrl: project.repoUrl ?? null,
    branch: project.branch ?? null,
  };
}

function resolveOutputPath(baseRoot, relPath) {
  const normalized = normalizeRelativePath(relPath);
  const target = path.resolve(baseRoot, normalized);
  const rootResolved = path.resolve(baseRoot);
  if (target !== rootResolved && !target.startsWith(`${rootResolved}${path.sep}`)) {
    throw new Error(`Path violation for output file: ${relPath}`);
  }
  return { normalized, target };
}

function toDestinationRelativePath(filePath, projectRoot = "") {
  const raw = (filePath || "").toString().trim();
  if (!raw) throw new Error("Missing file path.");

  if (path.isAbsolute(raw)) {
    const absolute = path.resolve(raw);
    if (!projectRoot) {
      throw new Error(`Absolute file path is not allowed without an active project root: ${raw}`);
    }
    const resolvedProjectRoot = path.resolve(projectRoot);
    if (!isSameOrInsidePath(resolvedProjectRoot, absolute)) {
      throw new Error(`Absolute file path is outside active project root: ${raw}`);
    }
    const relativeFromProject = path.relative(resolvedProjectRoot, absolute);
    const normalized = normalizeRelativePath(relativeFromProject);
    if (!normalized) {
      throw new Error(`Refusing to write project root as a file: ${raw}`);
    }
    return normalized;
  }

  return normalizeRelativePath(raw);
}

function expandHomePath(inputPath) {
  const input = (inputPath || "").trim();
  const home = process.env.HOME || process.env.USERPROFILE || "";
  if (!home) return input;
  if (input === "~") return home;
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(home, input.slice(2));
  }
  return input;
}

function toProjectSnapshot(project, extras = {}) {
  return {
    projectType: project.mode || "workspace",
    repoUrl: project.repoUrl ?? null,
    branch: project.branch ?? null,
    workingCopyPath: project.mode === "github" ? project.root : null,
    localFolderPath: project.mode === "local" ? project.root : null,
    source: project.source || "workspace",
    connectionStatus:
      extras.connectionStatus ||
      project.connectionStatus ||
      (project.mode && project.mode !== "workspace" ? "connected" : "disconnected"),
    lastConnectionError: extras.lastConnectionError || project.lastConnectionError || null,
    lastOpenedAt: extras.lastOpenedAt || new Date().toISOString(),
    lastSyncAt: extras.lastSyncAt || new Date().toISOString(),
  };
}

function withConnectedState(project) {
  return {
    ...project,
    connectionStatus: "connected",
    lastConnectionError: null,
  };
}

function failedActiveProject(message) {
  return {
    mode: "workspace",
    root: "",
    source: "workspace",
    repoUrl: null,
    branch: null,
    connectionStatus: "failed",
    lastConnectionError: message,
  };
}

async function assertProjectReady(project) {
  if (!project || !project.mode) {
    throw new Error("No active project is selected. Connect a project first.");
  }
  if (project.connectionStatus === "failed") {
    throw new Error(project.lastConnectionError || "Project connection failed. Reconnect and retry.");
  }
  if (project.mode === "workspace") {
    throw new Error("No project connected. Connect a GitHub repository or local folder first.");
  }
  if (!project.root || !project.root.trim()) {
    throw new Error("No active project path. The project connection is invalid. Reconnect from Sync.");
  }
  const rootStat = await fs.stat(project.root).catch(() => null);
  if (!rootStat || !rootStat.isDirectory()) {
    throw new Error(`Project folder does not exist: ${project.root}. Reconnect and retry.`);
  }
  const projectRoot = path.resolve(project.root);
  if (project.mode === "local") {
    const blockedRoots = getBlockedInternalRoots();
    if (blockedRoots.some((blockedRoot) => isSameOrInsidePath(blockedRoot, projectRoot))) {
      throw new Error(
        "Selected project path points to SpecMe internal folders. " +
        "Reconnect using your target repository/folder outside the SpecMe app directory."
      );
    }
  }
  if (project.mode === "github") {
    const expectedRoot = path.resolve(EXTERNAL_REPOS_ROOT);
    if (projectRoot !== expectedRoot && !projectRoot.startsWith(`${expectedRoot}${path.sep}`)) {
      throw new Error(
        "GitHub mode active but project path is outside the managed GitHub working copies. " +
        "Reconnect the GitHub project from Sync."
      );
    }
    if (!(await isValidGitRepo(project.root))) {
      throw new Error(
        "GitHub mode active but target path is not a valid git repository. " +
        "This may indicate a project source mismatch. Reconnect the GitHub project from Sync."
      );
    }
  }
}

async function activateProjectDescriptor(descriptor) {
  const mode = descriptor?.mode || "workspace";
  if (mode === "github") {
    const repoUrl = descriptor?.repoUrl?.trim();
    const repoBranch = descriptor?.branch?.trim() || "";
    if (!repoUrl) throw new Error("Stored GitHub project is missing repository URL.");
    const synced = await syncRemoteGithubRepo(repoUrl, repoBranch);
    const project = withConnectedState({
      mode: "github",
      root: synced.repoDir,
      source: `github:${redactRepoUrl(repoUrl)}#${synced.branch}`,
      repoUrl: redactRepoUrl(repoUrl),
      branch: synced.branch,
    });
    await saveActiveProject(project);
    await buildContext(project.root, project.source);
    return project;
  }

  if (mode === "local") {
    const localPath = descriptor?.root?.trim();
    if (!localPath) throw new Error("Stored local project is missing folder path.");
    const localRoot = await resolveLocalProject(localPath);
    const project = withConnectedState({
      mode: "local",
      root: localRoot,
      source: `local:${localRoot}`,
      repoUrl: null,
      branch: null,
    });
    await saveActiveProject(project);
    await buildContext(project.root, project.source);
    return project;
  }

  const project = defaultActiveProject();
  await saveActiveProject(project);
  await buildContext(project.root, project.source);
  return project;
}

async function resolveLocalProject(localPath) {
  if (!localPath?.trim()) {
    throw new Error("localPath is required for local project sync.");
  }

  const input = localPath.trim();
  const absolute = path.isAbsolute(input) ? input : path.resolve(PROJECT_ROOT, input);
  const resolved = path.resolve(absolute);

  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    throw new Error(`Local project folder not found: ${resolved}`);
  }

  return resolved;
}

async function buildContext(syncRoot, sourceLabel) {
  // Guardrail: refuse to index if syncRoot is empty or missing
  if (!syncRoot || !syncRoot.trim()) {
    console.warn("⚠️ buildContext called with empty root, skipping indexing.");
    await fs.writeFile(CONTEXT_PATH, `--- SPEC ME DYNAMIC CONTEXT ---\nSOURCE: ${sourceLabel}\n\n(No project indexed - root path is empty)\n`, "utf-8");
    return { fileCount: 0, contextPath: CONTEXT_PATH };
  }
  const rootStat = await fs.stat(syncRoot).catch(() => null);
  if (!rootStat || !rootStat.isDirectory()) {
    console.warn(`⚠️ buildContext: root does not exist or is not a directory: ${syncRoot}`);
    await fs.writeFile(CONTEXT_PATH, `--- SPEC ME DYNAMIC CONTEXT ---\nSOURCE: ${sourceLabel}\n\n(No project indexed - path unavailable)\n`, "utf-8");
    return { fileCount: 0, contextPath: CONTEXT_PATH };
  }

  const EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".json", ".sql", ".css", ".md", ".html"]);
  const IGNORE = new Set([
    "node_modules",
    ".git",
    "dist",
    "external_repos",
    ".DS_Store",
    "package-lock.json",
    "codebase_context.txt",
  ]);

  let context = `--- SPEC ME DYNAMIC CONTEXT ---\nSOURCE: ${sourceLabel}\n\n`;
  let fileCount = 0;

  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (IGNORE.has(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      const rel = toPosix(path.relative(syncRoot, abs));

      if (entry.isDirectory()) {
        await walk(abs);
      } else if (EXTS.has(path.extname(entry.name))) {
        const content = await fs.readFile(abs, "utf-8");
        context += `\n--- FILE: ${rel} ---\n${content}\n`;
        fileCount++;
      }
    }
  }

  await walk(syncRoot);
  await fs.writeFile(CONTEXT_PATH, context, "utf-8");
  return { fileCount, contextPath: CONTEXT_PATH };
}

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "dashboard.html"));
});

app.get("/api/project", async (_req, res) => {
  try {
    const project = await loadActiveProject();
    res.json({ success: true, project });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/api/save-local-destination", async (_req, res) => {
  try {
    const activeProject = await loadActiveProject();
    await assertProjectReady(activeProject);
    const remembered = await getRememberedLocalSaveDestination(activeProject);
    res.json({
      success: true,
      destinationPath: remembered.destinationPath,
      exists: remembered.exists,
      missingReason: remembered.missingReason,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

app.get("/api/project/history", async (_req, res) => {
  try {
    const map = await loadRunProjectsMap();
    const entries = Object.entries(map)
      .map(([runId, meta]) => ({ runId, ...meta }))
      .sort((a, b) => new Date(b.lastOpenedAt || 0).getTime() - new Date(a.lastOpenedAt || 0).getTime());
    res.json({ success: true, projects: entries });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.delete("/api/project/history/:runId", async (req, res) => {
  try {
    const runId = req.params?.runId?.toString().trim();
    if (!runId) throw new Error("runId is required.");
    const map = await loadRunProjectsMap();
    if (!map[runId]) {
      return res.json({ success: true, deleted: false, message: "History item not found." });
    }
    delete map[runId];
    await saveRunProjectsMap(map);
    res.json({ success: true, deleted: true, runId });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post("/api/project/disconnect", async (_req, res) => {
  try {
    const project = defaultActiveProject();
    await saveActiveProject(project);
    const indexed = await buildContext(project.root, project.source);
    res.json({
      success: true,
      message: "Disconnected active project.",
      mode: project.mode,
      indexedRoot: project.root,
      fileCount: indexed.fileCount,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post("/api/runs/project", async (req, res) => {
  try {
    const runId = req.body?.runId?.toString().trim();
    if (!runId) throw new Error("runId is required.");

    const active = await loadActiveProject();
    await assertProjectReady(active);
    const map = await loadRunProjectsMap();
    map[runId] = {
      ...normalizeProjectDescriptor(active),
      ...toProjectSnapshot(active, {
        connectionStatus:
          active.connectionStatus || (active.mode !== "workspace" ? "connected" : "disconnected"),
      }),
    };
    await saveRunProjectsMap(map);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post("/api/runs/activate", async (req, res) => {
  try {
    const runId = req.body?.runId?.toString().trim();
    if (!runId) throw new Error("runId is required.");

    const map = await loadRunProjectsMap();
    const descriptor = map[runId];
    if (!descriptor) {
      return res.json({
        success: false,
        activated: false,
        reason: "missing_project_metadata",
        message: "No stored project mapping for this run. Reconnect manually from Sync.",
      });
    }

    try {
      const project = await activateProjectDescriptor(descriptor);
      map[runId] = {
        ...descriptor,
        ...normalizeProjectDescriptor(project),
        ...toProjectSnapshot(project, {
          connectionStatus: "connected",
          lastConnectionError: null,
          lastOpenedAt: new Date().toISOString(),
          lastSyncAt: new Date().toISOString(),
        }),
      };
      await saveRunProjectsMap(map);
      return res.json({ success: true, activated: true, project });
    } catch (activateErr) {
      const reason = buildReconnectError(descriptor.mode, activateErr);
      await saveActiveProject(failedActiveProject(reason.message));
      map[runId] = {
        ...descriptor,
        connectionStatus: "failed",
        lastConnectionError: reason.message,
        lastOpenedAt: new Date().toISOString(),
      };
      await saveRunProjectsMap(map);
      return res.json({
        success: false,
        activated: false,
        reason: reason.code,
        message: reason.message,
        availableBranches: reason.availableBranches || [],
        reconnectAction: "manual",
        retryable: true,
        reconnectManualHint: "Open Sync to reconnect this project manually.",
      });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post("/api/save-local-changes", async (req, res) => {
  try {
    const activeProject = await loadActiveProject();
    await assertProjectReady(activeProject);

    const destinationPathInput = req.body?.destinationPath?.toString().trim();
    const files = Array.isArray(req.body?.files) ? req.body.files : [];
    if (!destinationPathInput) throw new Error("destinationPath is required.");
    if (!files.length) throw new Error("No files provided.");

    const expandedDestination = expandHomePath(destinationPathInput);
    if (!path.isAbsolute(expandedDestination)) {
      throw new Error(
        "Destination path must be absolute. Select a destination folder explicitly (for example: /Users/you/Desktop/output)."
      );
    }
    const destinationRoot = path.resolve(expandedDestination);
    const blockedRoots = getBlockedInternalRoots();
    if (blockedRoots.some((blockedRoot) => isSameOrInsidePath(blockedRoot, destinationRoot))) {
      throw new Error(
        "Destination path cannot be SpecMe's app/internal folder. Choose a separate project/output directory."
      );
    }
    const activeProjectRoot = path.resolve(activeProject.root);

    await fs.mkdir(destinationRoot, { recursive: true });

    let written = 0;
    const results = [];
    const skipped = [];
    for (const f of files) {
      const fileName = f?.fileName?.toString?.() ?? "";
      const fullCode = f?.fullCode;
      if (!fileName || fullCode === undefined) {
        skipped.push({ fileName: fileName || "(missing)", reason: "Missing fileName or fullCode." });
        continue;
      }
      try {
        const relativeOutputPath = toDestinationRelativePath(fileName, activeProjectRoot);
        const { normalized, target } = resolveOutputPath(destinationRoot, relativeOutputPath);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, String(fullCode), "utf-8");
        written++;
        results.push({ fileName: normalized });
      } catch (fileError) {
        skipped.push({
          fileName,
          reason: fileError?.message || "Failed to write file.",
        });
      }
    }

    if (written === 0) {
      throw new Error(
        `No files were saved. ${skipped.length ? `First error: ${skipped[0].reason}` : "No valid files were provided."}`
      );
    }

    const remembered = await rememberLocalSaveDestination(activeProject, destinationRoot);

    res.json({
      success: true,
      message:
        skipped.length > 0
          ? `Saved ${written} file(s) to ${destinationRoot}. Skipped ${skipped.length} file(s).`
          : `Saved ${written} file(s) to ${destinationRoot}`,
      destinationRoot,
      rememberedDestinationPath: remembered.destinationPath,
      written,
      files: results,
      skipped,
    });
  } catch (error) {
    const classified = classifyLocalSaveError(error);
    res.status(500).json({
      success: false,
      error: error.message,
      reason: classified.reason,
      reasonMessage: classified.reasonMessage,
      exactReason: classified.exactReason,
      nextSteps: classified.nextSteps,
      technicalDetails: classified.technicalDetails,
    });
  }
});

app.get("/api/attempt/latest", async (_req, res) => {
  try {
    const project = await loadActiveProject();
    const attempt = await findLatestActiveAttempt(project.root);
    res.json({
      success: true,
      hasUndoableChanges: Boolean(attempt && (attempt.files?.length ?? 0) > 0),
      attempt: attempt
        ? {
            id: attempt.id,
            createdAt: attempt.createdAt,
            fileCount: attempt.files?.length ?? 0,
            projectRoot: attempt.projectRoot,
          }
        : null,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post("/api/attempt/start", async (_req, res) => {
  try {
    const project = await loadActiveProject();
    await assertProjectReady(project);
    const attempt = await createApplyAttempt(project);
    res.json({
      success: true,
      attempt: {
        id: attempt.id,
        createdAt: attempt.createdAt,
        fileCount: 0,
        projectRoot: attempt.projectRoot,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post("/api/attempt/undo", async (req, res) => {
  try {
    const activeProject = await loadActiveProject();
    const requestedAttemptId = req.body?.attemptId?.toString().trim();
    let attemptId = requestedAttemptId;

    if (!attemptId) {
      const latest = await findLatestActiveAttempt(activeProject.root);
      if (!latest) {
        return res.json({ success: true, message: "No changes to undo.", restoredCount: 0 });
      }
      attemptId = latest.id;
    }

    const undo = await undoApplyAttempt(attemptId);
    if (undo.alreadyClosed) {
      return res.json({ success: true, message: "No changes to undo.", restoredCount: 0 });
    }
    res.json({
      success: true,
      message: `Undo complete. Restored ${undo.restoredCount} file(s).`,
      restoredCount: undo.restoredCount,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post("/api/analyze", async (req, res) => {
  try {
    const { message } = req.body;
    if (!message?.trim()) throw new Error("No message provided.");
    if (!fsSync.existsSync(CONTEXT_PATH)) {
      throw new Error("Codebase not indexed yet. Click 'Sync Project Knowledge' first.");
    }
    if (!genAI) {
      throw new Error("GEMINI_API_KEY missing in server/.env.local");
    }

    const activeProject = await loadActiveProject();
    await assertProjectReady(activeProject);
    const codebase = await fs.readFile(CONTEXT_PATH, "utf-8");
    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
      generationConfig: { responseMimeType: "application/json", temperature: 0 },
      systemInstruction: SYSTEM_PROMPT,
    });

    const result = await model.generateContent(`CODEBASE CONTEXT:\n${codebase}\n\nUSER REQUEST: ${message}`);
    const data = await buildGuaranteedAnalyzeData(model, message, result.response.text());

    for (const f of data.files_to_modify ?? []) {
      try {
        const { target } = resolvePathInRoot(activeProject.root, f.fileName);
        const oldCode = fsSync.existsSync(target) ? await fs.readFile(target, "utf-8") : "";
        f.diffPatch = createTwoFilesPatch(f.fileName, f.fileName, oldCode, f.fullCode, "Current", "Spec Me Fix");
      } catch {
        f.diffPatch = "";
      }
    }

    res.json({ success: true, data, project: activeProject });
  } catch (error) {
    console.error("/api/analyze error:", error.message);
    const classified = classifyAnalyzeError(error);
    res.status(500).json({
      success: false,
      error: error.message,
      reason: classified.reason,
      reasonMessage: classified.reasonMessage,
      exactReason: classified.exactReason,
      nextSteps: classified.nextSteps,
      technicalDetails: classified.technicalDetails,
    });
  }
});

app.post("/api/save", async (req, res) => {
  try {
    const { fileName, fullCode, attemptId } = req.body;
    if (!fileName || fullCode === undefined) {
      throw new Error("Missing fileName or fullCode.");
    }

    const activeProject = await loadActiveProject();
    await assertProjectReady(activeProject);
    const { target, normalized } = resolvePathInRoot(activeProject.root, fileName);

    if (normalized.includes(".env") || normalized.endsWith("lock.json")) {
      throw new Error("Blocked: Modification of protected files (.env, lockfiles) is not allowed.");
    }

    if (attemptId?.toString().trim()) {
      await snapshotOriginalFile(attemptId.toString().trim(), activeProject.root, normalized);
    }

    const branch = activeProject.mode === "github" ? await createSafetyBranch(activeProject.root, normalized) : null;

    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, fullCode, "utf-8");

    res.json({
      success: true,
      message: `Applied to ${normalized}`,
      branch: branch ?? null,
      projectRoot: activeProject.root,
      projectMode: activeProject.mode,
    });
  } catch (error) {
    console.error("/api/save error:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post("/api/sync", async (req, res) => {
  try {
    const mode = req.body?.mode?.trim() || "";
    const repoUrl = req.body?.repoUrl?.trim() || "";
    const repoBranch = req.body?.repoBranch?.trim() || "";
    const localPath = req.body?.localPath?.trim() || "";

    let nextProject = defaultActiveProject();
    let githubSyncMeta = null;

    if (mode === "github" || repoUrl) {
      if (!repoUrl) {
        throw new Error("Repository URL is required for GitHub mode.");
      }
      const branchHints = await getStoredBranchHints(repoUrl);
      const synced = await syncRemoteGithubRepo(repoUrl, repoBranch, branchHints);
      githubSyncMeta = synced;
      nextProject = withConnectedState({
        mode: "github",
        root: synced.repoDir,
        source: `github:${redactRepoUrl(repoUrl)}#${synced.branch}`,
        repoUrl: redactRepoUrl(repoUrl),
        branch: synced.branch,
      });
    } else if (mode === "local" || localPath) {
      const localRoot = await resolveLocalProject(localPath);
      nextProject = withConnectedState({
        mode: "local",
        root: localRoot,
        source: `local:${localRoot}`,
        repoUrl: null,
        branch: null,
      });
    }

    await saveActiveProject(nextProject);
    const indexed = await buildContext(nextProject.root, nextProject.source);

    console.log(`✅ Context indexed: ${indexed.fileCount} files from ${nextProject.source}`);
    res.json({
      success: true,
      message: `Context Re-Indexed (${indexed.fileCount} files)`,
      source: nextProject.source,
      indexedRoot: nextProject.root,
      mode: nextProject.mode,
      branch: nextProject.branch || null,
      gitStatus: nextProject.mode === "github" ? githubSyncMeta?.gitStatus ?? null : null,
    });
  } catch (error) {
    console.error("/api/sync error:", error.message);
    const mode = req.body?.mode?.trim() || (req.body?.repoUrl ? "github" : req.body?.localPath ? "local" : "workspace");
    const reason = buildReconnectError(mode, error);
    // Save failed state with empty root to prevent fallback indexing/editing
    await saveActiveProject(failedActiveProject(reason.message));
    // Do NOT call buildContext here - failed sync must not index any folder
    res.status(500).json({
      success: false,
      error: reason.message,
      reason: reason.code,
      reasonMessage: reason.message,
      exactReason: reason.message,
      nextSteps: reconnectNextSteps(reason.code),
      technicalDetails: `${error?.code || "unknown"}\n${error?.message || ""}`.trim(),
      availableBranches: reason.availableBranches || [],
      reconnectAction: "manual",
      retryable: true,
    });
  }
});

app.post("/api/push", async (req, res) => {
  try {
    const activeProject = await loadActiveProject();
    if (activeProject.mode !== "github") {
      throw new Error("Push is only available for GitHub project mode.");
    }
    if (activeProject.connectionStatus === "failed") {
      throw new Error("GitHub connection is in a failed state. Reconnect from Sync before pushing.");
    }
    if (!activeProject.root || !activeProject.root.trim()) {
      throw new Error("No project path set. Reconnect the GitHub project from Sync.");
    }

    await ensureGitRepoRoot(activeProject.root);

    // Apply any provided files to the working copy before committing
    const filesToApply = Array.isArray(req.body?.files) ? req.body.files : [];
    if (filesToApply.length > 0) {
      // Create safety branch so we don't commit directly to the default branch
      await createSafetyBranch(activeProject.root, "push-batch");
      for (const f of filesToApply) {
        const fileName = f?.fileName?.toString?.() ?? "";
        const fullCode = f?.fullCode;
        if (!fileName || fullCode === undefined) continue;
        const normalized = normalizeRelativePath(fileName);
        if (normalized.includes(".env") || normalized.endsWith("lock.json")) continue;
        const { target } = resolvePathInRoot(activeProject.root, fileName);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, String(fullCode), "utf-8");
      }
    }

    const commitMessage = (req.body?.message || "SpecMe automated updates").toString().trim();
    await runGit(["add", "-A"], { cwd: activeProject.root });

    const { stdout: statusOut } = await runGit(["status", "--porcelain"], { cwd: activeProject.root });
    if (!statusOut.trim()) {
      return res.json({ success: true, message: "No local changes to commit.", pushed: false });
    }

    await runGit(["commit", "-m", commitMessage], { cwd: activeProject.root });

    const headValid = await hasValidHead(activeProject.root);
    if (!headValid) {
      throw new Error("Cannot push: repository HEAD is invalid. The repo may have no commits.");
    }

    const checkedOutBranch = await getCurrentBranchName(activeProject.root);
    const sourceBranch = (checkedOutBranch || "").trim();
    if (!sourceBranch || sourceBranch === "HEAD") {
      throw new Error("Cannot determine the checked-out branch for push.");
    }

    // Push to the actively connected target branch when available, otherwise to the current branch.
    const targetBranch = (activeProject.branch || sourceBranch).trim();
    const pushRefspec = sourceBranch === targetBranch ? sourceBranch : `${sourceBranch}:${targetBranch}`;
    const pushArgs = ["push", "--set-upstream", "origin", pushRefspec];
    const attemptedCommand = `git ${pushArgs.join(" ")}`;

    try {
      await runGit(pushArgs, { cwd: activeProject.root });

      if (activeProject.branch !== targetBranch) {
        await saveActiveProject({
          ...activeProject,
          branch: targetBranch,
        });
      }

      return res.json({
        success: true,
        message: `Committed and pushed ${sourceBranch} to ${targetBranch}`,
        pushed: true,
        sourceBranch,
        branch: targetBranch,
        command: attemptedCommand,
      });
    } catch (pushError) {
      const parsedFailure = classifyPushFailure(pushError);

      return res.status(500).json({
        success: false,
        error: pushError?.shortMessage || pushError?.message || "Push failed.",
        reason: parsedFailure.reason,
        reasonMessage: parsedFailure.reasonMessage,
        exactReason:
          parsedFailure.exactReason ||
          pushError?.shortMessage ||
          pushError?.message ||
          "Push failed.",
        nextSteps: parsedFailure.nextSteps,
        technicalDetails: `${pushError?.stderr || ""}\n${pushError?.shortMessage || ""}\n${pushError?.message || ""}`.trim(),
        command: attemptedCommand,
        sourceBranch,
        targetBranch,
        pushed: false,
        changesKeptLocally: true,
      });
    }
  } catch (error) {
    console.error("/api/push error:", error.message);
    res.status(500).json({
      success: false,
      error: error.message,
      reason: "push_failed",
      reasonMessage: "Push to GitHub failed.",
      exactReason: error.message,
      nextSteps: "Check repository permissions and network state, then retry the push.",
      technicalDetails: `${error?.code || "unknown"}\n${error?.message || ""}`.trim(),
      changesKeptLocally: true,
    });
  }
});

app.listen(PORT, HOST, () => {
  console.log(`🚀 Spec Me Engine running at http://${HOST}:${PORT}`);
});

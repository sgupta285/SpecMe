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

function makeBranchSelectionError(availableBranches = []) {
  const err = new Error("Could not detect a usable default branch.");
  err.code = "branch_selection_required";
  err.availableBranches = availableBranches;
  return err;
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
3. PATH SAFETY: Only modify files within src/, server/, or supabase/.
4. OUTPUT: Return ONLY a valid JSON object — no markdown fences, no preamble.

SCHEMA:
{
  "summary": "High-level fix description",
  "technical_rationale": "Deep-dive architectural choices",
  "project_type": "Detected framework/language",
  "risks": ["Performance or security risks"],
  "files_to_modify": [
    { "fileName": "src/components/MyFile.tsx", "explanation": "Why this change?", "fullCode": "Complete code" }
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

async function getGitSyncStatus(repoRoot, branchHint = "") {
  await ensureGitRepoRoot(repoRoot);
  const [{ stdout: head }, { stdout: branch }, { stdout: porcelain }] = await Promise.all([
    runGit(["rev-parse", "HEAD"], { cwd: repoRoot }),
    runGit(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repoRoot }),
    runGit(["status", "--porcelain"], { cwd: repoRoot }),
  ]);

  let ahead = null;
  let behind = null;
  const branchName = branchHint || branch.trim();
  if (branchName && branchName !== "HEAD") {
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
    branch: branch.trim(),
    head: head.trim(),
    dirty: Boolean(porcelain.trim()),
    ahead,
    behind,
  };
}

async function createSafetyBranch(repoRoot, fileName) {
  try {
    await ensureGitRepoRoot(repoRoot);
    const { stdout: currentBranch } = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: repoRoot,
    });
    if (currentBranch.trim().startsWith("spec-me/")) {
      return currentBranch.trim();
    }

    const timestamp = Date.now();
    const cleanFileName = path.basename(fileName).replace(/[^a-z0-9]/gi, "-").toLowerCase();
    const branchName = `spec-me/${cleanFileName}-${timestamp}`;

    await runGit(["checkout", "-b", branchName], { cwd: repoRoot });
    return branchName;
  } catch (error) {
    console.warn("⚠️ Git safety layer disabled:", error.message);
    return null;
  }
}

async function syncRemoteGithubRepo(repoUrl, repoBranch) {
  ensureGithubRepo(repoUrl);

  const requestedBranch = repoBranch?.trim() || "";
  const parsedRepo = parseGithubRepoUrl(repoUrl);
  const cloneUrl = withGithubCredentials(parsedRepo.cloneUrl);
  const slug = sanitizeRepoSlug(repoUrl);
  const repoDir = path.join(EXTERNAL_REPOS_ROOT, slug);
  await fs.mkdir(EXTERNAL_REPOS_ROOT, { recursive: true });

  const getRemoteBranchesFromLocal = async () => {
    const { stdout } = await runGit(
      ["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin"],
      { cwd: repoDir }
    );
    return stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => s.replace(/^origin\//, ""))
      .filter((s) => s && s !== "HEAD");
  };

  const getRemoteBranchesFromOrigin = async () => {
    const { stdout } = await runGit(["ls-remote", "--heads", "origin"], { cwd: repoDir });
    return stdout
      .split("\n")
      .map((line) => {
        const match = line.match(/refs\/heads\/(.+)$/);
        return match?.[1]?.trim() || "";
      })
      .filter(Boolean);
  };

  const getRemoteBranches = async () => {
    const all = new Set();
    try {
      for (const b of await getRemoteBranchesFromLocal()) all.add(b);
    } catch {
      // Ignore.
    }
    try {
      for (const b of await getRemoteBranchesFromOrigin()) all.add(b);
    } catch {
      // Ignore.
    }
    return [...all];
  };

  const resolveDefaultBranch = async () => {
    const remoteHasBranch = async (branchName) => {
      try {
        const branches = await getRemoteBranches();
        return branches.includes(branchName);
      } catch {
        return false;
      }
    };

    // 1) Try origin/HEAD symbolic ref if available.
    try {
      await runGit(["remote", "set-head", "origin", "-a"], { cwd: repoDir }).catch(() => {});
      const { stdout } = await runGit(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], {
        cwd: repoDir,
      });
      const match = stdout.trim().match(/^origin\/(.+)$/);
      if (match?.[1]) return match[1];
    } catch {
      // fall through
    }

    // 2) Try remote metadata: git ls-remote --symref origin HEAD
    try {
      const { stdout } = await runGit(["ls-remote", "--symref", "origin", "HEAD"], { cwd: repoDir });
      const line = stdout
        .split("\n")
        .find((l) => l.startsWith("ref: refs/heads/") && l.endsWith("\tHEAD"));
      if (line) {
        const branch = line.replace("ref: refs/heads/", "").replace(/\tHEAD$/, "").trim();
        if (branch) return branch;
      }
    } catch {
      // fall through
    }

    // 3) Use current branch if remote has that branch.
    try {
      const { stdout } = await runGit(["branch", "--show-current"], { cwd: repoDir });
      const current = stdout.trim();
      if (current && current !== "HEAD" && (await remoteHasBranch(current))) return current;
    } catch {
      // fall through
    }

    // 4) Prefer origin/main then origin/master.
    if (await remoteHasBranch("main")) return "main";
    if (await remoteHasBranch("master")) return "master";

    // 5) Fallback to first remote branch.
    const branches = await getRemoteBranches();
    if (branches.length) return branches[0];
    throw makeBranchSelectionError([]);
  };

  const checkoutTrackedBranch = async (branchName) => {
    await runGit(["fetch", "origin", branchName, "--depth", "1"], { cwd: repoDir });
    await runGit(["checkout", "-B", branchName, `origin/${branchName}`], { cwd: repoDir });
    return branchName;
  };

  if (!fsSync.existsSync(repoDir)) {
    try {
      if (requestedBranch) {
        await runGit(["clone", "--depth", "1", "--branch", requestedBranch, cloneUrl, repoDir], {
          cwd: PROJECT_ROOT,
        });
        const gitStatus = await getGitSyncStatus(repoDir, requestedBranch);
        return { repoDir, branch: requestedBranch, gitStatus };
      }
      throw new Error("No branch requested; cloning default branch.");
    } catch {
      await runGit(["clone", "--depth", "1", cloneUrl, repoDir], { cwd: PROJECT_ROOT });
      const active = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repoDir });
      const branch = active.stdout.trim() || "unknown";
      const gitStatus = await getGitSyncStatus(repoDir, branch).catch(() => null);
      return { repoDir, branch, gitStatus };
    }
  }

  await ensureGitRepoRoot(repoDir);
  await runGit(["remote", "set-url", "origin", cloneUrl], { cwd: repoDir });
  await runGit(["fetch", "--all", "--prune"], { cwd: repoDir }).catch(() => {});

  try {
    if (!requestedBranch) {
      throw new Error("No requested branch to check out directly.");
    }
    const checked = await checkoutTrackedBranch(requestedBranch);
    const gitStatus = await getGitSyncStatus(repoDir, checked).catch(() => null);
    return { repoDir, branch: checked, gitStatus };
  } catch {
    const remoteBranches = await getRemoteBranches();
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
    ...defaultActiveProject(),
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
  if (project.mode === "github") {
    try {
      await ensureGitRepoRoot(project.root);
    } catch {
      throw new Error("GitHub mode requires a valid git working copy. Reconnect the GitHub project and retry.");
    }
  } else if (project.mode === "local") {
    const stat = await fs.stat(project.root).catch(() => null);
    if (!stat || !stat.isDirectory()) {
      throw new Error("Local project folder is unavailable. Reconnect the local project and retry.");
    }
  }
}

async function activateProjectDescriptor(descriptor) {
  const mode = descriptor?.mode || "workspace";
  if (mode === "github") {
    const repoUrl = descriptor?.repoUrl?.trim();
    const repoBranch = descriptor?.branch?.trim() || "main";
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
    const destinationPathInput = req.body?.destinationPath?.toString().trim();
    const files = Array.isArray(req.body?.files) ? req.body.files : [];
    if (!destinationPathInput) throw new Error("destinationPath is required.");
    if (!files.length) throw new Error("No files provided.");

    const destinationRoot = path.isAbsolute(destinationPathInput)
      ? path.resolve(destinationPathInput)
      : path.resolve(PROJECT_ROOT, destinationPathInput);

    await fs.mkdir(destinationRoot, { recursive: true });

    let written = 0;
    const results = [];
    for (const f of files) {
      const fileName = f?.fileName?.toString?.() ?? "";
      const fullCode = f?.fullCode;
      if (!fileName || fullCode === undefined) continue;

      const { normalized, target } = resolveOutputPath(destinationRoot, fileName);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, String(fullCode), "utf-8");
      written++;
      results.push({ fileName: normalized });
    }

    res.json({
      success: true,
      message: `Saved ${written} file(s) to ${destinationRoot}`,
      destinationRoot,
      written,
      files: results,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      reason: "save_local_failed",
      reconnectManualHint: "Choose an accessible folder path and retry.",
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
    const data = JSON.parse(result.response.text());

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
    res.status(500).json({ success: false, error: error.message });
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
    const repoBranch = req.body?.repoBranch?.trim() || "main";
    const localPath = req.body?.localPath?.trim() || "";

    let nextProject = defaultActiveProject();
    let githubSyncMeta = null;

    if (mode === "github" || repoUrl) {
      if (!repoUrl) {
        throw new Error("Repository URL is required for GitHub mode.");
      }
      const synced = await syncRemoteGithubRepo(repoUrl, repoBranch);
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
    await saveActiveProject(failedActiveProject(reason.message));
    res.status(500).json({
      success: false,
      error: reason.message,
      reason: reason.code,
      availableBranches: reason.availableBranches || [],
      reconnectAction: "manual",
      retryable: true,
      reconnectManualHint: "Open Sync and reconnect manually.",
    });
  }
});

app.post("/api/push", async (req, res) => {
  try {
    const activeProject = await loadActiveProject();
    if (activeProject.mode !== "github") {
      throw new Error("Push is only available for GitHub project mode.");
    }

    await ensureGitRepoRoot(activeProject.root);

    const commitMessage = (req.body?.message || "SpecMe automated updates").toString().trim();
    await runGit(["add", "-A"], { cwd: activeProject.root });

    const { stdout: statusOut } = await runGit(["status", "--porcelain"], { cwd: activeProject.root });
    if (!statusOut.trim()) {
      return res.json({ success: true, message: "No local changes to commit.", pushed: false });
    }

    await runGit(["commit", "-m", commitMessage], { cwd: activeProject.root });

    const branch = activeProject.branch || (await runGit(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: activeProject.root })).stdout.trim();

    try {
      await runGit(["push", "origin", branch], { cwd: activeProject.root });
      return res.json({
        success: true,
        message: `Committed and pushed to ${branch}`,
        pushed: true,
        branch,
      });
    } catch (pushError) {
      return res.status(500).json({
        success: false,
        error: `Push failed: ${pushError.message}`,
        pushed: false,
        changesKeptLocally: true,
      });
    }
  } catch (error) {
    console.error("/api/push error:", error.message);
    res.status(500).json({ success: false, error: error.message, changesKeptLocally: true });
  }
});

app.listen(PORT, HOST, () => {
  console.log(`🚀 Spec Me Engine running at http://${HOST}:${PORT}`);
});

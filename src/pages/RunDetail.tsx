import { useEffect, useState, useCallback, useMemo } from "react";
import { useParams, Link, useLocation } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import AppLayout from "@/components/AppLayout";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import {
  ArrowLeft,
  Copy,
  FileCode,
  Loader2,
  Check,
  FileText,
  Diff,
  Send,
  History,
  GitBranchPlus,
  Undo2,
  FolderDown,
} from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import type { Json } from "@/integrations/supabase/types";
import { apiFetch } from "@/lib/api";
import ErrorDialog, { type ErrorDialogState } from "@/components/ErrorDialog";
import { buildUiError, parseApiErrorText, shouldUseErrorDialog } from "@/lib/errors";
import { parseJsonText, stringifyPrettyJson } from "@/lib/json";

type SpecFile = {
  fileName: string;
  explanation?: string;
  fullCode: string;
  diffPatch?: string;
};

type SpecOutput = {
  summary?: string;
  technical_rationale?: string;
  project_type?: string;
  risks?: string[];
  files_to_modify?: SpecFile[];
  next_steps?: string[];
};

interface RunData {
  id: string;
  status: string;
  user_id: string;
  feedback_id: string;
  spec_output: SpecOutput | null;
  error_message?: string | null;
  created_at: string;
}

// Run “memory” messages (thread)
type RunMessage = {
  id: string;
  run_id: string;
  user_id: string;
  role: "user" | "assistant";
  content: string;
  spec_output: Json | null;
  created_at: string;
};

// ✅ Only block env files; backend already enforces safety for everything else
const BLOCKED_PREFIXES = [".env", ".env.local"];
const toPosix = (p: string) => p.replace(/\\/g, "/").replace(/^\/+/, "");
const isBlocked = (p: string) => {
  const norm = toPosix(p);
  if (norm === ".env" || norm === ".env.local") return true;
  if (
    norm.includes("/.env.") ||
    norm.endsWith("/.env") ||
    norm.endsWith("/.env.local")
  )
    return true;
  return BLOCKED_PREFIXES.some((x) => norm.startsWith(x));
};

type ViewMode = "changes" | "full";
type ProjectInfo = {
  mode: "github" | "local" | "workspace";
  root: string;
  source: string;
  repoUrl?: string | null;
  branch?: string | null;
  connectionStatus?: "connected" | "failed" | "disconnected";
  lastConnectionError?: string | null;
};

type LocalDirectoryHandle = {
  getDirectoryHandle: (
    name: string,
    options?: { create?: boolean }
  ) => Promise<LocalDirectoryHandle>;
  getFileHandle: (
    name: string,
    options?: { create?: boolean }
  ) => Promise<{
    createWritable: () => Promise<{
      write: (contents: string) => Promise<void>;
      close: () => Promise<void>;
    }>;
  }>;
};

function stableSortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stableSortJson(item));
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const sortedKeys = Object.keys(obj).sort((a, b) => a.localeCompare(b));
    const next: Record<string, unknown> = {};
    for (const key of sortedKeys) {
      next[key] = stableSortJson(obj[key]);
    }
    return next;
  }
  return value;
}

function formatSpecText(spec: SpecOutput | null) {
  if (!spec) return "";
  const sections: string[] = [];
  if (spec.summary?.trim()) sections.push(`Summary\n${spec.summary.trim()}`);
  if (spec.technical_rationale?.trim()) {
    sections.push(`Technical Rationale\n${spec.technical_rationale.trim()}`);
  }
  if (spec.project_type?.trim()) sections.push(`Project Type\n${spec.project_type.trim()}`);
  if ((spec.risks ?? []).length) {
    sections.push(`Risks\n${(spec.risks ?? []).map((r) => `- ${r}`).join("\n")}`);
  }
  if ((spec.next_steps ?? []).length) {
    sections.push(
      `Next Steps\n${(spec.next_steps ?? []).map((step, idx) => `${idx + 1}. ${step}`).join("\n")}`
    );
  }
  if ((spec.files_to_modify ?? []).length) {
    sections.push(
      `Files To Modify\n${(spec.files_to_modify ?? [])
        .map((file) =>
          file.explanation?.trim()
            ? `- ${file.fileName}: ${file.explanation}`
            : `- ${file.fileName}`
        )
        .join("\n")}`
    );
  }
  return sections.join("\n\n");
}

function normalizeSpecOutput(raw: unknown): SpecOutput | null {
  if (raw == null) return null;
  let value: unknown = raw;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    try {
      value = parseJsonText(trimmed, "spec output");
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as SpecOutput;
}

export default function RunDetail() {
  const { id } = useParams<{ id: string }>();
  const location = useLocation();
  const { user } = useAuth();
  const { toast } = useToast();

  const [run, setRun] = useState<RunData | null>(null);
  const [feedbackTitle, setFeedbackTitle] = useState("");
  const [repoUrl, setRepoUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [activeIndex, setActiveIndex] = useState<number>(0);
  const [applying, setApplying] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [savingLocal, setSavingLocal] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("changes");
  const [projectInfo, setProjectInfo] = useState<ProjectInfo | null>(null);
  const [rememberedLocalDestination, setRememberedLocalDestination] = useState<string>("");
  const [currentAttemptId, setCurrentAttemptId] = useState<string | null>(null);
  const [hasUndoableChanges, setHasUndoableChanges] = useState(false);

  // Thread memory
  const [threadLoading, setThreadLoading] = useState(false);
  const [messages, setMessages] = useState<RunMessage[]>([]);
  const [selectedSpecIndex, setSelectedSpecIndex] = useState<number | null>(
    null
  );

  // Chat input
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [errorDialog, setErrorDialog] = useState<ErrorDialogState>({
    open: false,
    title: "",
    explanation: "",
    reason: "",
    nextSteps: "",
    technicalDetails: "",
  });

  /**
   * ✅ IMPORTANT:
   * Your generated Supabase types currently don't include "run_messages".
   * Using supabase.from("run_messages") directly can trigger deep TS inference errors.
   *
   * This wrapper keeps full typing for known tables (runs/feedback/user_settings),
   * but allows unknown tables WITHOUT using `any`.
   */
  type UnsafeFrom = (table: string) => ReturnType<(typeof supabase)["from"]>;
  const sbUnsafe = supabase as unknown as { from: UnsafeFrom };

  const getProjectLabel = useCallback((project?: ProjectInfo | null, fallback?: string | null) => {
    if (project?.mode === "github" && project.repoUrl) {
      return project.branch ? `${project.repoUrl}#${project.branch}` : project.repoUrl;
    }
    if (project?.mode === "local" && project.root) {
      return project.root;
    }
    return fallback ?? null;
  }, []);

  const applyProjectState = useCallback(
    (project?: ProjectInfo | null) => {
      if (!project) return;
      setProjectInfo(project);
      setRepoUrl(getProjectLabel(project, null));
    },
    [getProjectLabel]
  );

  const loadRun = useCallback(async () => {
    if (!id || !user) return;

    setLoading(true);

    const { data: settings } = await supabase
      .from("user_settings")
      .select("repo_url")
      .eq("user_id", user.id)
      .maybeSingle();
    setRepoUrl(settings?.repo_url ?? null);

    const { data: runData, error: runErr } = await supabase
      .from("runs")
      .select("*")
      .eq("id", id)
      .maybeSingle();

    if (runErr) {
      toast({
        title: "Error",
        description: runErr.message || "Failed to load run",
        variant: "destructive",
      });
      setLoading(false);
      return;
    }

    if (runData) {
      const typed = runData as unknown as RunData;
      setRun(typed);

      // Auto-reconnect the project source this run originally used.
      try {
        const activateRes = await apiFetch("/api/runs/activate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ runId: typed.id }),
        });
        const raw = await activateRes.text();
        if (!activateRes.ok) {
          throw new Error(raw || "Failed to activate run project");
        }
        try {
          const parsed = JSON.parse(raw) as {
            success?: boolean;
            message?: string;
            reconnectManualHint?: string;
            reconnectAction?: "manual";
            project?: ProjectInfo;
          };
          if (parsed.success === false) {
            const detail = [parsed.message, parsed.reconnectManualHint]
              .filter(Boolean)
              .join(" ");
            toast({
              title: "Project reconnect failed",
              description: detail || "Reconnect manually from Sync.",
              variant: "destructive",
            });
            setProjectInfo({
              mode: "workspace",
              root: "",
              source: "workspace",
              connectionStatus: "failed",
              lastConnectionError: parsed.message || "Project reconnect failed",
            });
            setRepoUrl(null);
          } else if (parsed.success && parsed.project) {
            applyProjectState(parsed.project);
          }
        } catch {
          // ignore JSON parse issue; non-blocking for run view
        }
      } catch {
        // Non-blocking: page can still load with current active project.
      }

      const { data: fb } = await supabase
        .from("feedback")
        .select("title")
        .eq("id", typed.feedback_id)
        .maybeSingle();

      if (fb?.title) setFeedbackTitle(fb.title);
    }

    setLoading(false);
  }, [id, user, toast, applyProjectState]);

  const loadThread = useCallback(async () => {
    if (!id || !user) return;

    setThreadLoading(true);
    try {
      const { data, error } = await sbUnsafe
        .from("run_messages")
        .select("id, run_id, user_id, role, content, spec_output, created_at")
        .eq("run_id", id)
        .eq("user_id", user.id)
        .order("created_at", { ascending: true });

      if (error) {
        // Don’t break the page if the table doesn’t exist yet
        console.warn("run_messages load error:", error.message);
        setMessages([]);
        return;
      }

      setMessages((data ?? []) as unknown as RunMessage[]);
    } finally {
      setThreadLoading(false);
    }
  }, [id, user, sbUnsafe]);

  const loadProjectInfo = useCallback(async () => {
    try {
      const res = await apiFetch("/api/project");
      if (!res.ok) return;
      const parsed = (await res.json()) as {
        success?: boolean;
        project?: ProjectInfo;
      };
      if (parsed?.success && parsed.project) {
        applyProjectState(parsed.project);
      }
    } catch {
      // Non-blocking for RunDetail rendering
    }
  }, [applyProjectState]);

  const loadAttemptStatus = useCallback(async () => {
    try {
      const res = await apiFetch("/api/attempt/latest");
      if (!res.ok) return;
      const parsed = (await res.json()) as {
        success?: boolean;
        hasUndoableChanges?: boolean;
        attempt?: { id?: string | null } | null;
      };
      if (!parsed.success) return;
      setHasUndoableChanges(Boolean(parsed.hasUndoableChanges));
      setCurrentAttemptId(parsed.attempt?.id || null);
    } catch {
      // Non-blocking
    }
  }, []);

  const loadRememberedLocalDestination = useCallback(async () => {
    try {
      const res = await apiFetch("/api/save-local-destination");
      if (!res.ok) {
        setRememberedLocalDestination("");
        return null;
      }
      const parsed = (await res.json()) as {
        success?: boolean;
        destinationPath?: string | null;
        exists?: boolean;
        missingReason?: string;
      };
      if (!parsed?.success) {
        setRememberedLocalDestination("");
        return null;
      }
      const remembered = (parsed.destinationPath || "").trim();
      setRememberedLocalDestination(remembered);
      return {
        destinationPath: remembered,
        exists: Boolean(parsed.exists),
        missingReason: parsed.missingReason || "",
      };
    } catch {
      setRememberedLocalDestination("");
      return null;
    }
  }, []);

  useEffect(() => {
    loadRun();
  }, [loadRun]);

  useEffect(() => {
    loadThread();
  }, [loadThread]);

  useEffect(() => {
    loadProjectInfo();
  }, [loadProjectInfo]);

  useEffect(() => {
    loadAttemptStatus();
  }, [loadAttemptStatus]);

  useEffect(() => {
    void loadRememberedLocalDestination();
  }, [projectInfo?.mode, projectInfo?.root, projectInfo?.repoUrl, projectInfo?.branch, loadRememberedLocalDestination]);

  // Choose which spec to display:
  // - if user clicked a past assistant output => show that
  // - else show latest assistant output in thread
  // - else fallback to run.spec_output (backward compatible)
  const assistantSpecs = useMemo(() => {
    return messages
      .filter((m) => m.role === "assistant" && m.spec_output)
      .map((m) => normalizeSpecOutput(m.spec_output))
      .filter((spec): spec is SpecOutput => Boolean(spec));
  }, [messages]);

  const activeSpec: SpecOutput | null = useMemo(() => {
    if (selectedSpecIndex !== null) {
      return assistantSpecs[selectedSpecIndex] ?? null;
    }
    if (assistantSpecs.length) return assistantSpecs[assistantSpecs.length - 1];
    return normalizeSpecOutput(run?.spec_output);
  }, [assistantSpecs, selectedSpecIndex, run?.spec_output]);

  const specText = useMemo(() => formatSpecText(activeSpec), [activeSpec]);
  const copyToClipboard = async (text: string, label: string) => {
    if (!text) {
      toast({
        title: "Nothing to copy",
        description: `No ${label} is available yet.`,
        variant: "destructive",
      });
      return;
    }
    try {
      if (navigator.clipboard?.writeText && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        const area = document.createElement("textarea");
        area.value = text;
        area.setAttribute("readonly", "");
        area.style.position = "absolute";
        area.style.left = "-9999px";
        document.body.appendChild(area);
        area.select();
        const copied = document.execCommand("copy");
        document.body.removeChild(area);
        if (!copied) throw new Error("Clipboard write failed.");
      }
      if (label === "JSON") {
        toast({ title: "Copied JSON to clipboard" });
      } else {
        toast({ title: "Copied to clipboard", description: `${label} copied.` });
      }
    } catch {
      toast({
        title: "Copy failed",
        description: "Clipboard access was blocked. Check browser permissions and try again.",
        variant: "destructive",
      });
    }
  };

  const copyJsonToClipboard = async () => {
    if (!activeSpec) {
      toast({
        title: "Nothing to copy",
        description: "No valid generated JSON output is available yet.",
        variant: "destructive",
      });
      return;
    }
    try {
      const normalized = stableSortJson(activeSpec);
      const prettyJson = stringifyPrettyJson(normalized, "spec output");
      await copyToClipboard(prettyJson, "JSON");
    } catch (error: unknown) {
      const details = error instanceof Error ? error.stack || error.message : String(error);
      setErrorDialog({
        open: true,
        title: "Copy JSON failed",
        explanation: "SpecMe could not copy the JSON output.",
        reason: "The generated output could not be copied because its JSON is invalid.",
        nextSteps: "Regenerate the output and try Copy JSON again.",
        technicalDetails: details,
      });
    }
  };

  const openActionErrorDialog = useCallback(
    (
      title: string,
      explanation: string,
      rawResponse: string,
      fallbackReason: string,
      fallbackNextSteps: string
    ) => {
      const parsed = parseApiErrorText(rawResponse);
      const ui = buildUiError(parsed, fallbackReason, fallbackNextSteps);
      setErrorDialog({
        open: true,
        title,
        explanation,
        reason: ui.reason,
        nextSteps: ui.nextSteps,
        technicalDetails: ui.technicalDetails || rawResponse,
      });
    },
    []
  );

  const statusClass = (s: string) => {
    if (s === "done") return "status-done";
    if (s === "running") return "status-running";
    if (s === "error") return "status-error";
    return "status-queued";
  };

  const files: SpecFile[] = useMemo(() => {
    const raw = activeSpec?.files_to_modify ?? [];
    return raw
      .map((f) => ({ ...f, fileName: toPosix(f.fileName) }))
      .filter((f) => f.fileName && !isBlocked(f.fileName));
  }, [activeSpec?.files_to_modify]);

  const activeFile = files[activeIndex];
  const isGithubFlow = useMemo(() => {
    if (projectInfo?.mode === "github") return true;
    if (projectInfo?.mode === "local") return false;
    return Boolean(repoUrl && !repoUrl.startsWith("local:"));
  }, [projectInfo?.mode, repoUrl]);

  const saveViaDirectoryPicker = useCallback(async (filesToWrite: SpecFile[]) => {
    const picker = (
      window as typeof window & {
        showDirectoryPicker?: () => Promise<LocalDirectoryHandle>;
      }
    ).showDirectoryPicker;

    if (!picker || !window.isSecureContext) return false;

    const directory = await picker();
    let written = 0;

    for (const file of filesToWrite) {
      const normalized = toPosix(file.fileName).replace(/^\/+/, "");
      if (!normalized) continue;

      const parts = normalized.split("/").filter(Boolean);
      if (!parts.length) continue;

      let current = directory;
      for (const part of parts.slice(0, -1)) {
        current = await current.getDirectoryHandle(part, { create: true });
      }

      const fileHandle = await current.getFileHandle(parts[parts.length - 1], {
        create: true,
      });
      const writable = await fileHandle.createWritable();
      await writable.write(String(file.fullCode ?? ""));
      await writable.close();
      written++;
    }

    return true;
  }, []);

  const writeFilesToSelectedFolder = useCallback(
    async (
      filesToWrite: SpecFile[],
      options: { successTitle: string; emptyTitle: string; failureTitle: string }
    ) => {
      if (!filesToWrite.length) {
        toast({
          title: options.emptyTitle,
          description: "Generate a plan with file changes first.",
          variant: "destructive",
        });
        return false;
      }

      try {
        try {
          const savedWithPicker = await saveViaDirectoryPicker(filesToWrite);
          if (savedWithPicker) {
            toast({
              title: options.successTitle,
              description: `Saved ${filesToWrite.length} file(s) to selected folder.`,
            });
            return true;
          }
        } catch (pickerError) {
          if (
            pickerError &&
            typeof pickerError === "object" &&
            "name" in pickerError &&
            (pickerError as { name?: string }).name === "AbortError"
          ) {
            return false;
          }
        }

        const remembered = await loadRememberedLocalDestination();
        const defaultPath =
          remembered && remembered.destinationPath && remembered.exists
            ? remembered.destinationPath
            : rememberedLocalDestination;
        if (remembered && remembered.destinationPath && !remembered.exists) {
          toast({
            title: "Choose a new destination folder",
            description:
              remembered.missingReason ||
              "Your previously used destination folder no longer exists.",
            variant: "destructive",
          });
        }

        const destinationPath = window.prompt(
          "Enter destination folder path for writing changed files (example: /Users/you/Desktop/specme-output):",
          defaultPath || ""
        );
        if (!destinationPath?.trim()) return false;

        const res = await apiFetch("/api/save-local-changes", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            destinationPath: destinationPath.trim(),
            files: filesToWrite.map((f) => ({
              fileName: f.fileName,
              fullCode: f.fullCode,
            })),
          }),
        });

        const raw = await res.text();
        if (!res.ok) {
          const parsed = parseApiErrorText(raw);
          const detail = buildUiError(
            parsed,
            "Failed to save changes locally.",
            "Choose a writable folder path and retry."
          );
          if (shouldUseErrorDialog(parsed.reason, detail.reason)) {
            setErrorDialog({
              open: true,
              title: options.failureTitle,
              explanation: "SpecMe could not write files to the selected destination folder.",
              reason: detail.reason,
              nextSteps: detail.nextSteps,
              technicalDetails: detail.technicalDetails || raw,
            });
            return false;
          }
          throw new Error(detail.reason);
        }

        let description = "Saved changes locally.";
        let nextRememberedPath = destinationPath.trim();
        try {
          const parsed = JSON.parse(raw) as { message?: string; rememberedDestinationPath?: string };
          description = parsed.message || description;
          nextRememberedPath = (parsed.rememberedDestinationPath || nextRememberedPath).trim();
        } catch {
          // Keep fallback message.
        }

        setRememberedLocalDestination(nextRememberedPath);

        toast({
          title: options.successTitle,
          description,
        });
        return true;
      } catch (err: unknown) {
        toast({
          title: options.failureTitle,
          description:
            err instanceof Error ? err.message : "Failed to save changes locally.",
          variant: "destructive",
        });
        return false;
      }
    },
    [loadRememberedLocalDestination, rememberedLocalDestination, saveViaDirectoryPicker, toast]
  );

  useEffect(() => {
    if (activeIndex >= files.length) setActiveIndex(0);
  }, [files.length, activeIndex]);

  // If no diff exists for selected file, force Full Code view
  useEffect(() => {
    if (!activeFile) return;
    const hasPatch = Boolean((activeFile.diffPatch || "").trim());
    if (!hasPatch && viewMode === "changes") setViewMode("full");
  }, [activeFile, viewMode]);

  const applyFile = async (file: SpecFile) => {
    if (isBlocked(file.fileName)) {
      toast({
        title: "Blocked",
        description: `Refusing to apply changes to ${file.fileName}`,
        variant: "destructive",
      });
      return;
    }

    setApplying(true);
    try {
      let attemptId = currentAttemptId;
      if (!attemptId) {
        const startRes = await apiFetch("/api/attempt/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        });
        const startRaw = await startRes.text();
        if (!startRes.ok) throw new Error(startRaw || "Failed to start apply session");
        const parsed = JSON.parse(startRaw) as {
          success?: boolean;
          attempt?: { id?: string };
          error?: string;
        };
        if (!parsed.success || !parsed.attempt?.id) {
          throw new Error(parsed.error || "Failed to start apply session");
        }
        attemptId = parsed.attempt.id;
        setCurrentAttemptId(attemptId);
      }

      const res = await apiFetch("/api/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileName: file.fileName,
          fullCode: file.fullCode,
          attemptId,
        }),
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || "Failed to apply changes");
      }

      toast({ title: "Applied", description: `Saved ${file.fileName} to your project.` });
      setHasUndoableChanges(true);
    } catch (err: unknown) {
      toast({
        title: "Apply failed",
        description:
          err instanceof Error ? err.message : "Something went wrong",
        variant: "destructive",
      });
    } finally {
      setApplying(false);
    }
  };

  const applyAll = async () => {
    if (!files.length) return;
    setApplying(true);
    try {
      let attemptId = currentAttemptId;
      if (!attemptId) {
        const startRes = await apiFetch("/api/attempt/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        });
        const startRaw = await startRes.text();
        if (!startRes.ok) throw new Error(startRaw || "Failed to start apply session");
        const parsed = JSON.parse(startRaw) as {
          success?: boolean;
          attempt?: { id?: string };
          error?: string;
        };
        if (!parsed.success || !parsed.attempt?.id) {
          throw new Error(parsed.error || "Failed to start apply session");
        }
        attemptId = parsed.attempt.id;
        setCurrentAttemptId(attemptId);
      }

      for (const f of files) {
        if (isBlocked(f.fileName)) continue;

        const res = await apiFetch("/api/save", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            fileName: f.fileName,
            fullCode: f.fullCode,
            attemptId,
          }),
        });

        if (!res.ok) {
          const text = await res.text();
          throw new Error(text || `Failed to apply ${f.fileName}`);
        }
      }

      toast({
        title: "Applied",
        description: "All allowed file changes were applied.",
      });
      setHasUndoableChanges(true);
    } catch (err: unknown) {
      toast({
        title: "Apply failed",
        description:
          err instanceof Error ? err.message : "Something went wrong",
        variant: "destructive",
      });
    } finally {
      setApplying(false);
    }
  };

  const undoChanges = async () => {
    if (!hasUndoableChanges) return;
    setUndoing(true);
    try {
      const res = await apiFetch("/api/attempt/undo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ attemptId: currentAttemptId }),
      });
      const raw = await res.text();
      if (!res.ok) throw new Error(raw || "Undo failed");

      let message = "Changes reverted.";
      try {
        const parsed = JSON.parse(raw) as {
          success?: boolean;
          message?: string;
          error?: string;
        };
        if (!parsed.success) throw new Error(parsed.error || "Undo failed");
        message = parsed.message || message;
      } catch (err) {
        if (err instanceof Error) throw err;
      }

      toast({ title: "Undo complete", description: message });
      setHasUndoableChanges(false);
      setCurrentAttemptId(null);
      await loadAttemptStatus();
    } catch (err: unknown) {
      toast({
        title: "Undo failed",
        description: err instanceof Error ? err.message : "Unable to undo changes.",
        variant: "destructive",
      });
    } finally {
      setUndoing(false);
    }
  };

  const renderPatch = (file: SpecFile) => {
    const patch = (file.diffPatch || "").trim();
    if (!patch) {
      return (
        <div className="p-4 text-sm text-muted-foreground">
          No diffPatch provided for this file.
        </div>
      );
    }

    const lines = patch.split("\n");

    return (
      <pre className="text-xs p-4 overflow-auto max-h-[520px] leading-relaxed font-mono bg-black/30">
        {lines.map((line, idx) => {
          const isFileHeader = line.startsWith("---") || line.startsWith("+++");
          const isHunkHeader = line.startsWith("@@");
          const isAdd = line.startsWith("+") && !line.startsWith("+++");
          const isDel = line.startsWith("-") && !line.startsWith("---");

          let className = "block whitespace-pre text-foreground/85";

          if (isFileHeader)
            className = "block whitespace-pre text-muted-foreground/75";
          if (isHunkHeader) {
            className =
              "block whitespace-pre text-purple-200 bg-purple-500/10 px-1 rounded";
          }
          if (isAdd) {
            className =
              "block whitespace-pre bg-emerald-500/25 text-emerald-100 border-l-4 border-emerald-400 pl-2 font-medium";
          }
          if (isDel) {
            className =
              "block whitespace-pre bg-rose-500/25 text-rose-100 border-l-4 border-rose-400 pl-2 font-medium";
          }

          return (
            <span key={idx} className={className}>
              {line}
            </span>
          );
        })}
      </pre>
    );
  };

  const pushToGithub = async () => {
    if (projectInfo?.mode !== "github") return;
    setPushing(true);
    try {
      const res = await apiFetch("/api/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: `SpecMe updates for ${feedbackTitle || "run"}`,
          files: files
            .filter((f) => !isBlocked(f.fileName))
            .map((f) => ({ fileName: f.fileName, fullCode: f.fullCode })),
        }),
      });

      const raw = await res.text();
      let msg = raw;
      try {
        const parsed = JSON.parse(raw) as {
          success?: boolean;
          message?: string;
          error?: string;
          reasonMessage?: string;
          nextSteps?: string;
          exactReason?: string;
        };
        if (!res.ok) {
          openActionErrorDialog(
            "Push to GitHub failed",
            "SpecMe could not push your commit to the remote repository.",
            raw,
            "Push failed.",
            "Check GitHub access, token permissions, branch rules, and repository ownership."
          );
          return;
        }
        msg = parsed.message || "Committed and pushed.";
      } catch (parseErr) {
        if (!res.ok) {
          openActionErrorDialog(
            "Push to GitHub failed",
            "SpecMe could not push your commit to the remote repository.",
            parseErr instanceof Error ? parseErr.message : raw,
            "Push failed. Generated changes are still kept locally.",
            "Check GitHub access, token permissions, branch rules, and repository ownership."
          );
          return;
        }
      }

      toast({
        title: "GitHub updated",
        description: msg,
      });
    } catch (err: unknown) {
      setErrorDialog({
        open: true,
        title: "Push to GitHub failed",
        explanation: "SpecMe could not push your commit to the remote repository.",
        reason:
          err instanceof Error
            ? err.message
            : "Push failed. Generated changes are still kept locally.",
        nextSteps:
          "Check your network and GitHub credentials, then retry the push.",
        technicalDetails: err instanceof Error ? err.stack || err.message : String(err),
      });
    } finally {
      setPushing(false);
    }
  };

  const saveChangesLocally = async () => {
    setSavingLocal(true);
    try {
      await writeFilesToSelectedFolder(files, {
        successTitle: "Saved locally",
        emptyTitle: "No files to save",
        failureTitle: "Local save failed",
      });
    } finally {
      setSavingLocal(false);
    }
  };

  const renderFullCode = (file: SpecFile) => {
    const code = (file.fullCode || "").trim();
    if (!code) {
      return (
        <div className="p-4 text-sm text-muted-foreground">
          No fullCode provided for this file.
        </div>
      );
    }

    return (
      <pre className="text-xs p-4 overflow-auto max-h-[520px] leading-relaxed font-mono bg-black/30 text-foreground/90">
        {code}
      </pre>
    );
  };

  // Send chat message => persist user msg => call AI => persist assistant msg (+ update runs.spec_output)
  const sendMessage = async () => {
    if (!id || !user) return;

    const text = draft.trim();
    if (!text) return;

    setSending(true);
    let openedDialog = false;
    try {
      // 1) insert user message
      const { data: userMsg, error: userInsertErr } = await sbUnsafe
        .from("run_messages")
        .insert({
          run_id: id,
          user_id: user.id,
          role: "user",
          content: text,
          spec_output: null,
        })
        .select("id, run_id, user_id, role, content, spec_output, created_at")
        .single();

      if (userInsertErr) throw userInsertErr;

      setMessages((prev) => [...prev, userMsg as unknown as RunMessage]);
      setDraft("");

      // 2) call AI server
      const response = await apiFetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          route: location.pathname,
          pageTitle: document.title,
          uiText: "",
          selectedText: "",
        }),
      });

      const raw = await response.text();
      if (!response.ok) {
        openActionErrorDialog(
          "Generation failed",
          "SpecMe could not generate the updated plan for this request.",
          raw || "AI server error",
          "Generation request failed.",
          "Retry in a moment. If it keeps failing, verify Gemini API limits and model settings."
        );
        openedDialog = true;
        throw new Error(raw || "AI server error");
      }

      const parsed = parseJsonText<{
        success: boolean;
        data?: SpecOutput;
        error?: string;
      }>(raw, "analyze API response");
      if (!parsed.success || !parsed.data) {
        throw new Error(parsed.error || "AI response missing expected fields.");
      }

      const spec = parsed.data;

      // 3) keep backward-compat: update runs.spec_output to latest
      await supabase
        .from("runs")
        .update({
          status: "done",
          spec_output: spec as unknown as Json,
          error_message: null,
        })
        .eq("id", id);

      // 4) insert assistant message (memory)
      const { data: asstMsg, error: asstInsertErr } = await sbUnsafe
        .from("run_messages")
        .insert({
          run_id: id,
          user_id: user.id,
          role: "assistant",
          content: spec.summary?.trim()
            ? `Summary: ${spec.summary}`
            : "Generated an updated plan.",
          spec_output: spec as unknown as Json,
        })
        .select("id, run_id, user_id, role, content, spec_output, created_at")
        .single();

      if (asstInsertErr) throw asstInsertErr;

      setMessages((prev) => [...prev, asstMsg as unknown as RunMessage]);
      setSelectedSpecIndex(null); // show latest by default

      // refresh run (keeps status/error aligned)
      loadRun();
    } catch (err: unknown) {
      if (!openedDialog) {
        toast({
          title: "Send failed",
          description:
            err instanceof Error ? err.message : "Something went wrong",
          variant: "destructive",
        });
      }
    } finally {
      setSending(false);
    }
  };

  // ---- UI states ----
  if (loading) {
    return (
      <AppLayout repoUrl={repoUrl}>
        <div className="max-w-6xl mx-auto px-6 py-10">
          <Skeleton className="h-8 w-64 mb-2" />
          <Skeleton className="h-5 w-32 mb-8" />
        </div>
      </AppLayout>
    );
  }

  if (!run) {
    return (
      <AppLayout repoUrl={repoUrl}>
        <div className="max-w-6xl mx-auto px-6 py-10 text-center">
          <p className="text-muted-foreground">Run not found.</p>
          <Link
            to="/dashboard"
            className="text-primary text-sm mt-2 inline-block"
          >
            Back to dashboard
          </Link>
        </div>
      </AppLayout>
    );
  }

  const isRunning = run.status === "running";

  return (
    <AppLayout repoUrl={repoUrl}>
      <div className="max-w-6xl mx-auto px-6 py-10 animate-fade-in">
        <Link
          to="/dashboard"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors mb-6"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to dashboard
        </Link>

        <div className="flex items-start justify-between mb-6 flex-wrap gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-foreground">
              {feedbackTitle || "Run"}
            </h1>
            <span className={`mt-2 ${statusClass(run.status)}`}>
              {run.status}
            </span>
            {run.status === "error" && run.error_message && (
              <div className="mt-2 text-sm text-destructive whitespace-pre-wrap">
                {run.error_message}
              </div>
            )}
          </div>

          {run.status === "done" && (
            <div className="flex gap-2 flex-wrap">
              <Button
                variant="outline"
                size="sm"
                onClick={() => copyToClipboard(specText, "Spec")}
                disabled={!activeSpec}
              >
                <Copy className="mr-1.5 h-3.5 w-3.5" />
                Copy Spec
              </Button>

              <Button
                variant="outline"
                size="sm"
                onClick={copyJsonToClipboard}
                disabled={!activeSpec}
              >
                <Copy className="mr-1.5 h-3.5 w-3.5" />
                Copy JSON
              </Button>

              <Button
                size="sm"
                onClick={applyAll}
                disabled={applying || files.length === 0}
              >
                {applying ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Check className="mr-1.5 h-3.5 w-3.5" />
                )}
                Apply All
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={undoChanges}
                disabled={undoing || !hasUndoableChanges}
              >
                {undoing ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Undo2 className="mr-1.5 h-3.5 w-3.5" />
                )}
                Undo Changes
              </Button>

              {projectInfo?.mode === "github" && projectInfo?.connectionStatus === "connected" && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={saveChangesLocally}
                  disabled={savingLocal || files.length === 0}
                >
                  {savingLocal ? (
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <FolderDown className="mr-1.5 h-3.5 w-3.5" />
                  )}
                  Save Changes Locally
                </Button>
              )}

              {projectInfo?.mode === "github" && projectInfo?.connectionStatus === "connected" && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={pushToGithub}
                  disabled={pushing}
                >
                  {pushing ? (
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <GitBranchPlus className="mr-1.5 h-3.5 w-3.5" />
                  )}
                  Commit & Push to GitHub
                </Button>
              )}
            </div>
          )}
        </div>

        {/* Connection status warning */}
        {projectInfo?.connectionStatus === "failed" && (
          <div className="rounded-md border border-red-500/30 bg-red-500/10 p-3 text-sm mb-6">
            <div className="text-red-200 font-medium">Project connection failed</div>
            {projectInfo.lastConnectionError && (
              <div className="text-red-300/80 text-xs mt-1">{projectInfo.lastConnectionError}</div>
            )}
            <div className="mt-2">
              <Link to="/sync" className="text-xs text-primary underline underline-offset-2">
                Reconnect from Sync
              </Link>
            </div>
          </div>
        )}

        {/* ✅ Conversation + History (memory) */}
        <div className="glass-card p-5 mb-6">
          <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
            <div className="flex items-center gap-2">
              <History className="h-4 w-4 text-primary" />
              <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
                Conversation
              </h2>
              {threadLoading && (
                <span className="text-xs text-muted-foreground">Loading…</span>
              )}
            </div>

            <div className="text-xs text-muted-foreground">
              Click an AI response to view/apply that version.
            </div>
          </div>

          <div className="max-h-[260px] overflow-auto rounded-md border border-border bg-muted/10">
            {messages.length === 0 ? (
              <div className="p-4 text-sm text-muted-foreground">
                No saved history yet. Send a message below to start.
              </div>
            ) : (
              <div className="p-3 space-y-2">
                {messages.map((m, idx) => {
                  const isUser = m.role === "user";
                  const hasSpec = Boolean(m.spec_output);
                  const assistantIndex = hasSpec
                    ? messages
                        .filter((x) => x.role === "assistant" && x.spec_output)
                        .findIndex((x) => x.id === m.id)
                    : -1;

                  const selected =
                    !isUser &&
                    hasSpec &&
                    selectedSpecIndex !== null &&
                    assistantIndex === selectedSpecIndex;

                  return (
                    <div
                      key={m.id ?? idx}
                      className={`flex ${
                        isUser ? "justify-end" : "justify-start"
                      }`}
                    >
                      <button
                        type="button"
                        disabled={!(hasSpec && !isUser)}
                        onClick={() => {
                          if (hasSpec && !isUser) {
                            setSelectedSpecIndex(assistantIndex);
                            setActiveIndex(0);
                          }
                        }}
                        className={`text-left max-w-[85%] rounded-xl border px-3 py-2 text-sm transition-colors ${
                          isUser
                            ? "bg-primary/20 border-primary/30"
                            : selected
                            ? "bg-muted/60 border-primary/40"
                            : "bg-card/40 border-border/70 hover:bg-muted/30"
                        }`}
                      >
                        <div className="text-xs text-muted-foreground mb-1">
                          {isUser ? "You" : "AI"} •{" "}
                          {new Date(m.created_at).toLocaleString()}
                          {!isUser && hasSpec ? " • (click to view)" : ""}
                        </div>
                        <div className="whitespace-pre-wrap text-foreground/90">
                          {m.content ||
                            (isUser ? "(no text)" : "Generated output")}
                        </div>
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Chat input */}
          <div className="mt-3 flex gap-2 items-end">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Type changes you want… (this will be saved to this project’s history)"
              className="w-full min-h-[44px] max-h-[140px] resize-y rounded-md border border-border bg-muted/10 px-3 py-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-primary/40"
            />
            <Button
              onClick={sendMessage}
              disabled={sending || !draft.trim()}
              className="shrink-0"
            >
              {sending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
            </Button>
          </div>
        </div>

        {/* ✅ PM PREVIEW / SPEC OVERVIEW (better layout) */}
        {run.status === "done" && activeSpec && (
          <div className="glass-card p-6 mb-6">
            {/* Header */}
            <div className="flex items-center justify-between gap-3 mb-5 flex-wrap">
              <div className="flex items-center gap-2">
                <FileText className="h-4 w-4 text-primary" />
                <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
                  PM Preview
                </h2>
              </div>

              {/* Optional quick meta */}
              <div className="text-xs text-muted-foreground">
                {activeSpec.project_type
                  ? `Project: ${activeSpec.project_type}`
                  : ""}
              </div>
            </div>

            {/* Top row: Summary + Technical */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div className="rounded-xl border border-border bg-muted/10 p-4">
                <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                  Summary
                </div>
                <div className="mt-2 text-sm text-foreground whitespace-pre-wrap leading-relaxed">
                  {activeSpec.summary?.trim() || "—"}
                </div>
              </div>

              <div className="rounded-xl border border-border bg-muted/10 p-4">
                <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                  Technical rationale
                </div>
                <div className="mt-2 text-sm text-foreground whitespace-pre-wrap leading-relaxed">
                  {activeSpec.technical_rationale?.trim() || "—"}
                </div>
              </div>
            </div>

            {/* Divider */}
            <div className="my-4 h-px w-full bg-border/70" />

            {/* Bottom row: Risks + Next steps */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div className="rounded-xl border border-border bg-muted/10 p-4">
                <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                  Risks
                </div>

                {(activeSpec.risks ?? []).length ? (
                  <ul className="mt-2 space-y-2">
                    {(activeSpec.risks ?? []).map((r, i) => (
                      <li
                        key={i}
                        className="flex gap-2 text-sm text-foreground"
                      >
                        <span className="mt-1 h-1.5 w-1.5 rounded-full bg-foreground/60 shrink-0" />
                        <span className="leading-relaxed">{r}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="mt-2 text-sm text-muted-foreground">—</div>
                )}
              </div>

              <div className="rounded-xl border border-border bg-muted/10 p-4">
                <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                  Next steps
                </div>

                {(activeSpec.next_steps ?? []).length ? (
                  <ol className="mt-2 space-y-2 list-decimal pl-5">
                    {(activeSpec.next_steps ?? []).map((s, i) => (
                      <li
                        key={i}
                        className="text-sm text-foreground leading-relaxed"
                      >
                        {s}
                      </li>
                    ))}
                  </ol>
                ) : (
                  <div className="mt-2 text-sm text-muted-foreground">—</div>
                )}
              </div>
            </div>
          </div>
        )}

        {isRunning ? (
          <div className="glass-card p-16 text-center">
            <Loader2 className="h-8 w-8 animate-spin text-primary mx-auto mb-4" />
            <p className="text-foreground font-medium">Analyzing feedback…</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* LEFT: FILES */}
            <div className="glass-card p-5">
              <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-4">
                Files to Change
              </h2>

              {files.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No allowed file outputs were saved.
                </p>
              ) : (
                <div className="space-y-2">
                  {files.map((file, i) => (
                    <button
                      key={`${file.fileName}-${i}`}
                      type="button"
                      onClick={() => setActiveIndex(i)}
                      className={`w-full text-left p-3 rounded-md border transition-colors ${
                        i === activeIndex
                          ? "bg-muted/60 border-primary/40"
                          : "bg-muted/30 border-border hover:bg-muted/50"
                      }`}
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <FileCode className="h-3.5 w-3.5 text-primary shrink-0" />
                        <span className="font-mono text-xs text-foreground truncate">
                          {file.fileName}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground pl-5 line-clamp-2">
                        {file.explanation || "No explanation provided."}
                      </p>
                    </button>
                  ))}
                </div>
              )}

              {run.status === "done" && files.length > 0 && (
                <div className="mt-4 flex gap-2">
                  <Button
                    className="w-full"
                    onClick={() => activeFile && applyFile(activeFile)}
                    disabled={applying || !activeFile}
                  >
                    {applying ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Check className="mr-2 h-4 w-4" />
                    )}
                    Apply Selected
                  </Button>
                </div>
              )}
            </div>

            {/* RIGHT: SELECTED FILE */}
            <div className="glass-card p-5 lg:col-span-2">
              {activeFile ? (
                <>
                  <div className="flex items-start justify-between gap-3 mb-4 flex-wrap">
                    <div>
                      <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                        Selected file
                      </div>
                      <div className="font-mono text-sm text-foreground">
                        {activeFile.fileName}
                      </div>
                      {activeFile.explanation && (
                        <div className="text-sm text-muted-foreground mt-2 whitespace-pre-wrap">
                          {activeFile.explanation}
                        </div>
                      )}
                    </div>

                    <div className="flex gap-2 flex-wrap">
                      <Button
                        variant={viewMode === "changes" ? "default" : "outline"}
                        size="sm"
                        onClick={() => setViewMode("changes")}
                        disabled={!(activeFile.diffPatch || "").trim()}
                      >
                        <Diff className="mr-1.5 h-3.5 w-3.5" />
                        Changes
                      </Button>

                      <Button
                        variant={viewMode === "full" ? "default" : "outline"}
                        size="sm"
                        onClick={() => setViewMode("full")}
                      >
                        <FileText className="mr-1.5 h-3.5 w-3.5" />
                        Full Code
                      </Button>

                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          copyToClipboard(activeFile.fullCode, "Full code")
                        }
                      >
                        <Copy className="mr-1.5 h-3.5 w-3.5" />
                        Copy Full Code
                      </Button>
                    </div>
                  </div>

                  <div className="rounded-md border border-border bg-muted/20 overflow-hidden">
                    {viewMode === "changes"
                      ? renderPatch(activeFile)
                      : renderFullCode(activeFile)}
                  </div>

                  <p className="text-xs text-muted-foreground mt-3">
                    {viewMode === "changes"
                      ? "Green lines are additions. Red lines are deletions. Unchanged context is neutral."
                      : "This is the full corrected file output from the model."}
                  </p>
                </>
              ) : (
                <div className="text-sm text-muted-foreground">
                  Select a file to preview its changes.
                </div>
              )}
            </div>
          </div>
        )}
      </div>
      <ErrorDialog
        state={errorDialog}
        onOpenChange={(open) => setErrorDialog((prev) => ({ ...prev, open }))}
      />
    </AppLayout>
  );
}

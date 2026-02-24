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
  Download,
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
  spec_output: SpecOutput | null;
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

  const getApiBase = () =>
    (import.meta.env.VITE_API_URL || "http://localhost:4000").replace(
      /\/$/,
      ""
    );

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
        const apiBase = getApiBase();
        const activateRes = await fetch(`${apiBase}/api/runs/activate`, {
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
          } else if (parsed.success && parsed.project) {
            setProjectInfo(parsed.project);
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
  }, [id, user, toast]);

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
      const apiBase = getApiBase();
      const res = await fetch(`${apiBase}/api/project`);
      if (!res.ok) return;
      const parsed = (await res.json()) as {
        success?: boolean;
        project?: ProjectInfo;
      };
      if (parsed?.success && parsed.project) {
        setProjectInfo(parsed.project);
      }
    } catch {
      // Non-blocking for RunDetail rendering
    }
  }, []);

  const loadAttemptStatus = useCallback(async () => {
    try {
      const apiBase = getApiBase();
      const res = await fetch(`${apiBase}/api/attempt/latest`);
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

  // Choose which spec to display:
  // - if user clicked a past assistant output => show that
  // - else show latest assistant output in thread
  // - else fallback to run.spec_output (backward compatible)
  const assistantSpecs = useMemo(() => {
    return messages
      .filter((m) => m.role === "assistant" && m.spec_output)
      .map((m) => m.spec_output as SpecOutput);
  }, [messages]);

  const activeSpec: SpecOutput | null = useMemo(() => {
    if (selectedSpecIndex !== null) {
      return assistantSpecs[selectedSpecIndex] ?? null;
    }
    if (assistantSpecs.length) return assistantSpecs[assistantSpecs.length - 1];
    return run?.spec_output ?? null;
  }, [assistantSpecs, selectedSpecIndex, run?.spec_output]);

  const copyToClipboard = async (text: string, label: string) => {
    await navigator.clipboard.writeText(text);
    toast({ title: "Copied!", description: `${label} copied to clipboard.` });
  };

  const downloadJson = () => {
    if (!activeSpec) return;
    const blob = new Blob([JSON.stringify(activeSpec, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(feedbackTitle || "spec").replace(/\s+/g, "_")}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

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
      const apiBase = getApiBase();
      let attemptId = currentAttemptId;
      if (!attemptId) {
        const startRes = await fetch(`${apiBase}/api/attempt/start`, {
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

      const res = await fetch(`${apiBase}/api/save`, {
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

      toast({
        title: "Applied",
        description:
          projectInfo?.mode === "github"
            ? `Saved ${file.fileName} in your GitHub working copy.`
            : `Saved ${file.fileName} to your local project.`,
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

  const applyAll = async () => {
    if (!files.length) return;
    setApplying(true);
    try {
      const apiBase = getApiBase();
      let attemptId = currentAttemptId;
      if (!attemptId) {
        const startRes = await fetch(`${apiBase}/api/attempt/start`, {
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

        const res = await fetch(`${apiBase}/api/save`, {
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
      const apiBase = getApiBase();
      const res = await fetch(`${apiBase}/api/attempt/undo`, {
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
      const apiBase = getApiBase();
      const res = await fetch(`${apiBase}/api/push`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: `SpecMe updates for ${feedbackTitle || "run"}`,
        }),
      });

      const raw = await res.text();
      let msg = raw;
      try {
        const parsed = JSON.parse(raw) as {
          success?: boolean;
          message?: string;
          error?: string;
          changesKeptLocally?: boolean;
        };
        if (!res.ok) {
          throw new Error(
            parsed.error ||
              "Push failed. Generated changes are still kept locally."
          );
        }
        msg = parsed.message || "Committed and pushed.";
      } catch (parseErr) {
        if (!res.ok) {
          throw parseErr instanceof Error
            ? parseErr
            : new Error("Push failed. Generated changes are still kept locally.");
        }
      }

      toast({
        title: "GitHub updated",
        description: msg,
      });
    } catch (err: unknown) {
      toast({
        title: "Push failed",
        description:
          err instanceof Error
            ? err.message
            : "Push failed. Generated changes are still kept locally.",
        variant: "destructive",
      });
    } finally {
      setPushing(false);
    }
  };

  const saveChangesLocally = async () => {
    if (!files.length) {
      toast({
        title: "No files to save",
        description: "Generate a plan with file changes first.",
        variant: "destructive",
      });
      return;
    }

    const destinationPath = window.prompt(
      "Enter destination folder path for saving changed files:",
      ""
    );
    if (!destinationPath?.trim()) return;

    setSavingLocal(true);
    try {
      const apiBase = getApiBase();
      const res = await fetch(`${apiBase}/api/save-local-changes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          destinationPath: destinationPath.trim(),
          files: files.map((f) => ({
            fileName: f.fileName,
            fullCode: f.fullCode,
          })),
        }),
      });

      const raw = await res.text();
      if (!res.ok) {
        try {
          const parsed = JSON.parse(raw) as {
            error?: string;
            reconnectManualHint?: string;
          };
          const detail = [parsed.error, parsed.reconnectManualHint]
            .filter(Boolean)
            .join(" ");
          throw new Error(detail || "Failed to save changes locally");
        } catch {
          throw new Error(raw || "Failed to save changes locally");
        }
      }

      let description = "Saved changes locally.";
      try {
        const parsed = JSON.parse(raw) as { message?: string };
        description = parsed.message || description;
      } catch {
        // Keep fallback message.
      }

      toast({
        title: "Saved locally",
        description,
      });
    } catch (err: unknown) {
      toast({
        title: "Local save failed",
        description:
          err instanceof Error ? err.message : "Failed to save changes locally.",
        variant: "destructive",
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
      const apiBase = getApiBase();
      const response = await fetch(`${apiBase}/api/analyze`, {
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
      if (!response.ok) throw new Error(raw || "AI server error");

      const parsed = JSON.parse(raw) as {
        success: boolean;
        data?: SpecOutput;
        error?: string;
      };
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
      toast({
        title: "Send failed",
        description:
          err instanceof Error ? err.message : "Something went wrong",
        variant: "destructive",
      });
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
                onClick={() =>
                  copyToClipboard(
                    JSON.stringify(activeSpec ?? {}, null, 2),
                    "Spec"
                  )
                }
                disabled={!activeSpec}
              >
                <Copy className="mr-1.5 h-3.5 w-3.5" />
                Copy Spec
              </Button>

              <Button
                variant="outline"
                size="sm"
                onClick={downloadJson}
                disabled={!activeSpec}
              >
                <Download className="mr-1.5 h-3.5 w-3.5" />
                Download .json
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

              {projectInfo?.mode === "github" && (
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

              {projectInfo?.mode === "github" && (
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
                  Commit & Push
                </Button>
              )}
            </div>
          )}
        </div>

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
    </AppLayout>
  );
}

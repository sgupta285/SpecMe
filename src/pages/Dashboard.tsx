import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import AppLayout from "@/components/AppLayout";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowRight, GitBranch, Sparkles, Play, Trash2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { apiFetch } from "@/lib/api";

type RunRow = {
  id: string;
  status: "queued" | "running" | "done" | "error" | string;
  created_at: string;
  feedback_id: string;
};

type FeedbackRow = {
  id: string;
  title: string;
};

type RunItem = {
  id: string;
  status: "queued" | "running" | "done" | "error";
  created_at: string;
  title: string;
};
type ProjectHistoryItem = {
  runId: string;
  projectType?: "github" | "local" | "workspace";
  repoUrl?: string | null;
  branch?: string | null;
  source?: string;
  connectionStatus?: "connected" | "failed" | "disconnected";
  lastConnectionError?: string | null;
  lastOpenedAt?: string;
};

type ProjectKind = "none" | "github" | "local";
type ProjectConnection = {
  kind: ProjectKind;
  repoUrl: string;
  repoBranch: string;
  localPath: string;
};
type BackendProject = {
  mode?: "github" | "local" | "workspace";
  root?: string;
  source?: string;
  repoUrl?: string | null;
  branch?: string | null;
  connectionStatus?: "connected" | "failed" | "disconnected";
  lastConnectionError?: string | null;
};

function toProjectConnectionFromBackend(
  backend: BackendProject,
  fallback: ProjectConnection
): ProjectConnection {
  if (backend.connectionStatus === "failed") {
    return { kind: "none", repoUrl: "", repoBranch: "main", localPath: "" };
  }
  if (backend.mode === "github" && backend.connectionStatus === "connected") {
    return {
      kind: "github",
      repoUrl: backend.repoUrl || fallback.repoUrl,
      repoBranch: backend.branch || fallback.repoBranch || "main",
      localPath: "",
    };
  }
  if (backend.mode === "local" && backend.connectionStatus === "connected") {
    const sourcePath =
      backend.source?.startsWith("local:")
        ? backend.source.slice("local:".length)
        : backend.root || fallback.localPath;
    return {
      kind: "local",
      repoUrl: "",
      repoBranch: fallback.repoBranch || "main",
      localPath: sourcePath || "",
    };
  }
  return { kind: "none", repoUrl: "", repoBranch: "main", localPath: "" };
}

function parseProjectConnection(repoUrl: string | null, repoBranch: string | null): ProjectConnection {
  const raw = (repoUrl ?? "").trim();
  if (!raw) {
    return { kind: "none", repoUrl: "", repoBranch: repoBranch?.trim() || "main", localPath: "" };
  }
  if (raw.startsWith("local:")) {
    return {
      kind: "local",
      repoUrl: "",
      repoBranch: repoBranch?.trim() || "main",
      localPath: raw.slice("local:".length),
    };
  }
  return {
    kind: "github",
    repoUrl: raw,
    repoBranch: repoBranch?.trim() || "main",
    localPath: "",
  };
}

export default function Dashboard() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { user } = useAuth();

  const [loading, setLoading] = useState(true);
  const [project, setProject] = useState<ProjectConnection>({
    kind: "none",
    repoUrl: "",
    repoBranch: "main",
    localPath: "",
  });
  const [runs, setRuns] = useState<RunItem[]>([]);
  const [disconnecting, setDisconnecting] = useState<null | "github" | "local">(null);
  const [hasUndoableChanges, setHasUndoableChanges] = useState(false);
  const [backendProject, setBackendProject] = useState<BackendProject | null>(null);
  const [projectHistory, setProjectHistory] = useState<ProjectHistoryItem[]>([]);
  const [deletingHistoryRunId, setDeletingHistoryRunId] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;

    (async () => {
      setLoading(true);

      const { data: settings } = await supabase
        .from("user_settings")
        .select("repo_url, repo_branch")
        .eq("user_id", user.id)
        .maybeSingle();

      const fallbackProject = parseProjectConnection(settings?.repo_url ?? null, settings?.repo_branch ?? null);
      setProject(fallbackProject);

      const backendRes = await apiFetch("/api/project").catch(() => null);
      if (backendRes?.ok) {
        const parsed = (await backendRes.json()) as {
          success?: boolean;
          project?: BackendProject;
        };
        if (parsed.success && parsed.project) {
          setBackendProject(parsed.project);
          setProject(toProjectConnectionFromBackend(parsed.project, fallbackProject));
        }
      } else {
        setBackendProject({
          mode: "workspace",
          connectionStatus: "failed",
          lastConnectionError: "Could not verify backend project connection. Reconnect from Sync.",
        });
        setProject({ kind: "none", repoUrl: "", repoBranch: "main", localPath: "" });
      }

      const attemptRes = await apiFetch("/api/attempt/latest").catch(() => null);
      if (attemptRes?.ok) {
        const parsed = (await attemptRes.json()) as { hasUndoableChanges?: boolean };
        setHasUndoableChanges(Boolean(parsed.hasUndoableChanges));
      }

      const historyRes = await apiFetch("/api/project/history").catch(() => null);
      if (historyRes?.ok) {
        const parsed = (await historyRes.json()) as {
          success?: boolean;
          projects?: ProjectHistoryItem[];
        };
        if (parsed.success && Array.isArray(parsed.projects)) {
          setProjectHistory(parsed.projects);
        }
      }

      const { data: runRows, error: runErr } = await supabase
        .from("runs")
        .select("id, status, created_at, feedback_id")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(10);

      if (runErr) {
        toast({
          title: "Error",
          description: runErr.message || "Failed to load runs",
          variant: "destructive",
        });
        setRuns([]);
        setLoading(false);
        return;
      }

      const rows = (runRows ?? []) as unknown as RunRow[];
      const feedbackIds = Array.from(new Set(rows.map((r) => r.feedback_id))).filter(Boolean);

      const titlesById: Record<string, string> = {};
      if (feedbackIds.length) {
        const { data: fbs } = await supabase.from("feedback").select("id, title").in("id", feedbackIds);
        (fbs as unknown as FeedbackRow[] | null)?.forEach((f) => {
          titlesById[f.id] = f.title;
        });
      }

      const normalized: RunItem[] = rows.map((r) => ({
        id: r.id,
        status: (r.status as RunItem["status"]) || "queued",
        created_at: r.created_at,
        title: titlesById[r.feedback_id] || "Untitled",
      }));

      setRuns(normalized);
      setLoading(false);
    })();
  }, [user, toast]);

  const meta = user?.user_metadata as { first_name?: string; last_name?: string; full_name?: string } | undefined;

  const fullName =
    meta?.full_name?.trim() || [meta?.first_name?.trim(), meta?.last_name?.trim()].filter(Boolean).join(" ");

  const displayName = fullName || "there";

  const statusClass = (s: RunItem["status"]) => {
    if (s === "done") return "status-done";
    if (s === "running") return "status-running";
    if (s === "error") return "status-error";
    return "status-queued";
  };

  const projectLabel = useMemo(() => {
    if (project.kind === "github") return project.repoUrl;
    if (project.kind === "local") return project.localPath;
    return null;
  }, [project]);

  const canGenerate = useMemo(() => project.kind !== "none", [project.kind]);

  const connectionStatusText = useMemo(() => {
    if (!backendProject) return "No project connected";
    if (backendProject.connectionStatus === "failed") {
      return "Project connection failed";
    }
    if (backendProject.mode === "workspace" || backendProject.connectionStatus === "disconnected") {
      return "No project connected";
    }
    // Only show "connected" if backend confirms connection is actually valid
    if (backendProject.connectionStatus !== "connected") {
      return "No project connected";
    }
    if (project.kind === "none") return "No project connected";
    const label = project.kind === "github" ? "GitHub" : "Local";
    return `${label}: connected`;
  }, [project.kind, backendProject]);

  const refreshAttemptStatus = async () => {
    const res = await apiFetch("/api/attempt/latest").catch(() => null);
    if (!res?.ok) return;
    const parsed = (await res.json()) as { hasUndoableChanges?: boolean };
    setHasUndoableChanges(Boolean(parsed.hasUndoableChanges));
  };

  const disconnectProject = async (kind: "github" | "local") => {
    if (!user) return;

    if (project.kind !== kind) {
      toast({
        title: "Nothing to disconnect",
        description: kind === "github" ? "No GitHub project connected." : "No local project connected.",
      });
      return;
    }

    if (hasUndoableChanges) {
      const shouldContinue = window.confirm(
        "You have unapplied/undoable changes from the current attempt. Disconnecting now may make it harder to recover work. Continue?"
      );
      if (!shouldContinue) return;
    }

    setDisconnecting(kind);
    try {
      const disconnectRes = await apiFetch("/api/project/disconnect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const disconnectRaw = await disconnectRes.text();
      if (!disconnectRes.ok) {
        try {
          const parsed = JSON.parse(disconnectRaw) as {
            error?: string;
            reconnectManualHint?: string;
          };
          const detail = [parsed.error, parsed.reconnectManualHint]
            .filter(Boolean)
            .join(" ");
          throw new Error(detail || "Failed to reset project state");
        } catch {
          throw new Error(disconnectRaw || "Failed to reset project state");
        }
      }

      const { error } = await supabase.from("user_settings").upsert(
        {
          user_id: user.id,
          repo_url: null,
          repo_branch: null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id" }
      );
      if (error) throw error;

      setProject({ kind: "none", repoUrl: "", repoBranch: "main", localPath: "" });
      setBackendProject({
        mode: "workspace",
        connectionStatus: "disconnected",
        lastConnectionError: null,
      });
      setHasUndoableChanges(false);
      toast({ title: "Disconnected", description: "Project disconnected. Select a new source anytime." });
      navigate("/dashboard");
    } catch (err: unknown) {
      toast({
        title: "Disconnect failed",
        description: err instanceof Error ? err.message : "Something went wrong",
        variant: "destructive",
      });
    } finally {
      setDisconnecting(null);
      await refreshAttemptStatus();
    }
  };

  const openRunWithReconnect = async (runId: string) => {
    try {
      const activateRes = await apiFetch("/api/runs/activate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId }),
      });
      const raw = await activateRes.text();
      if (activateRes.ok) {
        try {
          const parsed = JSON.parse(raw) as {
            success?: boolean;
            message?: string;
            reconnectManualHint?: string;
            project?: BackendProject;
          };
          if (parsed.success === false) {
            const detail = [parsed.message, parsed.reconnectManualHint]
              .filter(Boolean)
              .join(" ");
            toast({
              title: "Reconnect warning",
              description: detail || "Could not auto-reconnect. Reconnect manually from Sync.",
              variant: "destructive",
            });
          }
          if (parsed.project) {
            setBackendProject(parsed.project);
            setProject(toProjectConnectionFromBackend(parsed.project, project));
          }
        } catch {
          // no-op
        }
      } else {
        throw new Error(raw || "Failed to reconnect project from history");
      }
    } catch (err: unknown) {
      toast({
        title: "Reconnect failed",
        description:
          err instanceof Error
            ? err.message
            : "Failed to reconnect project from history. Reconnect manually from Sync.",
        variant: "destructive",
      });
    } finally {
      navigate(`/runs/${runId}`);
    }
  };

  const deleteHistoryItem = async (runId: string) => {
    const shouldDelete = window.confirm("Delete this project history entry permanently?");
    if (!shouldDelete) return;
    setDeletingHistoryRunId(runId);
    try {
      const res = await apiFetch(`/api/project/history/${runId}`, {
        method: "DELETE",
      });
      const raw = await res.text();
      if (!res.ok) throw new Error(raw || "Failed to delete history entry");
      setProjectHistory((prev) => prev.filter((item) => item.runId !== runId));
      toast({ title: "Deleted", description: "Project history entry removed permanently." });
    } catch (err: unknown) {
      toast({
        title: "Delete failed",
        description: err instanceof Error ? err.message : "Failed to delete history entry",
        variant: "destructive",
      });
    } finally {
      setDeletingHistoryRunId(null);
    }
  };

  const handleGeneratePlan = () => {
    if (project.kind === "none") {
      toast({
        title: "Connect a project first",
        description: "Use Connect GitHub Project or Connect Local Project.",
        variant: "destructive",
      });
      return;
    }
    navigate("/upload");
  };

  return (
    <AppLayout repoUrl={projectLabel}>
      <div className="max-w-6xl mx-auto px-6 py-10">
        <div className="hero-card mb-8">
          <div className="pointer-events-none absolute inset-0 opacity-[0.14]">
            <div className="absolute inset-0 [background-image:linear-gradient(to_right,rgba(148,163,184,0.25)_1px,transparent_1px),linear-gradient(to_bottom,rgba(148,163,184,0.25)_1px,transparent_1px)] [background-size:64px_64px]" />
          </div>

          <div className="relative p-10 md:p-12">
            <div className="chip w-fit mb-6">
              <Sparkles className="h-4 w-4 text-[hsl(var(--primary))]" />
              <span className="text-muted-foreground">Plan generation workflow</span>
            </div>

            <h1 className="text-4xl md:text-5xl font-extrabold tracking-tight leading-[1.05]">
              Hey {displayName}, ready to <span className="grad-text">ship faster?</span>
            </h1>

            <p className="mt-4 text-muted-foreground max-w-2xl text-base md:text-lg">
              Paste your feedback, review a concrete implementation plan, and ship updates with confidence.
            </p>

            <div className="mt-7 flex flex-wrap gap-3">
              <Button onClick={handleGeneratePlan} className="rounded-2xl px-5" disabled={!canGenerate}>
                <Sparkles className="mr-2 h-4 w-4" />
                Generate a Plan
                <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>

        <div className="mb-4 text-sm font-semibold tracking-tight text-muted-foreground">PROJECT CONNECTION</div>
        <div className="glass-card p-5 mb-10">
          <div className="flex items-center justify-between gap-4 flex-wrap mb-4">
            <div>
              <div className="text-sm font-semibold">{connectionStatusText}</div>
              <div className="text-xs text-muted-foreground mt-1">
                {project.kind === "github" && project.repoUrl ? project.repoUrl : null}
                {project.kind === "local" && project.localPath ? project.localPath : null}
                {project.kind === "none" ? "Connect a project source to enable generation and apply." : null}
              </div>
            </div>
            {hasUndoableChanges && (
              <div className="text-xs text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-md px-2 py-1">
                Warning: you have undoable changes in the current attempt.
              </div>
            )}
            {backendProject?.connectionStatus === "failed" && backendProject.lastConnectionError && (
              <div className="text-xs text-red-300 bg-red-500/10 border border-red-500/30 rounded-md px-2 py-1">
                {backendProject.lastConnectionError}
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Button variant="outline" onClick={() => navigate("/sync?mode=github")}>Connect GitHub Project</Button>
            <Button
              variant="outline"
              onClick={() => disconnectProject("github")}
              disabled={disconnecting !== null || project.kind !== "github"}
            >
              {disconnecting === "github" ? "Disconnecting..." : "Disconnect GitHub Project"}
            </Button>
            <Button variant="outline" onClick={() => navigate("/sync?mode=local")}>Connect Local Project</Button>
            <Button
              variant="outline"
              onClick={() => disconnectProject("local")}
              disabled={disconnecting !== null || project.kind !== "local"}
            >
              {disconnecting === "local" ? "Disconnecting..." : "Disconnect Local Project"}
            </Button>
          </div>
        </div>

        <div className="mb-4 text-sm font-semibold tracking-tight text-muted-foreground">QUICK ACTIONS</div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-10">
          <Link to="/sync" className="soft-card p-6 group hover:border-primary/50 transition-colors">
            <div className="flex items-start gap-4">
              <div className="h-11 w-11 rounded-2xl bg-card/40 border border-border/70 backdrop-blur-xl flex items-center justify-center">
                <GitBranch className="h-5 w-5 text-[hsl(var(--primary))]" />
              </div>

              <div className="flex-1">
                <div className="text-base font-semibold group-hover:text-[hsl(var(--primary))] transition-colors">Manage Project Source</div>
                <div className="text-sm text-muted-foreground mt-1">Connect or switch between GitHub and local projects</div>
              </div>

              <ArrowRight className="h-4 w-4 text-muted-foreground group-hover:text-[hsl(var(--primary))] transition-colors mt-1" />
            </div>
          </Link>

          <Link to="/upload" className="soft-card p-6 group hover:border-primary/50 transition-colors">
            <div className="flex items-start gap-4">
              <div className="h-11 w-11 rounded-2xl bg-card/40 border border-border/70 backdrop-blur-xl flex items-center justify-center">
                <span className="text-sm font-extrabold tracking-tight grad-text">SM</span>
              </div>

              <div className="flex-1">
                <div className="text-base font-semibold group-hover:text-[hsl(var(--primary))] transition-colors">Upload Feedback</div>
                <div className="text-sm text-muted-foreground mt-1">Paste your transcript and generate your plan</div>
              </div>

              <ArrowRight className="h-4 w-4 text-muted-foreground group-hover:text-[hsl(var(--primary))] transition-colors mt-1" />
            </div>
          </Link>
        </div>

        <div className="mb-3 text-sm font-semibold tracking-tight text-muted-foreground">PROJECT HISTORY</div>
        <div className="glass-card overflow-hidden mb-10">
          {projectHistory.length ? (
            <div className="divide-y divide-border/70">
              {projectHistory.map((item) => {
                const sourceLabel =
                  item.projectType === "github"
                    ? item.repoUrl || "GitHub project"
                    : item.projectType === "local"
                    ? item.source?.replace(/^local:/, "") || "Local project"
                    : "Workspace";
                return (
                  <div key={item.runId} className="flex items-center justify-between gap-4 px-6 py-4">
                    <button
                      type="button"
                      onClick={() => void openRunWithReconnect(item.runId)}
                      className="min-w-0 text-left hover:opacity-90"
                    >
                      <div className="text-sm font-medium truncate">{sourceLabel}</div>
                      <div className="text-xs text-muted-foreground mt-1">
                        {item.branch ? `Branch: ${item.branch}` : "No branch"} •{" "}
                        {item.lastOpenedAt ? format(new Date(item.lastOpenedAt), "MMM d, h:mm a") : "No timestamp"}
                      </div>
                    </button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void deleteHistoryItem(item.runId)}
                      disabled={deletingHistoryRunId === item.runId}
                    >
                      <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                      {deletingHistoryRunId === item.runId ? "Deleting..." : "Delete"}
                    </Button>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="px-6 py-5 text-sm text-muted-foreground">No saved project history yet.</div>
          )}
        </div>

        <div className="mb-3 text-sm font-semibold tracking-tight text-muted-foreground">RECENT RUNS</div>

        {loading ? (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-14 w-full rounded-2xl" />
            ))}
          </div>
        ) : runs.length > 0 ? (
          <div className="glass-card overflow-hidden">
            <div className="divide-y divide-border/70">
              {runs.map((run) => (
                <button
                  key={run.id}
                  type="button"
                  onClick={() => void openRunWithReconnect(run.id)}
                  className="w-full text-left flex items-center justify-between px-6 py-4 hover:bg-muted/30 transition-colors"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <Play className="h-4 w-4 text-muted-foreground shrink-0" />
                    <span className="text-sm font-medium truncate">{run.title}</span>
                  </div>

                  <div className="flex items-center gap-4 shrink-0">
                    <span className={statusClass(run.status)}>{run.status}</span>
                    <span className="text-xs text-muted-foreground">{format(new Date(run.created_at), "MMM d, h:mm a")}</span>
                  </div>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="dashed-panel p-10 md:p-12 text-center relative overflow-hidden">
            <div className="mx-auto mb-6 h-16 w-16 rounded-3xl bg-card/40 border border-border/70 backdrop-blur-xl flex items-center justify-center">
              <span className="text-2xl font-extrabold tracking-tight grad-text">SM</span>
            </div>

            <div className="text-lg font-semibold">No runs yet</div>
            <div className="text-sm text-muted-foreground mt-2 max-w-md mx-auto">
              Your generated plans will appear here after you create your first run.
            </div>

            <div className="mt-6">
              <Button variant="outline" onClick={handleGeneratePlan} className="rounded-2xl px-5" disabled={!canGenerate}>
                <Sparkles className="mr-2 h-4 w-4" />
                Generate a Plan
              </Button>
            </div>
          </div>
        )}
      </div>
    </AppLayout>
  );
}

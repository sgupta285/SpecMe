import { useEffect, useMemo, useState } from "react";
import { useNavigate, Link, useSearchParams } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import AppLayout from "@/components/AppLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { Loader2, ArrowLeft } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { apiFetch } from "@/lib/api";
import ErrorDialog, { type ErrorDialogState } from "@/components/ErrorDialog";
import { buildUiError, parseApiErrorText } from "@/lib/errors";

type ProjectMode = "github" | "local";
type SyncErrorState = {
  message: string;
  reason?: string;
  availableBranches?: string[];
};

function parseStoredProject(repoUrl: string | null, repoBranch: string | null) {
  const raw = (repoUrl ?? "").trim();
  if (raw.startsWith("local:")) {
    return {
      mode: "local" as ProjectMode,
      localPath: raw.slice("local:".length),
      githubUrl: "",
      branch: repoBranch?.trim() || "",
    };
  }

  return {
    mode: "github" as ProjectMode,
    localPath: "",
    githubUrl: raw,
    branch: repoBranch?.trim() || "",
  };
}

export default function Sync() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [searchParams] = useSearchParams();

  const [mode, setMode] = useState<ProjectMode>("github");
  const [repoUrl, setRepoUrlState] = useState("");
  const [repoBranch, setRepoBranchState] = useState("");
  const [localPath, setLocalPath] = useState("");
  const [loading, setLoading] = useState(false);
  const [syncError, setSyncError] = useState<SyncErrorState | null>(null);
  const [selectedFallbackBranch, setSelectedFallbackBranch] = useState("");
  const [manualBranch, setManualBranch] = useState("");
  const [errorDialog, setErrorDialog] = useState<ErrorDialogState>({
    open: false,
    title: "",
    explanation: "",
    reason: "",
    nextSteps: "",
    technicalDetails: "",
  });

  useEffect(() => {
    if (!user) return;

    supabase
      .from("user_settings")
      .select("repo_url, repo_branch")
      .eq("user_id", user.id)
      .maybeSingle()
      .then(({ data, error }) => {
        if (error) {
          console.error(error);
          return;
        }

        const parsed = parseStoredProject(data?.repo_url ?? null, data?.repo_branch ?? null);
        setMode(parsed.mode);
        setLocalPath(parsed.localPath);
        setRepoUrlState(parsed.githubUrl);
        setRepoBranchState(parsed.branch);

        const requestedMode = searchParams.get("mode");
        if (requestedMode === "github" || requestedMode === "local") {
          setMode(requestedMode);
        }
      });
  }, [user, searchParams]);

  const currentProjectLabel = useMemo(() => {
    if (mode === "local") return localPath || null;
    return repoUrl || null;
  }, [mode, localPath, repoUrl]);

  const suggestedBranches = useMemo(() => {
    const branches = syncError?.availableBranches || [];
    return Array.from(new Set(branches.map((b) => b.trim()).filter((b) => b && !b.startsWith("spec-me/"))));
  }, [syncError?.availableBranches]);

  const handleSave = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!user) return;

    if (mode === "github" && !repoUrl.trim()) {
      toast({
        title: "Error",
        description: "Repository URL is required.",
        variant: "destructive",
      });
      return;
    }

    if (mode === "local" && !localPath.trim()) {
      toast({
        title: "Error",
        description: "Local project folder path is required.",
        variant: "destructive",
      });
      return;
    }

    await retrySyncWithBranch();
  };

  const retrySyncWithBranch = async (branchOverride?: string) => {
    if (!user) return;
    const cleanUrl = repoUrl.trim();
    const cleanLocalPath = localPath.trim();
    const effectiveBranch = branchOverride?.trim() || repoBranch.trim();

    setLoading(true);
    setSyncError(null);

    try {
      const res = await apiFetch("/api/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          mode === "github"
            ? { mode: "github", repoUrl: cleanUrl, repoBranch: effectiveBranch }
            : { mode: "local", localPath: cleanLocalPath }
        ),
      });

      const raw = await res.text();
      if (!res.ok) {
        let parsed: {
          error?: string;
          reason?: string;
          availableBranches?: string[];
          reasonMessage?: string;
          exactReason?: string;
          nextSteps?: string;
          technicalDetails?: string;
        } | null = null;
        try {
          parsed = JSON.parse(raw) as typeof parsed;
        } catch {
          parsed = null;
        }

        const branches = Array.isArray(parsed?.availableBranches) ? parsed.availableBranches : [];
        setSyncError({
          message: parsed?.error || raw || "Sync failed",
          reason: parsed?.reason,
          availableBranches: branches,
        });
        if (branches.length > 0) {
          const firstNonSafety = branches.find((b) => !b.startsWith("spec-me/"));
          setSelectedFallbackBranch((prev) => prev || firstNonSafety || branches[0]);
        } else {
          setSelectedFallbackBranch("");
        }
        const ui = buildUiError(
          parsed || parseApiErrorText(raw),
          "Project sync failed.",
          "Reconnect GitHub/local project and verify access before retrying."
        );
        setErrorDialog({
          open: true,
          title: "Project sync failed",
          explanation: "SpecMe could not connect to the selected project source.",
          reason: ui.reason,
          nextSteps: ui.nextSteps,
          technicalDetails: ui.technicalDetails || raw,
        });
        return;
      }

      let syncedBranch: string | null = null;
      try {
        const parsed = JSON.parse(raw) as { branch?: string | null };
        syncedBranch = parsed.branch?.trim() || null;
      } catch {
        syncedBranch = null;
      }

      const repoUrlForStorage = mode === "local" ? `local:${cleanLocalPath}` : cleanUrl;
      const branchForStorage = mode === "github" ? (syncedBranch || effectiveBranch || "main") : null;
      const { error: upsertErr } = await supabase.from("user_settings").upsert(
        {
          user_id: user.id,
          repo_url: repoUrlForStorage,
          repo_branch: branchForStorage,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id" }
      );
      if (upsertErr) throw upsertErr;

      // Update local state to match what was actually synced
      if (syncedBranch) setRepoBranchState(syncedBranch);

      toast({ title: "Project linked", description: "Saved and indexed successfully." });
      navigate("/dashboard");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Something went wrong";
      setErrorDialog({
        open: true,
        title: "Project sync failed",
        explanation: "SpecMe could not reach or authenticate with the selected project source.",
        reason: msg,
        nextSteps: "Check network access and credentials, then retry sync.",
        technicalDetails: err instanceof Error ? err.stack || err.message : String(err),
      });
    } finally {
      setLoading(false);
    }
  };

  const retrySync = async () => {
    await retrySyncWithBranch();
  };

  const applyFallbackBranchAndRetry = async () => {
    const chosen = manualBranch.trim() || selectedFallbackBranch.trim();
    if (!chosen) {
      toast({
        title: "Branch required",
        description: "Type a branch name or select an existing branch and retry.",
        variant: "destructive",
      });
      return;
    }
    setRepoBranchState(chosen);
    // Pass the branch directly to avoid React state race condition
    await retrySyncWithBranch(chosen);
  };

  return (
    <AppLayout repoUrl={currentProjectLabel}>
      <div className="max-w-lg mx-auto px-6 py-10 animate-fade-in">
        <Link
          to="/dashboard"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors mb-6"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to dashboard
        </Link>

        <h1 className="text-2xl font-bold tracking-tight text-foreground mb-1">Connect Project</h1>

        <p className="text-muted-foreground text-sm mb-8">
          Use either a GitHub repository or a local folder for analysis and file updates.
        </p>

        <div className="glass-card p-6">
          <form onSubmit={handleSave} className="space-y-5">
            <div className="flex gap-2">
              <Button type="button" variant={mode === "github" ? "default" : "outline"} onClick={() => setMode("github")} className="flex-1">
                GitHub Repo
              </Button>
              <Button type="button" variant={mode === "local" ? "default" : "outline"} onClick={() => setMode("local")} className="flex-1">
                Local Folder
              </Button>
            </div>

            {mode === "github" ? (
              <>
                <div className="space-y-2">
                  <Label htmlFor="repo_url">Repository URL *</Label>
                  <Input
                    id="repo_url"
                    value={repoUrl}
                    onChange={(e) => setRepoUrlState(e.target.value)}
                    placeholder="https://github.com/org/repo.git"
                    required
                    className="font-mono text-sm"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="repo_branch">Branch (optional)</Label>
                  <Input
                    id="repo_branch"
                    value={repoBranch}
                    onChange={(e) => setRepoBranchState(e.target.value)}
                    placeholder="main"
                    className="font-mono text-sm"
                  />
                </div>

                {repoUrl.trim() ? (
                  <a
                    href={repoUrl.trim()}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs text-primary underline underline-offset-2"
                  >
                    Open GitHub project
                  </a>
                ) : null}
              </>
            ) : (
              <div className="space-y-2">
                <Label htmlFor="local_path">Local project folder path *</Label>
                <Input
                  id="local_path"
                  value={localPath}
                  onChange={(e) => setLocalPath(e.target.value)}
                  placeholder="/Users/you/path/to/project"
                  required
                  className="font-mono text-sm"
                />
                <p className="text-xs text-muted-foreground">
                  Files will be analyzed and overwritten in this folder.
                </p>
              </div>
            )}

            <Button type="submit" className="w-full" disabled={loading}>
              {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save and Sync
            </Button>

            {syncError && (
              <div className="rounded-md border border-red-500/30 bg-red-500/10 p-3 text-sm">
                <div className="text-red-200 font-medium">GitHub sync failed</div>
                <div className="text-red-200 mt-1">{syncError.message}</div>

                {syncError.reason === "head_invalid" ? (
                  <div className="mt-3 space-y-2">
                    <div className="text-xs text-red-300/80">
                      The repository may be empty or in an invalid state. Try selecting a branch manually, or verify the repository has at least one commit.
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button type="button" variant="outline" onClick={() => void retrySync()} disabled={loading}>
                        Retry Sync
                      </Button>
                      <Button type="button" variant="outline" onClick={() => navigate("/sync")}>
                        Reconnect
                      </Button>
                    </div>
                  </div>
                ) : syncError.reason === "branch_selection_required" || syncError.reason === "branch_missing" ? (
                  <div className="mt-3 space-y-2">
                    <div className="text-xs text-red-300/80">
                      Type a branch name or select an existing branch and retry.
                    </div>
                    <Label htmlFor="fallback_branch">Select branch</Label>
                    {suggestedBranches.length > 0 ? (
                      <select
                        id="fallback_branch"
                        value={selectedFallbackBranch}
                        onChange={(e) => setSelectedFallbackBranch(e.target.value)}
                        className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm"
                      >
                        {suggestedBranches.map((b) => (
                          <option key={b} value={b}>
                            {b}
                          </option>
                        ))}
                      </select>
                    ) : null}
                    <Input
                      id="manual_branch"
                      value={manualBranch}
                      onChange={(e) => setManualBranch(e.target.value)}
                      placeholder="Type branch name (e.g. main, master, dev, feature/x)"
                      list="remote-branch-suggestions"
                      className="font-mono text-sm"
                    />
                    {suggestedBranches.length > 0 ? (
                      <datalist id="remote-branch-suggestions">
                        {suggestedBranches.map((b) => (
                          <option key={`suggestion-${b}`} value={b} />
                        ))}
                      </datalist>
                    ) : null}
                    {suggestedBranches.length > 0 ? (
                      <div className="text-xs text-red-300/80">
                        Available branches: {suggestedBranches.join(", ")}
                      </div>
                    ) : (
                      <div className="text-xs text-red-300/80">
                        Branch list could not be loaded. You can still type a branch name and retry.
                      </div>
                    )}
                    <div className="flex flex-wrap gap-2">
                      <Button type="button" variant="outline" onClick={() => void applyFallbackBranchAndRetry()} disabled={loading}>
                        Select/Type Branch
                      </Button>
                      <Button type="button" variant="outline" onClick={() => void retrySync()} disabled={loading}>
                        Retry Sync
                      </Button>
                      <Button type="button" variant="outline" onClick={() => navigate("/sync")}>
                        Reconnect
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button type="button" variant="outline" onClick={() => void retrySync()} disabled={loading}>
                      Retry Sync
                    </Button>
                    <Button type="button" variant="outline" onClick={() => navigate("/sync")}>
                      Reconnect
                    </Button>
                  </div>
                )}
              </div>
            )}
          </form>
        </div>
      </div>
      <ErrorDialog
        state={errorDialog}
        onOpenChange={(open) => setErrorDialog((prev) => ({ ...prev, open }))}
      />
    </AppLayout>
  );
}

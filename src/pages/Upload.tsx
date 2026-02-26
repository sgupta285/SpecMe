import { useEffect, useState } from "react";
import { useNavigate, useLocation, Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import type { Json } from "@/integrations/supabase/types";
import { useAuth } from "@/hooks/useAuth";
import AppLayout from "@/components/AppLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { Loader2, ArrowLeft, Sparkles } from "lucide-react";
import { apiFetch } from "@/lib/api";
import ErrorDialog, { type ErrorDialogState } from "@/components/ErrorDialog";
import { buildUiError, parseApiErrorText, shouldUseErrorDialog } from "@/lib/errors";
import { parseJsonText } from "@/lib/json";

interface LocationState {
  originRoute?: string;
  originTitle?: string;
  originUiText?: string;
  selectedText?: string;
  prefill?: string;
}

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

type AnalyzeResponse = {
  success: boolean;
  data?: SpecOutput;
  error?: string;
};

export default function Upload() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const { toast } = useToast();

  const state = location.state as LocationState | null;

  const [title, setTitle] = useState("");
  const [content, setContent] = useState(state?.prefill ? state.prefill : "");

  const [loading, setLoading] = useState(false);
  const [repoUrl, setRepoUrl] = useState<string | null>(null);

  const [feedbackId, setFeedbackId] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [projectReady, setProjectReady] = useState(false);
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
      .select("repo_url")
      .eq("user_id", user.id)
      .maybeSingle()
      .then(async ({ data, error }) => {
        if (error) {
          console.error("user_settings load error:", error);
          return;
        }

        if (!data?.repo_url) {
          toast({
            title: "No project linked",
            description: "Please connect a GitHub repo or local folder first.",
            variant: "destructive",
          });
          navigate("/sync");
          return;
        }

        setRepoUrl(data.repo_url);

        const projectRes = await apiFetch("/api/project").catch(() => null);
        if (!projectRes?.ok) {
          const raw = projectRes ? await projectRes.text() : "Could not verify active project state.";
          const parsed = parseApiErrorText(raw);
          const ui = buildUiError(
            parsed,
            "Could not verify active project state.",
            "Reconnect from Sync, then retry."
          );
          if (shouldUseErrorDialog(parsed.reason, ui.reason)) {
            setErrorDialog({
              open: true,
              title: "Project connection error",
              explanation: "SpecMe could not verify your active project source.",
              reason: ui.reason,
              nextSteps: ui.nextSteps,
              technicalDetails: ui.technicalDetails || raw,
            });
          } else {
            toast({
              title: "Project connection error",
              description: ui.reason,
              variant: "destructive",
            });
          }
          navigate("/sync");
          return;
        }
        const parsed = (await projectRes.json()) as {
          success?: boolean;
          project?: { mode?: string; connectionStatus?: string; lastConnectionError?: string | null };
        };
        const mode = parsed.project?.mode || "workspace";
        const connectionStatus = parsed.project?.connectionStatus || "disconnected";
        if (!parsed.success || mode === "workspace" || connectionStatus !== "connected") {
          toast({
            title: "Project not ready",
            description: parsed.project?.lastConnectionError || "Reconnect your project source from Sync.",
            variant: "destructive",
          });
          navigate("/sync");
          return;
        }
        setProjectReady(true);
      });
  }, [user, navigate, toast]);

  const handleSave = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!user) return;

    const cleanTitle = title.trim();
    const cleanContent = content.trim();

    if (!cleanTitle || !cleanContent) {
      toast({
        title: "Missing fields",
        description: "Please enter both a title and content.",
        variant: "destructive",
      });
      return;
    }

    setLoading(true);

    try {
      const { data, error } = await supabase
        .from("feedback")
        .insert({
          user_id: user.id,
          title: cleanTitle,
          content: cleanContent,
        })
        .select("id")
        .single();

      if (error) throw error;

      setFeedbackId(data.id);
      setSaved(true);
      toast({ title: "Feedback saved" });
    } catch (err: unknown) {
      toast({
        title: "Error",
        description:
          err instanceof Error ? err.message : "Something went wrong",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const handleGenerate = async () => {
    if (!user || !feedbackId) return;
    if (!projectReady) {
      toast({
        title: "Project not ready",
        description: "Reconnect your project source from Sync before generating.",
        variant: "destructive",
      });
      navigate("/sync");
      return;
    }

    setLoading(true);
    let openedDialog = false;

    // 1) create run row
    const { data: runData, error: runError } = await supabase
      .from("runs")
      .insert({
        user_id: user.id,
        feedback_id: feedbackId,
        status: "running",
      })
      .select("id")
      .single();

      if (runError || !runData?.id) {
      toast({
        title: "Error",
        description: runError?.message || "Failed to create run",
        variant: "destructive",
      });
      setLoading(false);
      return;
    }

      const runId = runData.id;

      try {
      // Record project context used for this run so old runs can auto-reconnect.
      await apiFetch("/api/runs/project", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId }),
      }).catch(() => {
        // Non-blocking: run can proceed even if mapping save fails.
      });

      // 2) call analysis server
      const response = await apiFetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: content,
          route: state?.originRoute || location.pathname,
          pageTitle: state?.originTitle || document.title,
          uiText: state?.originUiText || "",
          selectedText: state?.selectedText || "",
        }),
      });

      const raw = await response.text();
      if (!response.ok) {
        const parsed = parseApiErrorText(raw);
        const ui = buildUiError(
          parsed,
          "Generation failed.",
          "Retry in a moment. If this keeps happening, check Gemini configuration and quota."
        );
        if (shouldUseErrorDialog(parsed.reason, ui.reason)) {
          setErrorDialog({
            open: true,
            title: "Plan generation failed",
            explanation: "SpecMe could not generate this plan from the AI service.",
            reason: ui.reason,
            nextSteps: ui.nextSteps,
            technicalDetails: ui.technicalDetails || raw,
          });
          openedDialog = true;
        }
        throw new Error(ui.reason || raw || "Analysis server error");
      }

      const parsed = parseJsonText<AnalyzeResponse>(raw, "analyze API response");

      if (!parsed.success || !parsed.data) {
        throw new Error(
          parsed.error || "Server response missing expected fields (success/data)"
        );
      }

      const spec = parsed.data;

      // 3) store spec_output (must be Json per generated Supabase types)
      const { error: updateErr } = await supabase
        .from("runs")
        .update({
          status: "done",
          spec_output: spec as unknown as Json,
          error_message: null,
        })
        .eq("id", runId);

      if (updateErr) throw updateErr;

      navigate(`/runs/${runId}`);
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : "Failed to reach analysis server";

      // mark run as error so UI doesn't look blank
      await supabase
        .from("runs")
        .update({ status: "error", error_message: msg })
        .eq("id", runId);

      if (!openedDialog) {
        toast({
          title: "Error",
          description: msg,
          variant: "destructive",
        });
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <AppLayout repoUrl={repoUrl ?? null}>
      <div className="max-w-lg mx-auto px-6 py-10">
        <Link
          to="/dashboard"
          className="text-sm mb-6 inline-flex items-center gap-1"
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </Link>

        <div className="glass-card p-6">
          {!saved ? (
            <form onSubmit={handleSave} className="space-y-4">
              <div>
                <Label>Title</Label>
                <Input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  required
                />
              </div>

              <div>
                <Label>Content</Label>
                <Textarea
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  rows={6}
                  required
                />
              </div>

              <Button type="submit" disabled={loading}>
                {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Save Feedback
              </Button>
            </form>
          ) : (
            <Button onClick={handleGenerate} disabled={loading} size="lg">
              {loading ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Sparkles className="mr-2 h-4 w-4" />
              )}
              Generate Plan
            </Button>
          )}
        </div>
      </div>
      <ErrorDialog
        state={errorDialog}
        onOpenChange={(open) => setErrorDialog((prev) => ({ ...prev, open }))}
      />
    </AppLayout>
  );
}

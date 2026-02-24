import { ReactNode, useState } from "react";
import { Link, useNavigate, useLocation } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { LogOut, User, GitBranch } from "lucide-react";

interface AppLayoutProps {
  children: ReactNode;
  repoUrl?: string | null;
}

export default function AppLayout({ children, repoUrl }: AppLayoutProps) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [cmd, setCmd] = useState("");

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    navigate("/login");
  };

  const runCommand = () => {
    const trimmed = cmd.trim();
    if (!trimmed) return;

    // Cheap “screen text” grounding (non-tech UX).
    // Keep it short to avoid huge payloads.
    const uiText = (document.body?.innerText || "").slice(0, 1200);

    navigate("/upload", {
      state: {
        prefill: trimmed,
        originRoute: location.pathname,
        originTitle: document.title,
        originUiText: uiText,
      },
    });

    setCmd("");
  };

  return (
    <div className="app-shell grid-overlay flex flex-col">
      <header className="h-14 flex items-center px-6 shrink-0 border-b border-border/70 bg-background/40 backdrop-blur-xl">
        <Link to="/dashboard" className="flex items-center gap-3">
          <div className="h-9 w-9 rounded-2xl border border-border/70 bg-card/40 backdrop-blur-xl flex items-center justify-center shadow-[0_10px_40px_rgba(0,0,0,0.35)]">
            <span className="text-sm font-extrabold tracking-tight grad-text">
              SM
            </span>
          </div>
          <div className="leading-tight">
            <div className="font-semibold text-foreground tracking-tight">
              SpecMe
            </div>
          </div>
        </Link>

        <div className="flex-1 flex justify-center gap-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <GitBranch className="h-3.5 w-3.5" />
            <span className="font-mono text-xs truncate max-w-[320px]">
              {repoUrl || "No project linked"}
            </span>
          </div>

          <div className="flex items-center gap-2">
            <input
              value={cmd}
              onChange={(e) => setCmd(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") runCommand();
              }}
              placeholder="Describe what you want to change…"
              className="h-9 w-[340px] rounded-xl border border-border/70 bg-card/40 px-3 text-sm outline-none"
            />
            <Button size="sm" onClick={runCommand} disabled={!cmd.trim()}>
              Run
            </Button>
          </div>
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="gap-2 text-muted-foreground"
            >
              <User className="h-4 w-4" />
              <span className="text-xs truncate max-w-[160px]">
                {user?.email}
              </span>
            </Button>
          </DropdownMenuTrigger>

          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem
              onClick={handleSignOut}
              className="text-destructive"
            >
              <LogOut className="mr-2 h-4 w-4" />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      <main className="flex-1">{children}</main>
    </div>
  );
}

// src/pages/Login.tsx
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2 } from "lucide-react";

type Meta = { first_name?: string; last_name?: string; full_name?: string };

export default function Login() {
  const navigate = useNavigate();

  const [mode, setMode] = useState<"signin" | "signup">("signin");

  const [firstName, setFirstName] = useState<string>("");
  const [lastName, setLastName] = useState<string>("");

  const [email, setEmail] = useState<string>("");
  const [password, setPassword] = useState<string>("");

  const [loading, setLoading] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // When an existing user signs in and has no names, we show this extra step once.
  const [needsProfile, setNeedsProfile] = useState(false);

  const resetNames = () => {
    setFirstName("");
    setLastName("");
  };

  useEffect(() => {
    // If user toggles modes, reset the profile step
    setNeedsProfile(false);
    setErrorMsg(null);
  }, [mode]);

  const handleAuth = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setLoading(true);
    setErrorMsg(null);

    try {
      if (mode === "signin") {
        const { error } = await supabase.auth.signInWithPassword({
          email,
          password,
        });
        if (error) throw error;

        // Check if user has name metadata; if missing, prompt to complete profile
        const { data } = await supabase.auth.getUser();
        const meta = (data.user?.user_metadata as Meta | undefined) || {};
        const hasName =
          Boolean(meta.full_name?.trim()) ||
          (Boolean(meta.first_name?.trim()) && Boolean(meta.last_name?.trim()));

        if (!hasName) {
          setNeedsProfile(true);
          return; // stay on page, show name fields + Save button
        }

        navigate("/dashboard");
      } else {
        const fn = firstName.trim();
        const ln = lastName.trim();

        if (!fn || !ln)
          throw new Error("Please enter your first and last name.");

        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            data: {
              first_name: fn,
              last_name: ln,
              full_name: `${fn} ${ln}`,
            },
          },
        });
        if (error) throw error;

        navigate("/dashboard");
      }
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : "Authentication failed");
    } finally {
      setLoading(false);
    }
  };

  const handleSaveProfile = async () => {
    const fn = firstName.trim();
    const ln = lastName.trim();

    if (!fn || !ln) {
      setErrorMsg("Please enter your first and last name.");
      return;
    }

    setLoading(true);
    setErrorMsg(null);

    try {
      const { error } = await supabase.auth.updateUser({
        data: { first_name: fn, last_name: ln, full_name: `${fn} ${ln}` },
      });
      if (error) throw error;

      navigate("/dashboard");
    } catch (err: unknown) {
      setErrorMsg(
        err instanceof Error ? err.message : "Failed to save profile"
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-purple-950 to-slate-950 flex items-center justify-center text-white">
      <div className="w-full max-w-md p-8 bg-slate-900/60 backdrop-blur-xl rounded-2xl shadow-2xl border border-white/10">
        {/* Logo */}
        <div className="flex flex-col items-center mb-8">
          <div className="w-16 h-16 rounded-2xl bg-purple-600 flex items-center justify-center text-3xl font-bold shadow-lg">
            SM
          </div>
          <h1 className="mt-4 text-2xl font-bold tracking-tight">SpecMe</h1>
          <p className="text-sm text-slate-400 mt-1">
            AI-native spec generation workspace
          </p>
        </div>

        {/* Form */}
        <form onSubmit={handleAuth} className="space-y-5">
          {(mode === "signup" || needsProfile) && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="first_name" className="text-slate-300">
                  First name
                </Label>
                <Input
                  id="first_name"
                  type="text"
                  required
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  className="bg-slate-800 border-slate-700 text-white"
                  placeholder="First"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="last_name" className="text-slate-300">
                  Last name
                </Label>
                <Input
                  id="last_name"
                  type="text"
                  required
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  className="bg-slate-800 border-slate-700 text-white"
                  placeholder="Last"
                />
              </div>
            </div>
          )}

          {!needsProfile && (
            <>
              <div className="space-y-2">
                <Label htmlFor="email" className="text-slate-300">
                  Email
                </Label>
                <Input
                  id="email"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="bg-slate-800 border-slate-700 text-white"
                  placeholder="you@example.com"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="password" className="text-slate-300">
                  Password
                </Label>
                <Input
                  id="password"
                  type="password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="bg-slate-800 border-slate-700 text-white"
                  placeholder="••••••••"
                />
              </div>
            </>
          )}

          {needsProfile && (
            <div className="text-sm text-slate-300 bg-slate-800/40 p-3 rounded-md border border-slate-700">
              One-time setup: add your name so we can personalize your
              dashboard.
            </div>
          )}

          {errorMsg && (
            <div className="text-sm text-red-400 bg-red-900/30 p-2 rounded-md border border-red-500/30">
              {errorMsg}
            </div>
          )}

          {!needsProfile ? (
            <Button
              type="submit"
              disabled={loading}
              className="w-full bg-purple-600 hover:bg-purple-700 transition-colors"
            >
              {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {mode === "signin" ? "Sign In" : "Create Account"}
            </Button>
          ) : (
            <Button
              type="button"
              onClick={handleSaveProfile}
              disabled={loading}
              className="w-full bg-purple-600 hover:bg-purple-700 transition-colors"
            >
              {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save Name
            </Button>
          )}
        </form>

        {/* Toggle */}
        {!needsProfile && (
          <div className="mt-6 text-center text-sm text-slate-400">
            {mode === "signin" ? (
              <>
                Don’t have an account?{" "}
                <button
                  type="button"
                  onClick={() => {
                    setMode("signup");
                    setErrorMsg(null);
                  }}
                  className="text-purple-400 hover:text-purple-300 font-medium"
                >
                  Sign up
                </button>
              </>
            ) : (
              <>
                Already have an account?{" "}
                <button
                  type="button"
                  onClick={() => {
                    setMode("signin");
                    resetNames();
                    setErrorMsg(null);
                  }}
                  className="text-purple-400 hover:text-purple-300 font-medium"
                >
                  Sign in
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

import { FormEvent, useEffect, useState } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { startLogin } from "@/const";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CheckCircle2, LockKeyhole, ShieldAlert, ArrowRight } from "lucide-react";
import { toast } from "sonner";

export default function TeamAcceptPage() {
  const [, setLocation] = useLocation();
  const { user, loading } = useAuth();
  const [invitationCode, setInvitationCode] = useState("");
  const [autoSubmitted, setAutoSubmitted] = useState(false);

  // Extract code from URL query parameter if present
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code") || params.get("invitationCode");
    if (code && !invitationCode) {
      setInvitationCode(code);
    }
  }, [invitationCode]);

  const accept = trpc.team.accept.useMutation({
    onSuccess: result => {
      try {
        sessionStorage.setItem("freelancehr-active-workspace", String(result.ownerId));
      } catch {
        /* session storage is optional */
      }
      toast.success(`Team invitation accepted! Assigned role: ${result.role}.`);
      window.setTimeout(() => {
        setLocation("/");
        window.location.reload();
      }, 1000);
    },
    onError: error => {
      toast.error(error.message || "Failed to accept team invitation.");
    },
  });

  // Auto-attempt acceptance if code exists and user is logged in
  useEffect(() => {
    if (user && invitationCode && invitationCode.length >= 24 && !autoSubmitted && !accept.isPending && !accept.isSuccess) {
      setAutoSubmitted(true);
      accept.mutate({ invitationCode });
    }
  }, [user, invitationCode, autoSubmitted, accept]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const code = invitationCode.trim();
    if (code.length < 24) {
      toast.error("Invitation code must be at least 24 characters.");
      return;
    }
    accept.mutate({ invitationCode: code });
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-[#f7f5f0] flex items-center justify-center p-4">
        <p className="text-sm text-slate-500">Checking authentication status…</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#f7f5f0] flex items-center justify-center p-4 sm:p-6 text-slate-950">
      <div className="w-full max-w-lg">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-[#10213d] text-sm font-black tracking-[0.2em] text-[#f5d77b]">
            FH
          </div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#a47d2c]">
            Controlled Operations
          </p>
          <h1 className="mt-2 text-2xl sm:text-3xl font-semibold tracking-tight text-[#10213d]">
            Accept Team Invitation
          </h1>
          <p className="mt-2 text-sm text-slate-600">
            Join your organization's private recruiting workspace with least-privilege operational access.
          </p>
        </div>

        <Card className="border-slate-200 bg-white shadow-[0_12px_35px_-28px_rgba(15,23,42,0.35)]">
          <CardContent className="p-6 sm:p-8">
            {!user ? (
              <div className="space-y-4 text-center">
                <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-amber-50 text-amber-600">
                  <LockKeyhole className="h-5 w-5" />
                </div>
                <h2 className="text-base font-semibold text-[#10213d]">Authentication Required</h2>
                <p className="text-xs leading-5 text-slate-600">
                  You must sign in with the specific work email address that received this invitation.
                </p>
                <Button
                  onClick={() => startLogin()}
                  className="w-full bg-[#10213d] text-white hover:bg-[#1a3156]"
                >
                  Sign in to continue <ArrowRight className="ml-2 h-4 w-4" />
                </Button>
              </div>
            ) : accept.isSuccess ? (
              <div className="space-y-4 text-center">
                <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-emerald-50 text-emerald-600">
                  <CheckCircle2 className="h-6 w-6" />
                </div>
                <h2 className="text-lg font-semibold text-[#10213d]">Invitation Accepted!</h2>
                <p className="text-xs leading-5 text-slate-600">
                  Your team access has been verified and activated. Redirecting you to your controlled workspace…
                </p>
                <Button
                  onClick={() => {
                    setLocation("/");
                    window.location.reload();
                  }}
                  className="bg-[#10213d] text-white"
                >
                  Enter Workspace
                </Button>
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <Label htmlFor="invitationCode">One-time Invitation Code</Label>
                  <Input
                    id="invitationCode"
                    value={invitationCode}
                    onChange={e => setInvitationCode(e.target.value)}
                    placeholder="Paste your 24+ character invitation code"
                    required
                    minLength={24}
                    className="mt-1 font-mono text-xs"
                    autoComplete="off"
                  />
                  <p className="mt-1.5 text-[11px] text-slate-500">
                    Signing in as <span className="font-semibold text-slate-700">{user.email || user.name}</span>.
                  </p>
                </div>

                {accept.error && (
                  <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-800 flex items-start gap-2">
                    <ShieldAlert className="h-4 w-4 shrink-0 text-red-600 mt-0.5" />
                    <div>
                      <p className="font-medium">Invitation Verification Failed</p>
                      <p className="mt-0.5 text-red-700">{accept.error.message}</p>
                    </div>
                  </div>
                )}

                <Button
                  type="submit"
                  disabled={accept.isPending || invitationCode.length < 24}
                  className="w-full bg-[#10213d] text-white hover:bg-[#1a3156]"
                >
                  {accept.isPending ? "Validating & Activating…" : "Activate Team Access"}
                </Button>
              </form>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

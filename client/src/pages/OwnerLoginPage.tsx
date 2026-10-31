import { useState, type FormEvent } from "react";
import { LockKeyhole } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { startLogin } from "@/const";

export default function OwnerLoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/auth/owner/login", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const result = await response.json();
      if (!response.ok) { setError(result.error || "Sign-in could not be completed."); return; }
      window.location.replace("/");
    } catch { setError("Unable to connect. Please try again."); }
    finally { setBusy(false); }
  }
  return <main className="flex min-h-screen items-center justify-center bg-[#f7f5f0] p-5 text-slate-950">
    <section className="w-full max-w-md rounded-[2rem] border border-slate-200 bg-white p-8 shadow-xl sm:p-10">
      <div className="mb-7 flex h-12 w-12 items-center justify-center rounded-2xl bg-[#10213d] font-black tracking-widest text-[#f5d77b]">FH</div>
      <p className="text-xs font-semibold uppercase tracking-widest text-[#a47d2c]">Personal workspace</p>
      <h1 className="mt-3 text-3xl font-semibold text-[#10213d]">Owner sign in</h1>
      <p className="mt-3 text-sm leading-6 text-slate-600">Access your private recruitment workspace.</p>
      {import.meta.env.VITE_AUTH_MODE === "owner_password" ? <form onSubmit={submit} className="mt-7 space-y-5">
        <div className="space-y-2"><Label htmlFor="owner-email">Email</Label><Input id="owner-email" name="email" type="email" autoComplete="username" required maxLength={320} value={email} onChange={event => setEmail(event.target.value)} /></div>
        <div className="space-y-2"><Label htmlFor="owner-password">Password</Label><Input id="owner-password" name="password" type="password" autoComplete="current-password" required maxLength={256} value={password} onChange={event => setPassword(event.target.value)} /></div>
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        <Button type="submit" disabled={busy} className="w-full bg-[#10213d] text-white hover:bg-[#1a3156]"><LockKeyhole className="mr-2 h-4 w-4" />{busy ? "Signing in…" : "Sign in"}</Button>
      </form> : <Button onClick={startLogin} className="mt-7 w-full">Continue to sign in</Button>}
    </section>
  </main>;
}

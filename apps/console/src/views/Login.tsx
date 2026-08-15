import { useState, type FormEvent } from 'react';
import { useAtlas } from '../store.ts';
import { ApiError } from '../lib/api.ts';

export function LoginView() {
  const login = useAtlas((s) => s.login);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login(email.trim(), password);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reach ATLAS. Is the server running?');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative flex h-full items-center justify-center overflow-hidden bg-[--color-void] px-6">
      {/* Ambient backdrop echoing the village's night sky. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-70"
        style={{
          background:
            'radial-gradient(ellipse at 20% 10%, rgba(56,189,248,0.16), transparent 55%), radial-gradient(ellipse at 80% 80%, rgba(167,139,250,0.14), transparent 55%)',
        }}
      />
      <div aria-hidden className="pointer-events-none absolute inset-0 scanline opacity-40" />

      <div className="relative w-full max-w-sm animate-rise">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 grid size-14 place-items-center rounded-2xl bg-gradient-to-br from-sky-600 to-cyan-400 text-2xl font-bold text-[#04121e] shadow-2xl">
            A
          </div>
          <h1 className="font-display text-2xl font-semibold tracking-tight">ATLAS OS</h1>
          <p className="mt-1.5 text-sm text-[--color-muted]">
            Le système d’exploitation d’une organisation autonome.
          </p>
        </div>

        <form onSubmit={submit} className="panel space-y-4 p-6">
          <div>
            <label className="label" htmlFor="email">
              Email
            </label>
            <input
              id="email"
              type="email"
              className="input"
              value={email}
              autoComplete="username"
              required
              onChange={(e) => setEmail(e.target.value)}
              placeholder="founder@atlas.local"
            />
          </div>

          <div>
            <label className="label" htmlFor="password">
              Password
            </label>
            <input
              id="password"
              type="password"
              className="input"
              value={password}
              autoComplete="current-password"
              required
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
            />
          </div>

          {error && (
            <div role="alert" className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
              {error}
            </div>
          )}

          <button type="submit" className="btn btn-primary w-full" disabled={busy}>
            {busy ? 'Connexion…' : 'Entrer dans ATLAS'}
          </button>
        </form>

        <p className="mt-5 text-center text-xs text-[--color-faint]">
          Identifiants définis par <code className="text-[--color-muted]">ATLAS_FOUNDER_EMAIL</code> and{' '}
          <code className="text-[--color-muted]">ATLAS_FOUNDER_PASSWORD</code>.
        </p>
      </div>
    </div>
  );
}

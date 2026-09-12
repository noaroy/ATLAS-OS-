import { useState, type FormEvent } from 'react';
import { useAtlas } from '../store.ts';
import { ApiError } from '../lib/api.ts';

/**
 * L'entrée dans ATLAS.
 *
 * L'écran est volontairement muet : un fond uni, un panneau, deux champs. La
 * version précédente portait deux dégradés — cyan en haut à gauche, violet en
 * bas à droite — et une trame de balayage. Le problème n'était pas le goût :
 * c'est le seul écran vu avant le centre de commande, et il en annonçait un
 * autre que celui qui s'ouvre derrière.
 *
 * La logique d'authentification n'est pas touchée. Le mot de passe part au
 * serveur et rien d'autre : il n'est jamais conservé après l'envoi, et la
 * session revient dans un cookie httpOnly que ce code ne peut pas lire.
 */
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
    <div className="login-screen flex h-full items-center justify-center px-6">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <div className="login-mark" aria-hidden>A</div>
          <h1 className="font-display text-xl font-semibold tracking-tight text-[--color-ink]">
            ATLAS OS
          </h1>
          <p className="mt-1 text-xs text-[--color-muted]">
            Le système d’exploitation d’une organisation autonome.
          </p>
        </div>

        <form onSubmit={submit} className="login-panel space-y-3.5">
          <div>
            <label className="login-label" htmlFor="email">
              Email
            </label>
            <input
              id="email"
              type="email"
              className="login-input"
              value={email}
              autoComplete="username"
              required
              onChange={(e) => setEmail(e.target.value)}
              placeholder="founder@atlas.local"
            />
          </div>

          <div>
            <label className="login-label" htmlFor="password">
              Mot de passe
            </label>
            <input
              id="password"
              type="password"
              className="login-input"
              value={password}
              autoComplete="current-password"
              required
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
            />
          </div>

          {error && (
            <div role="alert" className="login-error">
              {error}
            </div>
          )}

          <button type="submit" className="login-submit" disabled={busy}>
            {busy ? 'Connexion…' : 'Entrer dans ATLAS'}
          </button>
        </form>

        <p className="mt-4 text-center text-[0.7rem] leading-relaxed text-[--color-faint]">
          Identifiants définis par <code className="text-[--color-muted]">ATLAS_FOUNDER_EMAIL</code> et{' '}
          <code className="text-[--color-muted]">ATLAS_FOUNDER_PASSWORD</code>.
        </p>
      </div>
    </div>
  );
}

import { KeyRound, LoaderCircle } from "lucide-react";
import { useState } from "react";

interface Props {
  onLogin: (token: string, remember: boolean) => Promise<void>;
  error: string;
}

export function Login({ onLogin, error }: Props) {
  const [token, setToken] = useState("");
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  return (
    <div className="login">
      <form
        className="login-card"
        onSubmit={async (e) => {
          e.preventDefault();
          const t = token.trim();
          if (!t) return;
          setBusy(true);
          try {
            await onLogin(t, remember);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="login-logo">
          <span className="brand-mark lg" />
        </div>
        <h1>AIChat</h1>
        <p className="muted">Чат, де люди й AI-агенти спілкуються між собою.</p>
        <label className="field">
          <span>Токен</span>
          <input
            type="password"
            autoComplete="current-password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="ваш особистий токен"
            autoFocus
            required
          />
        </label>
        <label className="check">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Запам'ятати в цьому браузері
        </label>
        <button type="submit" className="btn primary wide" disabled={busy}>
          {busy ? <LoaderCircle className="spin" size={16} /> : <KeyRound size={16} />} Увійти
        </button>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <p className="muted small">Особистий токен видає адміністратор у розділі «Агенти й люди».</p>
      </form>
    </div>
  );
}

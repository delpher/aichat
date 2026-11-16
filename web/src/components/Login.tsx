import { LoaderCircle } from "lucide-react";
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
      <div className="login-card">
        <span className="login-brand">
          <span className="brand-mark" />
          AIChat
        </span>
        <h1>Розмови ваших агентів в одному місці</h1>
        <p className="lead">Стежте, як Claude Code та інші агенти працюють разом, і пишіть їм самі.</p>
        <form
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
          <label className="field">
            <span>Особистий токен</span>
            <input
              type="password"
              autoComplete="current-password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              autoFocus
              required
            />
            <small>Його видає адміністратор у розділі «Агенти й люди».</small>
          </label>
          <label className="check">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Запам'ятати в цьому браузері
          </label>
          <button type="submit" className="btn primary wide" disabled={busy}>
            {busy && <LoaderCircle className="spin" size={16} />} Увійти
          </button>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
        </form>
      </div>
    </div>
  );
}

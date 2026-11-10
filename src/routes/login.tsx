import { useState, type FormEvent } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { authClient } from "@/lib/auth/client";
import { RedirectToSignIn } from "@/lib/auth/gates";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { formatRuPhone, identityEmail, normalizeRuPhone } from "@/lib/phone";

export const Route = createFileRoute("/login")({ component: Login });

type Mode = "in" | "up";

function explain(message: string, mode: Mode): string {
  const text = message.toLowerCase();
  if (text.includes("exist") || text.includes("already")) {
    return "Этот номер уже зарегистрирован. Переключитесь на вход.";
  }
  if (text.includes("invalid email or password") || text.includes("user not found")) {
    return "Неверный номер или пароль.";
  }
  if (text.includes("invalid email")) return "Номер выглядит неверно.";
  if (text.includes("password") && (text.includes("short") || text.includes("length") || text.includes("least"))) {
    return "Пароль слишком короткий: нужно хотя бы 8 символов.";
  }
  if (mode === "in") return "Неверный номер или пароль.";
  return "Не удалось зарегистрироваться. Проверьте номер и пароль.";
}

function Login() {
  const { user, isPending } = useCurrentUserState();
  const navigate = useNavigate();
  const [mode, setMode] = useState<Mode>("up");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  if (isPending) {
    return (
      <main className="shell">
        <p className="eyebrow">вход</p>
        <h1 className="brand">Pixel Mood</h1>
      </main>
    );
  }
  if (user) return <RedirectToSignIn to="/" />;

  function switchMode(next: Mode) {
    setMode(next);
    setError("");
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    const number = normalizeRuPhone(phone);
    if (!number || password.length < 8) {
      setError("Нужен российский номер — с +7 или с 8 — и пароль от 8 символов.");
      return;
    }
    if (mode === "up") {
      if (name.trim().length < 2) {
        setError("Как к вам обращаться? Хотя бы два символа.");
        return;
      }
      if (password !== again) {
        setError("Пароли не совпадают.");
        return;
      }
    }
    const mail = identityEmail(number);
    if (!mail) {
      setError("Номер выглядит неверно.");
      return;
    }
    setBusy(true);
    const result =
      mode === "up"
        ? await authClient.signUp.email({ email: mail, password, name: name.trim() })
        : await authClient.signIn.email({ email: mail, password });
    setBusy(false);
    if (result.error) {
      setError(explain(result.error.message || "", mode));
      return;
    }
    await navigate({ to: "/" });
  }

  return (
    <main className="shell">
      <section className="auth-card">
        <p className="eyebrow">аккаунт</p>
        <div className="auth-tabs" role="tablist" aria-label="Регистрация или вход">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "up"}
            className={mode === "up" ? "auth-tab is-on" : "auth-tab"}
            onClick={() => switchMode("up")}
          >
            Регистрация
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "in"}
            className={mode === "in" ? "auth-tab is-on" : "auth-tab"}
            onClick={() => switchMode("in")}
          >
            Вход
          </button>
        </div>
        <h1>{mode === "up" ? "Новый аккаунт" : "С возвращением"}</h1>
        <p className="lede">
          {mode === "up"
            ? "Имя и фото живут в аккаунте. Сетка года остаётся на этом устройстве."
            : "Войдите тем же номером. +7 и 8 — это один телефон."}
        </p>
        <form className="auth-form" onSubmit={(event) => void submit(event)}>
          {mode === "up" ? (
            <label className="date-field">
              Имя
              <input value={name} autoComplete="name" onChange={(event) => setName(event.target.value)} />
            </label>
          ) : null}
          <label className="date-field">
            Телефон
            <input
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              placeholder="+7 или 8 900 000-00-00"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
            />
          </label>
          {normalizeRuPhone(phone) ? (
            <p className="progress-note">Это номер {formatRuPhone(normalizeRuPhone(phone) as string)}</p>
          ) : null}
          <label className="date-field">
            Пароль
            <input
              type="password"
              autoComplete={mode === "up" ? "new-password" : "current-password"}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          {mode === "up" ? (
            <label className="date-field">
              Пароль ещё раз
              <input
                type="password"
                autoComplete="new-password"
                value={again}
                onChange={(event) => setAgain(event.target.value)}
              />
            </label>
          ) : null}
          {error ? <p className="form-error">{error}</p> : null}
          <div className="auth-actions">
            <button type="submit" className="today-btn" disabled={busy}>
              {busy ? "Секунду…" : mode === "up" ? "Зарегистрироваться" : "Войти"}
            </button>
          </div>
        </form>
      </section>
    </main>
  );
}

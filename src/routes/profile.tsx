import { useEffect, useRef, useState, type FormEvent } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { UserButton } from "@/lib/auth/gates";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { fileToAvatar } from "@/lib/avatar";
import { getProfile } from "@/lib/profile.functions";
import { useMoodStore } from "@/pixel-mood-core";

export const Route = createFileRoute("/profile")({ component: ProfilePage });

function ProfilePage() {
  const { user, isPending } = useCurrentUserState();
  const fileRef = useRef<HTMLInputElement>(null);
  const bindOwner = useMoodStore((state) => state.bindOwner);
  const ready = useMoodStore((state) => state.ready && state.authId === user?.id);
  const seeded = useMoodStore((state) => state.seeded);
  const accounts = useMoodStore((state) => state.accounts);
  const activeId = useMoodStore((state) => state.activeId);
  const seedFromServer = useMoodStore((state) => state.seedFromServer);
  const setActiveProfile = useMoodStore((state) => state.setActiveProfile);
  const switchAccount = useMoodStore((state) => state.switchAccount);
  const [name, setName] = useState("");
  const [avatar, setAvatar] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

  useEffect(() => {
    if (user?.id) bindOwner(user.id);
  }, [bindOwner, user?.id]);

  useEffect(() => {
    if (!user?.id || !ready || seeded) return;
    let live = true;
    getProfile()
      .then((next) => {
        if (live) seedFromServer(next.displayName || user.displayName || "", next.avatar);
      })
      .catch(() => {
        if (live) seedFromServer(user.displayName || "", null);
      });
    return () => {
      live = false;
    };
  }, [ready, seedFromServer, seeded, user?.displayName, user?.id]);

  useEffect(() => {
    if (!seeded) return;
    const current = useMoodStore.getState();
    const account = current.accounts.find((item) => item.id === current.activeId);
    setName(account?.name ?? "");
    setAvatar(account?.avatar ?? null);
    setNote("");
    setError("");
  }, [activeId, seeded]);

  if (isPending || (user && (!ready || !seeded))) {
    return (
      <main className="shell">
        <p className="eyebrow">профиль</p>
        <h1 className="brand">Pixel Mood</h1>
      </main>
    );
  }
  if (!user) {
    return (
      <main className="shell">
        <section className="auth-card">
          <h1>Сначала войдите</h1>
          <p className="lede">Профиль открывается после входа.</p>
          <Link to="/login" className="today-btn">
            Ко входу
          </Link>
        </section>
      </main>
    );
  }

  const active = accounts.find((item) => item.id === activeId) ?? null;
  const shown = name.trim() || active?.name || "Вы";
  const initial = shown.charAt(0).toUpperCase();

  async function onFile(file: File | undefined) {
    if (!file) return;
    setError("");
    try {
      setAvatar(await fileToAvatar(file));
      setNote("Фото подготовлено. Нажмите «Сохранить».");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось прочитать фото");
    }
  }

  function save(event: FormEvent) {
    event.preventDefault();
    setActiveProfile(name.trim(), avatar);
    setNote("Сохранено для этого аккаунта");
  }

  return (
    <main className="shell">
      <section className="auth-card">
        <p className="eyebrow">аккаунты</p>
        <h1>Профиль</h1>
        <p className="lede">У каждого аккаунта свои имя, фото и сетка года.</p>
        <div className="account-switch">
          <ul className="account-list">
            {accounts.map((account) => {
              const on = account.id === activeId;
              const label = account.name || "Без имени";
              return (
                <li key={account.id} className={on ? "account-row is-on" : "account-row"}>
                  <button type="button" className="account-open" onClick={() => switchAccount(account.id)}>
                    {account.avatar ? (
                      <img className="avatar" src={account.avatar} alt="" />
                    ) : (
                      <span className="avatar avatar-fallback" aria-hidden="true">
                        {(label.charAt(0) || "•").toUpperCase()}
                      </span>
                    )}
                    <span>
                      <span className="account-name">{label}</span>
                      <span className="account-kicker">{on ? "сейчас открыт" : "открыть"}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
        <form className="auth-form" onSubmit={save}>
          <div className="avatar-pick">
            {avatar ? (
              <img className="avatar avatar-lg" src={avatar} alt="" />
            ) : (
              <span className="avatar avatar-lg avatar-fallback" aria-hidden="true">
                {initial}
              </span>
            )}
            <div className="auth-actions">
              <button type="button" className="ghost-btn" onClick={() => fileRef.current?.click()}>
                Фото
              </button>
              {avatar ? (
                <button
                  type="button"
                  className="text-btn"
                  onClick={() => {
                    setAvatar(null);
                    setNote("Фото будет убрано после сохранения.");
                  }}
                >
                  Убрать
                </button>
              ) : null}
            </div>
            <input
              ref={fileRef}
              className="sr-only"
              type="file"
              accept="image/*"
              onChange={(event) => void onFile(event.target.files?.[0])}
            />
          </div>
          <label className="date-field">
            Имя
            <input value={name} maxLength={32} onChange={(event) => setName(event.target.value)} />
          </label>
          {error ? <p className="form-error">{error}</p> : null}
          {note ? <p className="progress-note">{note}</p> : null}
          <div className="auth-actions">
            <button type="submit" className="today-btn">
              Сохранить
            </button>
            <Link to="/" className="ghost-btn">
              На главную
            </Link>
          </div>
        </form>
        <div className="sheet-foot">
          <UserButton />
        </div>
      </section>
    </main>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import {
  MOODS,
  YEAR_MAX,
  YEAR_MIN,
  buildYear,
  dotScale,
  formatLong,
  habitCount,
  habitStampOf,
  isoDate,
} from "@/pixel-mood-core";
import { RedirectToSignIn } from "@/lib/auth/gates";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import {
  answerFriend,
  findPerson,
  getFriendJournal,
  listFriends,
  listMessages,
  requestFriend,
  sendMessage,
  type ChatMessage,
  type FriendRow,
  type Person,
  type SharedJournal,
} from "@/lib/social.functions";

export const Route = createFileRoute("/friends")({ component: FriendsPage });

function FriendsPage() {
  const { user, isPending } = useCurrentUserState();
  const [friends, setFriends] = useState<FriendRow[]>([]);
  const [email, setEmail] = useState("");
  const [found, setFound] = useState<Person | null | undefined>(undefined);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [pane, setPane] = useState<"chat" | "year">("chat");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  const refreshFriends = useCallback(async () => {
    const rows = await listFriends();
    setFriends(rows);
    return rows;
  }, []);

  const refreshMessages = useCallback(async (friendId: string) => {
    const rows = await listMessages({ data: { friendId } });
    setMessages(rows);
  }, []);

  useEffect(() => {
    if (!user) return;
    let live = true;
    refreshFriends().catch((err) => {
      if (live) setError(err instanceof Error ? err.message : "Не удалось открыть друзей");
    });
    const timer = window.setInterval(() => {
      refreshFriends().catch(() => undefined);
    }, 8000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [refreshFriends, user]);

  useEffect(() => {
    if (!user || !activeId) return;
    let live = true;
    refreshMessages(activeId).catch(() => {
      if (live) setError("Не удалось открыть переписку");
    });
    const timer = window.setInterval(() => {
      refreshMessages(activeId).catch(() => undefined);
    }, 3000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [activeId, refreshMessages, user]);

  useEffect(() => {
    const node = logRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages]);

  if (isPending) {
    return (
      <main className="shell">
        <p className="eyebrow">друзья</p>
        <h1 className="brand">Pixel Mood</h1>
      </main>
    );
  }
  if (!user) return <RedirectToSignIn />;

  const active = friends.find((friend) => friend.id === activeId && friend.status === "accepted") ?? null;
  const incoming = friends.filter((friend) => friend.incoming);
  const outgoing = friends.filter((friend) => friend.status === "pending" && !friend.incoming);
  const accepted = friends.filter((friend) => friend.status === "accepted");

  async function search(event: FormEvent) {
    event.preventDefault();
    setError("");
    setNote("");
    setFound(undefined);
    try {
      setFound(await findPerson({ data: { email } }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось найти");
    }
  }

  async function addFound() {
    setBusy(true);
    setError("");
    try {
      const result = await requestFriend({ data: { email } });
      setNote(result.note);
      setFound(undefined);
      setEmail("");
      await refreshFriends();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось добавить");
    } finally {
      setBusy(false);
    }
  }

  async function answer(friendshipId: string, accept: boolean) {
    setError("");
    await answerFriend({ data: { friendshipId, accept } });
    const rows = await refreshFriends();
    if (!accept && activeId && !rows.some((friend) => friend.id === activeId && friend.status === "accepted")) {
      setActiveId(null);
      setMessages([]);
    }
  }

  async function submitMessage(event: FormEvent) {
    event.preventDefault();
    if (!active || !draft.trim()) return;
    const body = draft;
    setDraft("");
    setError("");
    try {
      const message = await sendMessage({ data: { friendId: active.id, body } });
      setMessages((current) => [...current, message]);
    } catch (err) {
      setDraft(body);
      setError(err instanceof Error ? err.message : "Сообщение не ушло");
    }
  }

  return (
    <main className="shell">
      <div className="chat-head">
        <div>
          <p className="eyebrow">друзья</p>
          <h1>Переписка</h1>
        </div>
        <Link to="/" className="icon-btn friends-link" aria-label="К году">
          <CalendarDays />
        </Link>
      </div>
      <p className="lede">Принятый друг видит ваш год. Его календарь — иконка рядом с именем.</p>
      <div className="chat-layout">
        <section className="chat-pane" aria-label="Диалог">
          {active && pane === "year" ? (
            <FriendYear friendId={active.id} name={active.name} />
          ) : active ? (
            <>
              <p className="chat-with">{active.name}</p>
              <div className="chat-log" ref={logRef}>
                {messages.length === 0 ? <p className="progress-note">Пока тишина. Напишите первым.</p> : null}
                {messages.map((message) => (
                  <p key={message.id} className={message.mine ? "bubble mine" : "bubble"}>
                    {message.body}
                  </p>
                ))}
              </div>
              <form className="chat-compose" onSubmit={(event) => void submitMessage(event)}>
                <input
                  value={draft}
                  maxLength={500}
                  placeholder="Сообщение"
                  onChange={(event) => setDraft(event.target.value)}
                />
                <button type="submit" className="today-btn" disabled={!draft.trim()}>
                  Отправить
                </button>
              </form>
            </>
          ) : (
            <p className="progress-note">Выберите друга в списке, чтобы открыть переписку.</p>
          )}
          {error ? <p className="form-error">{error}</p> : null}
        </section>
        <aside className="friend-side">
          <form className="auth-form" onSubmit={(event) => void search(event)}>
            <label className="date-field">
              Телефон или почта
              <input
                type="text"
                value={email}
                autoComplete="off"
                placeholder="+7 или почта"
                onChange={(event) => setEmail(event.target.value)}
              />
            </label>
            <button type="submit" className="ghost-btn">
              Найти
            </button>
          </form>
          {found ? (
            <div className="friend-hit">
              <PersonFace person={found} />
              <button type="button" className="today-btn" disabled={busy} onClick={() => void addFound()}>
                Добавить
              </button>
            </div>
          ) : null}
          {found === null ? <p className="form-error">Такой почты нет. Пусть друг сначала зарегистрируется.</p> : null}
          {note ? <p className="progress-note">{note}</p> : null}
          {incoming.length ? (
            <div className="friend-block">
              <p className="eyebrow">заявки</p>
              <ul className="account-list">
                {incoming.map((friend) => (
                  <li key={friend.friendshipId} className="friend-request">
                    <PersonFace person={friend} />
                    <div className="auth-actions">
                      <button type="button" className="today-btn" onClick={() => void answer(friend.friendshipId, true)}>
                        Принять
                      </button>
                      <button type="button" className="text-btn" onClick={() => void answer(friend.friendshipId, false)}>
                        Отклонить
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <div className="friend-block">
            <p className="eyebrow">друзья · {accepted.length}</p>
            {accepted.length === 0 ? <p className="progress-note">Пока никого.</p> : null}
            <ul className="account-list">
              {accepted.map((friend) => (
                <li key={friend.id} className="friend-row">
                  <button
                    type="button"
                    className={friend.id === activeId && pane === "chat" ? "account-open is-on" : "account-open"}
                    onClick={() => {
                      setActiveId(friend.id);
                      setPane("chat");
                    }}
                  >
                    <PersonFace person={friend} bare />
                  </button>
                  <button
                    type="button"
                    className={friend.id === activeId && pane === "year" ? "icon-btn friends-link is-on" : "icon-btn friends-link"}
                    aria-label={`Календарь: ${friend.name}`}
                    onClick={() => {
                      setActiveId(friend.id);
                      setPane("year");
                    }}
                  >
                    <CalendarDays />
                  </button>
                </li>
              ))}
            </ul>
          </div>
          {outgoing.length ? (
            <div className="friend-block">
              <p className="eyebrow">ждут ответа</p>
              <ul className="account-list">
                {outgoing.map((friend) => (
                  <li key={friend.friendshipId} className="friend-request">
                    <PersonFace person={friend} />
                    <button type="button" className="text-btn" onClick={() => void answer(friend.friendshipId, false)}>
                      Отменить
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </aside>
      </div>
    </main>
  );
}

const DOW = ["пн", "", "ср", "", "пт", "", ""];

function FriendYear({ friendId, name }: { friendId: string; name: string }) {
  const [journal, setJournal] = useState<SharedJournal | null | undefined>(undefined);
  const [year, setYear] = useState(new Date().getFullYear());
  const [picked, setPicked] = useState<string | null>(null);
  const today = isoDate(new Date());

  useEffect(() => {
    let live = true;
    setJournal(undefined);
    setPicked(null);
    getFriendJournal({ data: { friendId } })
      .then((next) => {
        if (!live) return;
        setJournal(next);
        if (next) setYear(next.year);
      })
      .catch(() => {
        if (live) setJournal(null);
      });
    return () => {
      live = false;
    };
  }, [friendId]);

  const model = useMemo(() => buildYear(year), [year]);
  const stamp = habitStampOf(journal?.habits ?? []);
  const filled = journal
    ? Object.keys(journal.days).filter((key) => key.startsWith(`${year}-`)).length
    : 0;

  if (journal === undefined) return <p className="progress-note">Открываем год…</p>;
  if (!journal) {
    return <p className="progress-note">{name} ещё не открывал свой год. Календарь появится, когда он зайдёт в Pixel Mood.</p>;
  }

  const pickedDay = picked ? journal.days[picked] : undefined;
  const pickedHabits = pickedDay
    ? journal.habits.filter((habit) => pickedDay.habits.includes(habit.id)).map((habit) => habit.label)
    : [];

  return (
    <div>
      <div className="board-top">
        <p className="chat-with">Год · {name}</p>
        <div className="year-switch">
          <button
            type="button"
            className="icon-btn friends-link"
            aria-label="Предыдущий год"
            disabled={year <= YEAR_MIN}
            onClick={() => setYear((value) => Math.max(YEAR_MIN, value - 1))}
          >
            <ChevronLeft />
          </button>
          <p className="year-label num">{year}</p>
          <button
            type="button"
            className="icon-btn friends-link"
            aria-label="Следующий год"
            disabled={year >= YEAR_MAX}
            onClick={() => setYear((value) => Math.min(YEAR_MAX, value + 1))}
          >
            <ChevronRight />
          </button>
        </div>
      </div>
      <p className="progress-note">
        Только просмотр. Закрашено {filled} {filled === 1 ? "день" : "дней"}.
      </p>
      <div className="year-board friend-year" style={{ "--cols": model.cols } as CSSProperties}>
        <div className="year-scroll">
          <div className="year-months" aria-hidden="true">
            {model.months.map((month) => (
              <span key={month.name} className="month-label" style={{ "--col": month.col + 1 } as CSSProperties}>
                {month.name}
              </span>
            ))}
          </div>
          <div className="year-body">
            <div className="dows" aria-hidden="true">
              {DOW.map((label, index) => (
                <span key={index}>{label}</span>
              ))}
            </div>
            <div className="year-grid" role="group" aria-label={`Год ${name} за ${year}`}>
              {model.cells.map((cell) => {
                if (!cell.dateKey) return <span key={`pad-${cell.index}`} className="mood-pad" />;
                const day = journal.days[cell.dateKey];
                const count = habitCount(
                  day ? { mood: day.mood, habits: Object.fromEntries(day.habits.map((id) => [id, true])) } : undefined,
                  stamp,
                );
                return (
                  <button
                    key={cell.dateKey}
                    type="button"
                    className="mood-cell"
                    data-today={cell.dateKey === today ? "true" : "false"}
                    data-selected={picked === cell.dateKey ? "true" : "false"}
                    style={{ "--dot": day ? dotScale(count, journal.habits.length) : 0, "--d": "0ms" } as CSSProperties}
                    onClick={() => setPicked(cell.dateKey)}
                  >
                    <span className="mood-face" data-mood={day ? String(day.mood) : "empty"} />
                    <span className="mood-dot" />
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>
      {picked ? (
        <p className="progress-note">
          {formatLong(picked).title}
          {pickedDay ? ` · ${MOODS[pickedDay.mood]?.name ?? "день"}` : " · пусто"}
          {pickedHabits.length ? ` · ${pickedHabits.join(", ")}` : ""}
        </p>
      ) : (
        <p className="progress-note">Нажмите день, чтобы увидеть настроение и привычки.</p>
      )}
    </div>
  );
}

function PersonFace({ person, bare = false }: { person: Person; bare?: boolean }) {
  const initial = person.name.charAt(0).toUpperCase() || "•";
  const face = person.avatar ? (
    <img className="avatar" src={person.avatar} alt="" />
  ) : (
    <span className="avatar avatar-fallback" aria-hidden="true">
      {initial}
    </span>
  );
  if (bare) {
    return (
      <>
        {face}
        <span>
          <span className="account-name">{person.name}</span>
          {person.email ? <span className="account-kicker">{person.email}</span> : null}
        </span>
      </>
    );
  }
  return (
    <div className="person-face">
      {face}
      <span>
        <span className="account-name">{person.name}</span>
        {person.email ? <span className="account-kicker">{person.email}</span> : null}
      </span>
    </div>
  );
}

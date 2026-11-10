/**
 * Pixel Mood — экран.
 *
 * Почему сетка из ~370 клеток не перерисовывается целиком:
 * 1. Журнал — хэш `Record<YYYY-MM-DD, DayData>` (см. pixel-mood-core).
 *    Запись дня — O(1), объект года не копируется.
 * 2. `MoodCell` подписан только на `table[свойКлюч]` и на флаг
 *    «этот день открыт». Zustand сравнивает результат селектора через
 *    Object.is. Соседние дни возвращают ту же ссылку → React их пропускает.
 * 3. Шапка, метр и сетка подписаны на разные срезы. Клик по привычке
 *    будит лист и одну клетку, а не весь год.
 * 4. Ховер соседей — булев проп `dim`. Мемо пропускает клетки, у которых
 *    он не изменился (обычно 8–16 штук, не 365).
 * 5. Анимации только transform / opacity + will-change: transform.
 *    Ширина клеток не анимируется. Волна появления — одноразовый CSS
 *    keyframe на внутреннем слое, смена настроения его не перезапускает.
 * 6. Звук планируется в Web Audio из useCallback и сразу отпускает поток UI.
 */

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent as ReactFocusEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ChevronDown, ChevronLeft, ChevronRight, Flame, Plus, Trash2, Users, Volume2, VolumeX } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { RedirectToSignIn } from "@/lib/auth/gates";
import { useCurrentUser, useCurrentUserState } from "@/lib/auth/use-current-user";
import { contactLabel } from "@/lib/phone";
import { getProfile } from "@/lib/profile.functions";
import { publishJournal } from "@/lib/social.functions";
import {
  HABIT_LIMIT,
  MOODS,
  YEAR_MAX,
  YEAR_MIN,
  buildYear,
  burstConfetti,
  computeStreak,
  daysWord,
  dotScale,
  formatLong,
  getTable,
  habitCount,
  habitPercent,
  habitTotal,
  haptic,
  isoDate,
  longestStreak,
  neighborIndexes,
  parseIso,
  playChord,
  playClick,
  shiftIso,
  streakLabel,
  useMoodStore,
  yearStats,
  type HabitDef,
  type HabitId,
  type MoodLevel,
} from "@/pixel-mood-core";

const DOW = ["пн", "", "ср", "", "пт", "", ""];
const NO_NEIGHBORS: ReadonlySet<number> = new Set();

const SPRING = { type: "spring" as const, damping: 25, stiffness: 200 };

function cssVars(vars: Record<string, string | number>): CSSProperties {
  return vars as CSSProperties;
}

/** Щелчок и победный аккорд. Колбэки стабильны, аудиопоток не блокирует кадр. */
function useFeel() {
  const tap = useCallback(() => {
    if (!useMoodStore.getState().muted) playClick();
    haptic(10);
  }, []);

  const win = useCallback(() => {
    if (!useMoodStore.getState().muted) playChord();
    haptic([12, 36, 18]);
    burstConfetti();
  }, []);

  return { tap, win };
}

function useBoot(userId: string) {
  const bindOwner = useMoodStore((state) => state.bindOwner);
  const ready = useMoodStore((state) => state.ready && state.authId === userId);
  useEffect(() => {
    bindOwner(userId);
  }, [bindOwner, userId]);
  return ready;
}

export function PixelMood() {
  const { user, isPending } = useCurrentUserState();
  if (isPending) return <BootSkeleton />;
  if (!user) return <RedirectToSignIn />;
  return <SignedMood userId={user.id} />;
}

function useShareJournal(ready: boolean) {
  const revision = useMoodStore((state) => state.revision);
  useEffect(() => {
    if (!ready) return;
    const timer = window.setTimeout(() => {
      const state = useMoodStore.getState();
      const days: Record<string, { mood: number; habits: string[] }> = {};
      for (const [key, day] of Object.entries(state.table)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue;
        days[key] = {
          mood: day.mood,
          habits: Object.keys(day.habits).filter((id) => day.habits[id]),
        };
      }
      void publishJournal({
        data: {
          year: state.year,
          habits: state.habits.map((habit) => ({ id: habit.id, label: habit.label, mark: habit.mark })),
          days,
        },
      }).catch(() => {
        /* чужой календарь просто останется прошлым, свой год на устройстве не пропадает */
      });
    }, 600);
    return () => window.clearTimeout(timer);
  }, [ready, revision]);
}

function SignedMood({ userId }: { userId: string }) {
  const ready = useBoot(userId);
  useShareJournal(ready);
  if (!ready) return <BootSkeleton />;
  return (
    <main className="shell">
      <AccountBar />
      <Header />
      <Stats />
      <Board />
      <Ritual />
      <HabitManager />
    </main>
  );
}

function BootSkeleton() {
  return (
    <main className="shell" aria-busy="true">
      <p className="eyebrow">вечерний ритуал</p>
      <h1 className="brand">Pixel Mood</h1>
      <p className="lede">Открываем сессию…</p>
    </main>
  );
}

function AccountBar() {
  const user = useCurrentUser();
  const accounts = useMoodStore((state) => state.accounts);
  const activeId = useMoodStore((state) => state.activeId);
  const seeded = useMoodStore((state) => state.seeded);
  const seedFromServer = useMoodStore((state) => state.seedFromServer);
  const switchAccount = useMoodStore((state) => state.switchAccount);
  const account = accounts.find((item) => item.id === activeId) ?? null;
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!user?.id || seeded) return;
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
  }, [seedFromServer, seeded, user?.displayName, user?.id]);

  useEffect(() => {
    if (!open) return;
    function onPointer(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const email = contactLabel(user?.primaryEmail);
  const name = account?.name || user?.displayName || email || "Профиль";
  const avatar = account?.avatar ?? null;
  const initial = name.trim().charAt(0).toUpperCase() || "•";

  return (
    <div className="account-bar" ref={rootRef}>
      <button
        type="button"
        className="account-link account-trigger"
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={() => setOpen((value) => !value)}
      >
        {avatar ? (
          <img className="avatar" src={avatar} alt="" />
        ) : (
          <span className={seeded ? "avatar avatar-fallback" : "avatar avatar-fallback is-wait"} aria-hidden="true">
            {seeded ? initial : ""}
          </span>
        )}
        <span>
          <span className="account-kicker">аккаунт</span>
          <span className="account-name">{seeded ? name : "…"}</span>
        </span>
        <ChevronDown className={open ? "account-caret is-open" : "account-caret"} aria-hidden="true" />
      </button>
      <Link to="/friends" className="icon-btn friends-link" aria-label="Друзья">
        <Users />
      </Link>
      {open ? (
        <div className="account-menu" role="listbox" aria-label="Аккаунты">
          {accounts.map((item) => {
            const on = item.id === activeId;
            const label = item.name || "Без имени";
            return (
              <button
                key={item.id}
                type="button"
                role="option"
                aria-selected={on}
                className={on ? "account-open is-on" : "account-open"}
                onClick={() => {
                  switchAccount(item.id);
                  setOpen(false);
                }}
              >
                {item.avatar ? (
                  <img className="avatar" src={item.avatar} alt="" />
                ) : (
                  <span className="avatar avatar-fallback" aria-hidden="true">
                    {(label.charAt(0) || "•").toUpperCase()}
                  </span>
                )}
                <span>
                  <span className="account-name">{label}</span>
                  <span className="account-kicker">{on ? "сейчас" : "открыть"}</span>
                </span>
              </button>
            );
          })}
          <Link to="/profile" className="today-btn account-menu-edit" onClick={() => setOpen(false)}>
            Открыть профиль
          </Link>
        </div>
      ) : null}
    </div>
  );
}

function Header() {
  const revision = useMoodStore((state) => state.revision);
  const streak = useMemo(() => computeStreak(getTable()), [revision]);
  const live = streak > 0;

  return (
    <header className="hero">
      <div>
        <p className="eyebrow">
          <span className="mark" aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
          </span>
          вечерний ритуал
        </p>
        <h1 className="brand">Pixel Mood</h1>
      </div>
      <section className={live ? "streak-card is-live" : "streak-card"} aria-label="Серия дней">
        <Flame className={live ? "flame is-live" : "flame"} strokeWidth={1.6} aria-hidden="true" />
        <div>
          <p className="streak-num num">{streak}</p>
          <p className="streak-unit">{daysWord(streak)} подряд</p>
          <p className="streak-label">{streakLabel(streak)}</p>
        </div>
      </section>
    </header>
  );
}

function Stats() {
  const revision = useMoodStore((state) => state.revision);
  const year = useMoodStore((state) => state.year);
  const stats = useMemo(
    () => yearStats(getTable(), year, useMoodStore.getState().habitStamp),
    [revision, year],
  );
  const best = useMemo(() => longestStreak(getTable()), [revision]);
  const ratio = stats.total ? Math.round((stats.filled / stats.total) * 100) : 0;

  return (
    <section className="stats" aria-label="Сводка года">
      <article className="stat">
        <p className="stat-label">Закрашено</p>
        <p className="stat-value num">
          {stats.filled}
          <span className="streak-unit"> / {stats.total}</span>
        </p>
        <p className="stat-hint">{ratio}% года</p>
      </article>
      <article className="stat">
        <p className="stat-label">Привычки</p>
        <p className="stat-value num">{stats.habits}</p>
        <p className="stat-hint">отметки за {year}</p>
      </article>
      <article className="stat">
        <p className="stat-label">Рекорд</p>
        <p className="stat-value num">{best}</p>
        <p className="stat-hint">{daysWord(best)} лучшей серии</p>
      </article>
    </section>
  );
}

function Board() {
  return (
    <section className="board" aria-label="Сетка года">
      <BoardBar />
      <YearMeter />
      <YearHeatmap />
      <ul className="legend">
        {MOODS.map((mood) => (
          <li key={mood.level}>
            <i className="legend-swatch" data-mood={mood.level} />
            {mood.name}
          </li>
        ))}
        <li>
          <i className="legend-pip" />
          точка — доля привычек
        </li>
      </ul>
    </section>
  );
}

function BoardBar() {
  const year = useMoodStore((state) => state.year);
  const muted = useMoodStore((state) => state.muted);
  const { tap } = useFeel();

  const shiftYear = useCallback(
    (delta: number) => {
      const next = useMoodStore.getState().year + delta;
      if (next < YEAR_MIN || next > YEAR_MAX) return;
      useMoodStore.getState().setYear(next);
      tap();
    },
    [tap],
  );

  const openToday = useCallback(() => {
    const key = isoDate(new Date());
    const y = new Date().getFullYear();
    const state = useMoodStore.getState();
    if (state.year !== y) state.setYear(Math.min(YEAR_MAX, Math.max(YEAR_MIN, y)));
    state.openDay(key);
    tap();
  }, [tap]);

  return (
    <div className="board-top">
      <div className="year-switch">
        <button
          type="button"
          className="icon-btn"
          aria-label="Предыдущий год"
          disabled={year <= YEAR_MIN}
          onClick={() => shiftYear(-1)}
        >
          <ChevronLeft />
        </button>
        <p className="year-label num">{year}</p>
        <button
          type="button"
          className="icon-btn"
          aria-label="Следующий год"
          disabled={year >= YEAR_MAX}
          onClick={() => shiftYear(1)}
        >
          <ChevronRight />
        </button>
      </div>
      <div className="board-actions">
        <button
          type="button"
          className="icon-btn"
          aria-pressed={muted}
          aria-label={muted ? "Включить звук" : "Выключить звук"}
          onClick={() => {
            useMoodStore.getState().toggleMute();
            if (useMoodStore.getState().muted) haptic(6);
            else tap();
          }}
        >
          {muted ? <VolumeX /> : <Volume2 />}
        </button>
        <button
          type="button"
          className="ghost-btn"
          onClick={() => {
            useMoodStore.getState().openManager();
            tap();
          }}
        >
          Привычки
        </button>
        <button type="button" className="today-btn" onClick={openToday}>
          Сегодня
        </button>
      </div>
    </div>
  );
}

function YearMeter() {
  const year = useMoodStore((state) => state.year);
  const revision = useMoodStore((state) => state.revision);
  const stats = useMemo(
    () => yearStats(getTable(), year, useMoodStore.getState().habitStamp),
    [revision, year],
  );
  const ratio = stats.total ? stats.filled / stats.total : 0;

  return (
    <>
      <div className="meter-row">
        <span>{stats.filled === 0 ? "год ещё чистый" : "заполнено"}</span>
        <span className="num">
          {stats.filled} / {stats.total}
        </span>
      </div>
      <div className="meter" aria-hidden="true">
        <span style={cssVars({ "--fill": ratio })} />
      </div>
    </>
  );
}

function YearHeatmap() {
  const year = useMoodStore((state) => state.year);
  const model = useMemo(() => buildYear(year), [year]);
  const [today, setToday] = useState("");
  const [hover, setHover] = useState<number | null>(null);
  const hoverRef = useRef<number | null>(null);
  const finePointer = useRef(false);
  const { tap } = useFeel();

  useEffect(() => {
    setToday(isoDate(new Date()));
  }, []);

  useEffect(() => {
    const query = window.matchMedia("(hover: hover) and (pointer: fine)");
    const sync = () => {
      finePointer.current = query.matches;
    };
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    hoverRef.current = null;
    setHover(null);
  }, [year]);

  const neighbors = useMemo(() => {
    if (hover === null) return NO_NEIGHBORS;
    return new Set(neighborIndexes(hover, model.cells.length));
  }, [hover, model.cells.length]);

  const aim = useCallback((index: number | null) => {
    if (!finePointer.current) return;
    if (hoverRef.current === index) return;
    hoverRef.current = index;
    setHover(index);
  }, []);

  const onPointerOver = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.pointerType === "touch") return;
      const host = (event.target as HTMLElement).closest<HTMLElement>("[data-idx]");
      aim(host ? Number(host.dataset.idx) : null);
    },
    [aim],
  );

  const onPointerLeave = useCallback(() => {
    aim(null);
  }, [aim]);

  const onFocus = useCallback(
    (event: ReactFocusEvent<HTMLDivElement>) => {
      const host = (event.target as HTMLElement).closest<HTMLElement>("[data-idx]");
      aim(host ? Number(host.dataset.idx) : null);
    },
    [aim],
  );

  const onClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      const host = (event.target as HTMLElement).closest<HTMLElement>("[data-date]");
      const dateKey = host?.dataset.date;
      if (!dateKey) return;
      useMoodStore.getState().openDay(dateKey);
      tap();
    },
    [tap],
  );

  return (
    <div className="year-board" style={cssVars({ "--cols": model.cols })}>
      <p className="scroll-hint">Листайте в сторону. Клетка — день.</p>
      <div className="year-scroll">
        <div className="year-months" aria-hidden="true">
          {model.months.map((month) => (
            <span key={month.name} className="month-label" style={cssVars({ "--col": month.col + 1 })}>
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
          <div
            key={year}
            className="year-grid"
            role="group"
            aria-label={`Настроение за ${year}`}
            onPointerOver={onPointerOver}
            onPointerLeave={onPointerLeave}
            onFocus={onFocus}
            onBlur={onPointerLeave}
            onClick={onClick}
          >
            {model.cells.map((cell) =>
              cell.dateKey ? (
                <MoodCell
                  key={cell.dateKey}
                  dateKey={cell.dateKey}
                  index={cell.index}
                  col={cell.col}
                  row={cell.row}
                  today={cell.dateKey === today}
                  dim={neighbors.has(cell.index)}
                />
              ) : (
                <span key={`pad-${cell.index}`} className="mood-pad" />
              ),
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

type CellProps = {
  dateKey: string;
  index: number;
  col: number;
  row: number;
  today: boolean;
  dim: boolean;
};

/**
 * Одна клетка. Ререндер только если изменились её пропы (ховер-соседи,
 * «сегодня») или селектор стора вернул новый объект этого дня.
 */
export const MoodCell = memo(function MoodCell({ dateKey, index, col, row, today, dim }: CellProps) {
  const day = useMoodStore((state) => state.table[dateKey]);
  const stamp = useMoodStore((state) => state.habitStamp);
  const selected = useMoodStore((state) => state.selected === dateKey);
  const total = habitTotal(stamp);
  const count = habitCount(day, stamp);
  const long = formatLong(dateKey);
  const moodName = day ? (MOODS[day.mood]?.name ?? "настроение") : "пусто";
  const pct = habitPercent(count, total);

  return (
    <button
      type="button"
      className="mood-cell"
      data-idx={index}
      data-date={dateKey}
      data-today={today ? "true" : "false"}
      data-selected={selected ? "true" : "false"}
      data-dim={dim ? "1" : "0"}
      aria-label={`${long.title}, ${moodName}, привычки ${pct}%`}
      aria-haspopup="dialog"
      aria-current={today ? "date" : undefined}
      style={cssVars({
        "--d": `${col * 16 + row * 12}ms`,
        "--dot": day ? dotScale(count, total) : 0,
      })}
    >
      <span className="mood-face" data-mood={day ? String(day.mood) : "empty"} />
      <span className="mood-dot" />
    </button>
  );
});

function Ritual() {
  const selected = useMoodStore((state) => state.selected);
  return (
    <AnimatePresence>
      {selected ? <Backdrop key="backdrop" /> : null}
      {selected ? <Sheet key="sheet" dateKey={selected} /> : null}
    </AnimatePresence>
  );
}

function Backdrop() {
  const reduce = useReducedMotion();
  return (
    <motion.button
      type="button"
      className="backdrop"
      aria-label="Закрыть ритуал"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={reduce ? { duration: 0.01 } : { duration: 0.18 }}
      onClick={() => useMoodStore.getState().closeDay()}
    />
  );
}

function Sheet({ dateKey }: { dateKey: string }) {
  const day = useMoodStore((state) => state.table[dateKey]);
  const habits = useMoodStore((state) => state.habits);
  const stamp = useMoodStore((state) => state.habitStamp);
  const reduce = useReducedMotion();
  const rootRef = useRef<HTMLElement>(null);
  const { tap, win } = useFeel();
  const long = formatLong(dateKey);
  const total = habitTotal(stamp);
  const count = habitCount(day, stamp);
  const pct = habitPercent(count, total);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    root.querySelector<HTMLElement>("[data-autofocus]")?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (useMoodStore.getState().manager) return;
        useMoodStore.getState().closeDay();
        return;
      }
      if (event.key !== "Tab") return;
      const items = [
        ...root.querySelectorAll<HTMLElement>("button:not(:disabled), input, [href], [tabindex]:not([tabindex='-1'])"),
      ];
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previous;
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  const go = useCallback(
    (next: string) => {
      const year = Number(next.slice(0, 4));
      if (year < YEAR_MIN || year > YEAR_MAX) return;
      const state = useMoodStore.getState();
      if (state.year !== year) state.setYear(year);
      state.openDay(next);
      tap();
    },
    [tap],
  );

  const onDate = useCallback(
    (value: string) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return;
      if (isoDate(parseIso(value)) !== value) return;
      go(value);
    },
    [go],
  );

  const onMood = useCallback(
    (level: MoodLevel) => {
      useMoodStore.getState().setMood(dateKey, level);
      tap();
    },
    [dateKey, tap],
  );

  const onHabit = useCallback(
    (id: HabitId) => {
      const state = useMoodStore.getState();
      const goal = habitTotal(state.habitStamp);
      const before = habitCount(state.table[dateKey], state.habitStamp);
      state.toggleHabit(dateKey, id);
      const after = habitCount(useMoodStore.getState().table[dateKey], state.habitStamp);
      if (goal > 0 && before < goal && after === goal) win();
      else tap();
    },
    [dateKey, tap, win],
  );

  const onClear = useCallback(() => {
    useMoodStore.getState().clearDay(dateKey);
    tap();
  }, [dateKey, tap]);

  return (
    <motion.section
      ref={rootRef}
      className="sheet"
      role="dialog"
      aria-modal="true"
      aria-labelledby="ritual-title"
      initial={{ y: "110%" }}
      animate={{ y: 0 }}
      exit={{ y: "110%" }}
      transition={reduce ? { duration: 0.01 } : SPRING}
    >
      <div className="sheet-inner">
        <div className="grab" aria-hidden="true">
          <i />
        </div>
        <p className="sheet-kicker">вечерний ритуал</p>
        <h2 id="ritual-title" tabIndex={-1} data-autofocus>
          Как прошёл день
        </h2>

        <div className="date-head">
          <button type="button" className="icon-btn" aria-label="Предыдущий день" onClick={() => go(shiftIso(dateKey, -1))}>
            <ChevronLeft />
          </button>
          <div className="date-copy">
            <p className="date-wd">{long.weekday}</p>
            <p className="date-title">{long.title}</p>
          </div>
          <button type="button" className="icon-btn" aria-label="Следующий день" onClick={() => go(shiftIso(dateKey, 1))}>
            <ChevronRight />
          </button>
        </div>

        <label className="date-field">
          Другая дата
          <input type="date" value={dateKey} min={`${YEAR_MIN}-01-01`} max={`${YEAR_MAX}-12-31`} onChange={(event) => onDate(event.target.value)} />
        </label>

        <p className="field-label">Настроение</p>
        <div className="swatches" role="radiogroup" aria-label="Цвет настроения">
          {MOODS.map((mood) => {
            const checked = day?.mood === mood.level;
            return (
              <button
                key={mood.level}
                type="button"
                className="swatch"
                role="radio"
                data-mood={mood.level}
                aria-checked={checked}
                aria-label={`${mood.name}, ${mood.blurb}`}
                onClick={() => onMood(mood.level)}
              >
                <i />
              </button>
            );
          })}
        </div>

        <div className="field-head">
          <p className="field-label">Привычки</p>
          <button
            type="button"
            className="text-btn"
            onClick={() => {
              useMoodStore.getState().openManager();
              tap();
            }}
          >
            Изменить
          </button>
        </div>
        <div className="habits">
          {habits.length === 0 ? (
            <p className="progress-note">Список пуст. Добавьте привычку кнопкой «Изменить».</p>
          ) : (
            habits.map((habit) => {
              const on = day?.habits[habit.id] === true;
              return (
                <button
                  key={habit.id}
                  type="button"
                  className="habit"
                  role="switch"
                  aria-checked={on}
                  onClick={() => onHabit(habit.id)}
                >
                  <span className="habit-icon" aria-hidden="true">
                    {habit.mark}
                  </span>
                  <span className="habit-copy">
                    <strong>{habit.label}</strong>
                    {habit.detail ? <span>{habit.detail}</span> : null}
                  </span>
                  <span className="switch" aria-hidden="true">
                    <i />
                  </span>
                </button>
              );
            })
          )}
        </div>

        <div className="sheet-foot">
          {total > 0 && count === total ? (
            <p className="complete-note">День закрыт — все привычки</p>
          ) : (
            <p className="progress-note">Привычки: {pct}%</p>
          )}
          <button type="button" className="text-btn" onClick={onClear} disabled={!day}>
            Очистить
          </button>
        </div>
      </div>
    </motion.section>
  );
}

function HabitRow({ habit }: { habit: HabitDef }) {
  const [label, setLabel] = useState(habit.label);
  const [mark, setMark] = useState(habit.mark);

  useEffect(() => {
    setLabel(habit.label);
    setMark(habit.mark);
  }, [habit.id, habit.label, habit.mark]);

  return (
    <div className="habit-row">
      <input
        className="mark-field"
        value={mark}
        maxLength={8}
        aria-label={`Значок для ${habit.label}`}
        onChange={(event) => setMark(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
        onBlur={() => {
          const next = mark.trim();
          if (!next) {
            setMark(habit.mark);
            return;
          }
          useMoodStore.getState().updateHabit(habit.id, { mark: next });
        }}
      />
      <input
        className="name-field"
        value={label}
        maxLength={24}
        aria-label={`Название, сейчас ${habit.label}`}
        onChange={(event) => setLabel(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
        onBlur={() => {
          const next = label.trim();
          if (!next) {
            setLabel(habit.label);
            return;
          }
          useMoodStore.getState().updateHabit(habit.id, { label: next });
        }}
      />
      <button
        type="button"
        className="icon-btn"
        aria-label={`Удалить ${habit.label}`}
        onClick={() => useMoodStore.getState().removeHabit(habit.id)}
      >
        <Trash2 />
      </button>
    </div>
  );
}

function HabitEditor() {
  const habits = useMoodStore((state) => state.habits);
  const [label, setLabel] = useState("");
  const [mark, setMark] = useState("✨");
  const { tap } = useFeel();
  const full = habits.length >= HABIT_LIMIT;

  const add = useCallback(() => {
    const ok = useMoodStore.getState().addHabit(label, mark);
    if (!ok) return;
    setLabel("");
    setMark("✨");
    tap();
  }, [label, mark, tap]);

  return (
    <div className="habit-editor">
      {habits.length === 0 ? <p className="progress-note">Пока нет ни одной привычки.</p> : null}
      {habits.map((habit) => (
        <HabitRow key={habit.id} habit={habit} />
      ))}
      <form
        className="habit-add"
        onSubmit={(event) => {
          event.preventDefault();
          add();
        }}
      >
        <input
          className="mark-field"
          value={mark}
          maxLength={8}
          aria-label="Значок новой привычки"
          onChange={(event) => setMark(event.target.value)}
        />
        <input
          className="name-field"
          value={label}
          maxLength={24}
          placeholder="Новая привычка"
          aria-label="Название новой привычки"
          onChange={(event) => setLabel(event.target.value)}
        />
        <button type="submit" className="icon-btn" aria-label="Добавить привычку" disabled={full || !label.trim()}>
          <Plus />
        </button>
      </form>
      <p className="progress-note">
        {full ? `Лимит — ${HABIT_LIMIT}.` : "До 8 штук."} Удаление убирает привычку из всех дней.
      </p>
    </div>
  );
}

function HabitManager() {
  const open = useMoodStore((state) => state.manager);
  const reduce = useReducedMotion();
  const rootRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!open) return;
    const root = rootRef.current;
    if (!root) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    root.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      useMoodStore.getState().closeManager();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previous;
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <AnimatePresence>
      {open ? (
        <motion.button
          key="habit-backdrop"
          type="button"
          className="backdrop backdrop-front"
          aria-label="Закрыть список привычек"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={reduce ? { duration: 0.01 } : { duration: 0.18 }}
          onClick={() => useMoodStore.getState().closeManager()}
        />
      ) : null}
      {open ? (
        <motion.section
          key="habit-sheet"
          ref={rootRef}
          className="sheet sheet-front"
          role="dialog"
          aria-modal="true"
          aria-labelledby="habits-title"
          initial={{ y: "110%" }}
          animate={{ y: 0 }}
          exit={{ y: "110%" }}
          transition={reduce ? { duration: 0.01 } : SPRING}
        >
          <div className="sheet-inner">
            <div className="grab" aria-hidden="true">
              <i />
            </div>
            <p className="sheet-kicker">список</p>
            <h2 id="habits-title" tabIndex={-1} data-autofocus>
              Привычки
            </h2>
            <p className="progress-note">Значок и название правятся на месте. Плюс добавляет новую, корзина удаляет.</p>
            <HabitEditor />
            <div className="sheet-foot">
              <p className="progress-note">Отметки старых дней для удалённой привычки больше не видны.</p>
              <button type="button" className="text-btn" onClick={() => useMoodStore.getState().closeManager()}>
                Готово
              </button>
            </div>
          </div>
        </motion.section>
      ) : null}
    </AnimatePresence>
  );
}

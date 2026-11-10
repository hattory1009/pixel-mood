/**
 * Pixel Mood — ядро данных, звука и календаря.
 *
 * Архитектура обновлений (O(1) и один ререндер):
 * Журнал — это хэш-таблица `Record<YYYY-MM-DD, DayData>`. Чтение и запись
 * одного дня — обращение по ключу, без прохода по 365 ячейкам.
 * Таблица мутируется на месте: мы НЕ копируем весь год на каждый клик.
 * После записи увеличивается только счётчик `revision`, чтобы подписчики
 * Zustand пересчитали свой селектор. Селектор ячейки возвращает объект
 * конкретного дня. У соседних дней ссылка не меняется, Object.is срабатывает,
 * и React пропускает их рендер. Шапка подписана на `revision`, сетка — нет.
 *
 * Звук собирается заранее (кэш буфера клика) и ставится в очередь Web Audio.
 * Аудиопоток отделён от UI-потока: обработчик клика только планирует ноты
 * и сразу возвращается.
 */

import { create } from "zustand";

export type HabitId = string;
export type MoodLevel = 0 | 1 | 2 | 3 | 4;

export type HabitDef = {
  id: string;
  label: string;
  mark: string;
  detail: string;
};

export type DayData = {
  mood: MoodLevel;
  habits: Record<string, boolean>;
};

export const MOODS: readonly { level: MoodLevel; name: string; blurb: string }[] = [
  { level: 0, name: "Туман", blurb: "серо и тихо" },
  { level: 1, name: "Прохлада", blurb: "сдержанно" },
  { level: 2, name: "Баланс", blurb: "ровный день" },
  { level: 3, name: "Тепло", blurb: "светло внутри" },
  { level: 4, name: "Солнце", blurb: "на подъёме" },
];

export const DEFAULT_HABITS: readonly HabitDef[] = [
  { id: "sport", label: "Спорт", mark: "🏃‍♂️", detail: "тело в движении" },
  { id: "read", label: "Чтение", mark: "📚", detail: "хотя бы страница" },
  { id: "water", label: "Вода", mark: "💧", detail: "норма за день" },
];

export const HABIT_LIMIT = 8;

function cloneDefaults(): HabitDef[] {
  return DEFAULT_HABITS.map((habit) => ({ ...habit }));
}

export function habitStampOf(habits: readonly { id: string }[]): string {
  return habits.map((habit) => habit.id).join("\n");
}

/** Доля закрытых привычек из текущего списка. Чужие ключи в дне не считаются. */
export function habitCount(day: DayData | undefined, stamp: string): number {
  if (!day || !stamp) return 0;
  let count = 0;
  for (const id of stamp.split("\n")) {
    if (id && day.habits[id]) count += 1;
  }
  return count;
}

export function habitTotal(stamp: string): number {
  return stamp ? stamp.split("\n").length : 0;
}

export function habitPercent(count: number, total: number): number {
  if (total <= 0 || count <= 0) return 0;
  if (count >= total) return 100;
  return Math.round((100 * count) / total);
}

/** Масштаб точки: 0, промежуточные доли и 1. Только transform, не width. */
export function dotScale(count: number, total: number): number {
  if (count <= 0 || total <= 0) return 0;
  if (count >= total) return 1;
  return 0.4 + 0.45 * (count / total);
}

const STORAGE_PREFIX = "pixel-mood.v1:";
const ROSTER_PREFIX = "pixel-mood.roster.v1:";
export const ACCOUNT_LIMIT = 8;

export type LocalAccount = {
  id: string;
  name: string;
  avatar: string | null;
};

type Roster = {
  active: string;
  seeded: boolean;
  accounts: LocalAccount[];
};
export const YEAR_MIN = 2020;
export const YEAR_MAX = 2035;

export const GRID_ROWS = 7;

const WEEKDAYS = ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"];
const MONTHS_GEN = [
  "января",
  "февраля",
  "марта",
  "апреля",
  "мая",
  "июня",
  "июля",
  "августа",
  "сентября",
  "октября",
  "ноября",
  "декабря",
];
const MONTHS_SHORT = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];

export type CellModel = {
  index: number;
  col: number;
  row: number;
  dateKey: string | null;
};

type PersistShape = {
  days?: unknown;
  muted?: unknown;
  year?: unknown;
  habits?: unknown;
};

type MoodState = {
  /** Живая хэш-таблица. Не заменяем объект целиком на каждый клик. */
  table: Record<string, DayData>;
  revision: number;
  year: number;
  selected: string | null;
  muted: boolean;
  ready: boolean;
  /** Аккаунт, которому принадлежит открытый журнал. */
  owner: string | null;
  /** Вход, внутри которого лежат локальные аккаунты. */
  authId: string | null;
  activeId: string | null;
  accounts: LocalAccount[];
  seeded: boolean;
  habits: HabitDef[];
  /** Идентификаторы через перевод строки. Меняется только при добавлении и удалении. */
  habitStamp: string;
  manager: boolean;
  hydrate: () => void;
  bindOwner: (userId: string) => void;
  seedFromServer: (name: string, avatar: string | null) => void;
  switchAccount: (id: string) => void;
  addAccount: (name: string) => boolean;
  removeAccount: (id: string) => void;
  setActiveProfile: (name: string, avatar: string | null) => void;
  setYear: (year: number) => void;
  openDay: (dateKey: string) => void;
  closeDay: () => void;
  openManager: () => void;
  closeManager: () => void;
  toggleMute: () => void;
  setMood: (dateKey: string, mood: MoodLevel) => void;
  toggleHabit: (dateKey: string, id: HabitId) => void;
  clearDay: (dateKey: string) => void;
  addHabit: (label: string, mark: string) => boolean;
  updateHabit: (id: string, patch: { label?: string; mark?: string }) => void;
  removeHabit: (id: string) => void;
};

function clampYear(year: number): number {
  if (!Number.isFinite(year)) return new Date().getFullYear();
  return Math.min(YEAR_MAX, Math.max(YEAR_MIN, Math.trunc(year)));
}

export function isoDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function parseIso(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y || 1970, (m || 1) - 1, d || 1);
}

export function shiftIso(key: string, delta: number): string {
  const date = parseIso(key);
  date.setDate(date.getDate() + delta);
  return isoDate(date);
}

export function daysInYear(year: number): number {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 366 : 365;
}

/** Индекс дня в году без DST-сдвигов: календарные даты через UTC. */
function dayOfYear(year: number, month: number, day: number): number {
  const start = Date.UTC(year, 0, 1);
  const current = Date.UTC(year, month, day);
  return Math.round((current - start) / 86_400_000);
}

export function daysWord(n: number): string {
  const n10 = n % 10;
  const n100 = n % 100;
  if (n10 === 1 && n100 !== 11) return "день";
  if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) return "дня";
  return "дней";
}

export function streakLabel(n: number): string {
  if (n >= 100) return "легенда";
  if (n >= 30) return "месяц огня";
  if (n >= 14) return "устойчиво";
  if (n >= 7) return "неделя";
  if (n >= 3) return "разогрев";
  if (n >= 1) return "искра";
  return "пока тихо";
}

export function formatLong(key: string): { weekday: string; title: string } {
  const date = parseIso(key);
  return {
    weekday: WEEKDAYS[date.getDay()] ?? "",
    title: `${date.getDate()} ${MONTHS_GEN[date.getMonth()] ?? ""} ${date.getFullYear()}`,
  };
}

/**
 * Непрерывные заполненные дни, заканчивающиеся сегодня.
 * Если сегодня ещё пустое — серия считается до вчера, чтобы не сгорать с утра.
 */
export function computeStreak(table: Record<string, DayData>, today = new Date()): number {
  let cursor = isoDate(today);
  if (!table[cursor]) cursor = shiftIso(cursor, -1);
  let count = 0;
  while (table[cursor]) {
    count += 1;
    cursor = shiftIso(cursor, -1);
    if (count > 20_000) break;
  }
  return count;
}

export function longestStreak(table: Record<string, DayData>): number {
  const keys = Object.keys(table).sort();
  let best = 0;
  let run = 0;
  let prev: string | null = null;
  for (const key of keys) {
    run = prev && shiftIso(prev, 1) === key ? run + 1 : 1;
    if (run > best) best = run;
    prev = key;
  }
  return best;
}

export function yearStats(table: Record<string, DayData>, year: number, stamp: string) {
  const prefix = `${year}-`;
  let filled = 0;
  let habits = 0;
  for (const key in table) {
    if (!key.startsWith(prefix)) continue;
    filled += 1;
    const day = table[key];
    if (day) habits += habitCount(day, stamp);
  }
  return { filled, habits, total: daysInYear(year) };
}

export function buildYear(year: number): {
  cells: CellModel[];
  months: { name: string; col: number }[];
  cols: number;
} {
  const lead = (new Date(year, 0, 1).getDay() + 6) % 7;
  const count = daysInYear(year);
  const total = Math.ceil((lead + count) / GRID_ROWS) * GRID_ROWS;
  const cells: CellModel[] = [];
  for (let index = 0; index < total; index += 1) {
    const offset = index - lead;
    const row = index % GRID_ROWS;
    const col = Math.floor(index / GRID_ROWS);
    if (offset < 0 || offset >= count) {
      cells.push({ index, col, row, dateKey: null });
    } else {
      const date = new Date(year, 0, 1 + offset);
      cells.push({ index, col, row, dateKey: isoDate(date) });
    }
  }

  const months: { name: string; col: number }[] = [];
  let lastCol = -2;
  for (let month = 0; month < 12; month += 1) {
    const col = Math.floor((dayOfYear(year, month, 1) + lead) / GRID_ROWS);
    if (col <= lastCol) continue;
    months.push({ name: MONTHS_SHORT[month] ?? "", col });
    lastCol = col;
  }

  return { cells, months, cols: total / GRID_ROWS };
}

/** Индексы восьми соседей в колонночном гриде (7 рядов, auto-flow: column). */
export function neighborIndexes(index: number, length: number): number[] {
  const row = index % GRID_ROWS;
  const col = Math.floor(index / GRID_ROWS);
  const cols = Math.ceil(length / GRID_ROWS);
  const found: number[] = [];
  for (let dr = -1; dr <= 1; dr += 1) {
    for (let dc = -1; dc <= 1; dc += 1) {
      if (dr === 0 && dc === 0) continue;
      const nextRow = row + dr;
      const nextCol = col + dc;
      if (nextRow < 0 || nextRow >= GRID_ROWS || nextCol < 0 || nextCol >= cols) continue;
      const next = nextCol * GRID_ROWS + nextRow;
      if (next >= 0 && next < length) found.push(next);
    }
  }
  return found;
}

function isMood(value: unknown): value is MoodLevel {
  return value === 0 || value === 1 || value === 2 || value === 3 || value === 4;
}

function normalizeDay(input: unknown): DayData | null {
  if (!input || typeof input !== "object") return null;
  const record = input as Record<string, unknown>;
  if (!isMood(record.mood)) return null;
  const habits: Record<string, boolean> = {};
  if (record.habits && typeof record.habits === "object") {
    for (const [key, value] of Object.entries(record.habits as Record<string, unknown>)) {
      if (value === true && /^[a-zA-Z0-9_-]{1,24}$/.test(key)) habits[key] = true;
    }
  }
  return { mood: record.mood, habits };
}

function cleanMark(value: string): string {
  const mark = value.trim().slice(0, 8);
  return mark || "•";
}

function normalizeHabits(input: unknown): HabitDef[] {
  if (!Array.isArray(input)) return cloneDefaults();
  const habits: HabitDef[] = [];
  const seen = new Set<string>();
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id : "";
    if (!/^[a-zA-Z0-9_-]{1,24}$/.test(id) || seen.has(id)) continue;
    const label = typeof record.label === "string" ? record.label.trim().slice(0, 24) : "";
    if (!label) continue;
    const mark = cleanMark(typeof record.mark === "string" ? record.mark : "•");
    const detail = typeof record.detail === "string" ? record.detail.trim().slice(0, 48) : "";
    seen.add(id);
    habits.push({ id, label, mark, detail });
    if (habits.length >= HABIT_LIMIT) break;
  }
  return habits;
}

function journalOwner(authId: string, accountId: string): string {
  return accountId === "main" ? authId : `${authId}:${accountId}`;
}

function cleanAccountName(value: string): string {
  return value.trim().slice(0, 32);
}

function cleanAvatar(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (!value.startsWith("data:image/jpeg;base64,") || value.length > 180_000) return null;
  return value;
}

function freshAccount(name: string): LocalAccount {
  return {
    id: `a${Math.random().toString(36).slice(2, 8)}`,
    name: cleanAccountName(name) || "Новый",
    avatar: null,
  };
}

function normalizeRoster(raw: unknown): Roster | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if (!Array.isArray(record.accounts)) return null;
  const accounts: LocalAccount[] = [];
  for (const item of record.accounts) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const id = typeof row.id === "string" ? row.id.trim() : "";
    if (!/^[a-z0-9]{1,16}$/i.test(id)) continue;
    accounts.push({
      id,
      name: cleanAccountName(typeof row.name === "string" ? row.name : ""),
      avatar: cleanAvatar(row.avatar),
    });
    if (accounts.length >= ACCOUNT_LIMIT) break;
  }
  if (!accounts.length) return null;
  const active = typeof record.active === "string" && accounts.some((account) => account.id === record.active)
    ? record.active
    : accounts[0].id;
  return { active, seeded: record.seeded === true, accounts };
}

function loadRoster(authId: string): Roster {
  const empty: Roster = {
    active: "main",
    seeded: false,
    accounts: [{ id: "main", name: "", avatar: null }],
  };
  if (typeof window === "undefined") return empty;
  try {
    const parsed = normalizeRoster(JSON.parse(window.localStorage.getItem(`${ROSTER_PREFIX}${authId}`) || "null"));
    return parsed ?? empty;
  } catch {
    return empty;
  }
}

function saveRoster(authId: string, roster: Roster) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(`${ROSTER_PREFIX}${authId}`, JSON.stringify(roster));
  } catch {
    /* квота браузера — аккаунты остаются в памяти до перезагрузки */
  }
}

function applyJournal(
  authId: string,
  roster: Roster,
  extra: Partial<MoodState> = {},
): Partial<MoodState> {
  const journal = journalOwner(authId, roster.active);
  const loaded = loadPersist(journal);
  return {
    table: loaded.table,
    muted: loaded.muted,
    year: loaded.year,
    habits: loaded.habits,
    habitStamp: habitStampOf(loaded.habits),
    authId,
    activeId: roster.active,
    accounts: roster.accounts,
    seeded: roster.seeded,
    owner: journal,
    ready: true,
    selected: null,
    ...extra,
  };
}

function loadPersist(owner: string): { table: Record<string, DayData>; muted: boolean; year: number; habits: HabitDef[] } {
  const fallback = {
    table: {} as Record<string, DayData>,
    muted: false,
    year: clampYear(new Date().getFullYear()),
    habits: cloneDefaults(),
  };
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(`${STORAGE_PREFIX}${owner}`);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as PersistShape;
    const table: Record<string, DayData> = {};
    if (parsed.days && typeof parsed.days === "object" && !Array.isArray(parsed.days)) {
      for (const [key, value] of Object.entries(parsed.days as Record<string, unknown>)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue;
        const day = normalizeDay(value);
        if (day) table[key] = day;
      }
    }
    return {
      table,
      muted: parsed.muted === true,
      year: clampYear(typeof parsed.year === "number" ? parsed.year : fallback.year),
      habits: Object.prototype.hasOwnProperty.call(parsed, "habits") ? normalizeHabits(parsed.habits) : cloneDefaults(),
    };
  } catch {
    return fallback;
  }
}

function persist(state: Pick<MoodState, "table" | "muted" | "year" | "habits" | "owner">) {
  if (typeof window === "undefined" || !state.owner) return;
  try {
    window.localStorage.setItem(
      `${STORAGE_PREFIX}${state.owner}`,
      JSON.stringify({ days: state.table, muted: state.muted, year: state.year, habits: state.habits }),
    );
  } catch {
    /* приватный режим или переполненная квота — сессия всё равно живая */
  }
}

function commitDay(
  get: () => MoodState,
  set: (partial: Partial<MoodState>) => void,
  dateKey: string,
  next: DayData | null,
) {
  const table = get().table;
  if (next) table[dateKey] = next;
  else delete table[dateKey];
  set({ revision: get().revision + 1 });
  persist(get());
}

const initialHabits = cloneDefaults();

function nextHabitId(habits: readonly HabitDef[]): string {
  const taken = new Set(habits.map((habit) => habit.id));
  let id = "h";
  do {
    id = `h${Math.random().toString(36).slice(2, 8)}`;
  } while (taken.has(id));
  return id;
}

export const useMoodStore = create<MoodState>((set, get) => ({
  table: {},
  revision: 0,
  year: clampYear(new Date().getFullYear()),
  selected: null,
  muted: false,
  ready: false,
  owner: null,
  authId: null,
  activeId: null,
  accounts: [],
  seeded: false,
  habits: initialHabits,
  habitStamp: habitStampOf(initialHabits),
  manager: false,
  hydrate: () => {
    /* журнал грузится только после входа, через bindOwner */
  },
  bindOwner: (userId) => {
    if (!userId || (get().authId === userId && get().ready)) return;
    const roster = loadRoster(userId);
    set({ ...applyJournal(userId, roster), revision: get().revision + 1 });
  },
  seedFromServer: (name, avatar) => {
    const authId = get().authId;
    if (!authId || get().seeded) return;
    const accounts = get().accounts.map((account) =>
      account.id === "main" && !account.name && !account.avatar
        ? { ...account, name: cleanAccountName(name), avatar: cleanAvatar(avatar) }
        : account,
    );
    const roster: Roster = { active: get().activeId || "main", seeded: true, accounts };
    saveRoster(authId, roster);
    set({ accounts, seeded: true, revision: get().revision + 1 });
  },
  switchAccount: (id) => {
    const authId = get().authId;
    if (!authId || id === get().activeId || !get().accounts.some((account) => account.id === id)) return;
    persist(get());
    const roster: Roster = { active: id, seeded: get().seeded, accounts: get().accounts };
    saveRoster(authId, roster);
    set({ ...applyJournal(authId, roster), revision: get().revision + 1 });
  },
  addAccount: (name) => {
    const authId = get().authId;
    const current = get().accounts;
    if (!authId || current.length >= ACCOUNT_LIMIT) return false;
    persist(get());
    const next = freshAccount(name);
    const roster: Roster = { active: next.id, seeded: true, accounts: [...current, next] };
    saveRoster(authId, roster);
    set({ ...applyJournal(authId, roster), revision: get().revision + 1 });
    return true;
  },
  removeAccount: (id) => {
    const authId = get().authId;
    const current = get().accounts;
    if (!authId || current.length < 2 || !current.some((account) => account.id === id)) return;
    const accounts = current.filter((account) => account.id !== id);
    const active = get().activeId === id ? accounts[0].id : get().activeId || accounts[0].id;
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(`${STORAGE_PREFIX}${journalOwner(authId, id)}`);
    }
    const roster: Roster = { active, seeded: get().seeded, accounts };
    saveRoster(authId, roster);
    if (active === get().activeId) {
      set({ accounts, revision: get().revision + 1 });
      return;
    }
    set({ ...applyJournal(authId, roster), revision: get().revision + 1 });
  },
  setActiveProfile: (name, avatar) => {
    const authId = get().authId;
    const activeId = get().activeId;
    if (!authId || !activeId) return;
    const accounts = get().accounts.map((account) =>
      account.id === activeId ? { ...account, name: cleanAccountName(name), avatar: cleanAvatar(avatar) } : account,
    );
    const roster: Roster = { active: activeId, seeded: true, accounts };
    saveRoster(authId, roster);
    set({ accounts, seeded: true, revision: get().revision + 1 });
  },
  setYear: (year) => {
    set({ year: clampYear(year) });
    persist(get());
  },
  openDay: (dateKey) => set({ selected: dateKey }),
  closeDay: () => set({ selected: null }),
  openManager: () => set({ manager: true }),
  closeManager: () => set({ manager: false }),
  toggleMute: () => {
    set({ muted: !get().muted });
    persist(get());
  },
  setMood: (dateKey, mood) => {
    const prev = get().table[dateKey];
    commitDay(get, set, dateKey, {
      mood,
      habits: prev?.habits ?? {},
    });
  },
  toggleHabit: (dateKey, id) => {
    const prev = get().table[dateKey];
    const habits = { ...(prev?.habits ?? {}) };
    if (habits[id]) delete habits[id];
    else habits[id] = true;
    commitDay(get, set, dateKey, { mood: prev?.mood ?? 2, habits });
  },
  clearDay: (dateKey) => {
    if (!get().table[dateKey]) return;
    commitDay(get, set, dateKey, null);
  },
  addHabit: (label, mark) => {
    const name = label.trim().slice(0, 24);
    if (!name) return false;
    const current = get().habits;
    if (current.length >= HABIT_LIMIT) return false;
    const habits = [...current, { id: nextHabitId(current), label: name, mark: cleanMark(mark), detail: "" }];
    set({ habits, habitStamp: habitStampOf(habits), revision: get().revision + 1 });
    persist(get());
    return true;
  },
  updateHabit: (id, patch) => {
    let changed = false;
    const habits = get().habits.map((habit) => {
      if (habit.id !== id) return habit;
      const label = patch.label === undefined ? habit.label : patch.label.trim().slice(0, 24);
      if (!label) return habit;
      const mark = patch.mark === undefined ? habit.mark : cleanMark(patch.mark);
      if (label === habit.label && mark === habit.mark) return habit;
      changed = true;
      return { ...habit, label, mark };
    });
    if (!changed) return;
    set({ habits, revision: get().revision + 1 });
    persist(get());
  },
  removeHabit: (id) => {
    const habits = get().habits.filter((habit) => habit.id !== id);
    if (habits.length === get().habits.length) return;
    set({ habits, habitStamp: habitStampOf(habits), revision: get().revision + 1 });
    persist(get());
  },
}));

export function getTable(): Record<string, DayData> {
  return useMoodStore.getState().table;
}

/* --------------------------------- audio --------------------------------- */

let audioCtx: AudioContext | null = null;
let clickBuffer: AudioBuffer | null = null;

function audioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor =
    window.AudioContext ??
    (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (!audioCtx) audioCtx = new Ctor();
  return audioCtx;
}

function cachedClick(ctx: AudioContext): AudioBuffer {
  if (clickBuffer && clickBuffer.sampleRate === ctx.sampleRate) return clickBuffer;
  const length = Math.floor(ctx.sampleRate * 0.028);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i += 1) {
    const env = 1 - i / length;
    data[i] = (Math.random() * 2 - 1) * env * env;
  }
  clickBuffer = buffer;
  return buffer;
}

function startClick(ctx: AudioContext) {
  const t = ctx.currentTime;
  const noise = ctx.createBufferSource();
  noise.buffer = cachedClick(ctx);
  const filter = ctx.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.setValueAtTime(1700, t);
  filter.Q.setValueAtTime(0.65, t);
  const noiseGain = ctx.createGain();
  noiseGain.gain.setValueAtTime(0.16, t);
  noise.connect(filter);
  filter.connect(noiseGain);
  noiseGain.connect(ctx.destination);

  const tone = ctx.createOscillator();
  const toneGain = ctx.createGain();
  tone.type = "triangle";
  tone.frequency.setValueAtTime(620, t);
  tone.frequency.exponentialRampToValueAtTime(240, t + 0.04);
  toneGain.gain.setValueAtTime(0.0001, t);
  toneGain.gain.exponentialRampToValueAtTime(0.045, t + 0.006);
  toneGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.055);
  tone.connect(toneGain);
  toneGain.connect(ctx.destination);

  noise.start(t);
  noise.stop(t + 0.03);
  tone.start(t);
  tone.stop(t + 0.06);
}

function startChord(ctx: AudioContext) {
  const t = ctx.currentTime;
  const master = ctx.createGain();
  master.gain.setValueAtTime(0.0001, t);
  master.gain.exponentialRampToValueAtTime(0.2, t + 0.03);
  master.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
  master.connect(ctx.destination);
  const notes = [523.25, 659.25, 783.99, 1046.5];
  notes.forEach((freq, index) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = index === 3 ? "triangle" : "sine";
    osc.frequency.setValueAtTime(freq, t);
    gain.gain.setValueAtTime(0.22 - index * 0.035, t);
    osc.connect(gain);
    gain.connect(master);
    osc.start(t + index * 0.018);
    osc.stop(t + 0.92);
  });
}

function withRunning(run: (ctx: AudioContext) => void) {
  const ctx = audioContext();
  if (!ctx) return;
  // resume() и планирование нот — в одном синхронном кадре жеста.
  // Ждать then() нельзя: браузер может уже закрыть user-gesture.
  if (ctx.state === "suspended") void ctx.resume();
  run(ctx);
}

/** Короткий тактильный щелчок. Не ждёт окончания звука. */
export function playClick(): void {
  withRunning(startClick);
}

/** Победный мажор, когда закрыты все три привычки. */
export function playChord(): void {
  withRunning(startChord);
}

export function haptic(pattern: number | number[]): void {
  if (typeof navigator === "undefined" || typeof navigator.vibrate !== "function") return;
  try {
    navigator.vibrate(pattern);
  } catch {
    /* некоторые браузеры бросают, если вибрация запрещена */
  }
}

const CONFETTI_FALLBACK = ["#ffe56a", "#f0c14a", "#6fbfb0", "#e7eef8", "#9ad7c8"];

export function burstConfetti(): void {
  if (typeof window === "undefined") return;
  void import("canvas-confetti").then(({ default: confetti }) => {
    const style = getComputedStyle(document.documentElement);
    const pick = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
    const colors = [
      pick("--color-mood-4", CONFETTI_FALLBACK[0] ?? "#ffe56a"),
      pick("--color-gold", CONFETTI_FALLBACK[1] ?? "#f0c14a"),
      pick("--color-mood-2", CONFETTI_FALLBACK[2] ?? "#6fbfb0"),
      pick("--color-ink", CONFETTI_FALLBACK[3] ?? "#e7eef8"),
      pick("--color-dot", CONFETTI_FALLBACK[4] ?? "#f4f7fb"),
    ];
    const base = {
      startVelocity: 58,
      gravity: 0.95,
      decay: 0.92,
      ticks: 220,
      colors,
      disableForReducedMotion: true,
      scalar: 0.9,
      zIndex: 80,
    };
    void confetti({ ...base, particleCount: 100, spread: 78, origin: { x: 0.5, y: 1 } });
    void confetti({
      ...base,
      particleCount: 36,
      angle: 62,
      spread: 50,
      origin: { x: 0.12, y: 1 },
    });
    void confetti({
      ...base,
      particleCount: 36,
      angle: 118,
      spread: 50,
      origin: { x: 0.88, y: 1 },
    });
  });
}

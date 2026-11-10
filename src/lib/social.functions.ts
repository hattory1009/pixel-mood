import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { contactLabel, identityEmail } from "@/lib/phone";

export type Person = {
  id: string;
  name: string;
  email: string | null;
  avatar: string | null;
};

export type FriendRow = Person & {
  friendshipId: string;
  status: "pending" | "accepted";
  incoming: boolean;
};

export type ChatMessage = {
  id: string;
  mine: boolean;
  body: string;
  at: string;
};

type PersonRow = {
  id: string;
  name: string;
  email: string;
  display_name: string;
  avatar: string | null;
};

function lookupEmail(input: unknown): string | null {
  const raw = input && typeof input === "object" ? (input as { email?: unknown }).email : "";
  return identityEmail(typeof raw === "string" ? raw : "");
}

function cleanId(value: unknown): string {
  if (typeof value !== "string") return "";
  const id = value.trim();
  if (!/^[\w-]{1,80}$/.test(id)) return "";
  return id;
}

function asPerson(row: PersonRow): Person {
  const email = contactLabel(row.email);
  const name = (row.display_name || row.name || email || "Друг").trim().slice(0, 32) || "Друг";
  const avatar =
    row.avatar && row.avatar.startsWith("data:image/jpeg;base64,") && row.avatar.length <= 180_000
      ? row.avatar
      : null;
  return { id: row.id, name, email, avatar };
}

async function sqlClient() {
  const { getSql } = await import("@/lib/db");
  return getSql();
}

export const listFriends = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }): Promise<FriendRow[]> => {
    const sql = await sqlClient();
    const me = context.userId;
    const rows = await sql<PersonRow & { friendship_id: string; status: string; requester_id: string }>`
      select
        f.id as friendship_id,
        f.status,
        f.requester_id,
        u.id,
        u.name,
        u.email,
        coalesce(p.display_name, '') as display_name,
        p.avatar
      from friendships f
      join "user" u
        on u.id = case when f.requester_id = ${me} then f.addressee_id else f.requester_id end
      left join profiles p on p.user_id = u.id
      where f.requester_id = ${me} or f.addressee_id = ${me}
      order by f.created_at desc
    `;
    return rows
      .filter((row) => row.status === "pending" || row.status === "accepted")
      .map((row) => ({
        ...asPerson(row),
        friendshipId: row.friendship_id,
        status: row.status as "pending" | "accepted",
        incoming: row.status === "pending" && row.requester_id !== me,
      }));
  });

export const findPerson = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => {
    const email = lookupEmail(input);
    if (!email) throw new Error("Нужен телефон или почта");
    return { email };
  })
  .handler(async ({ context, data }): Promise<Person | null> => {
    const sql = await sqlClient();
    const rows = await sql<PersonRow>`
      select u.id, u.name, u.email, coalesce(p.display_name, '') as display_name, p.avatar
      from "user" u
      left join profiles p on p.user_id = u.id
      where lower(u.email) = ${data.email} and u.id <> ${context.userId}
      limit 1
    `;
    return rows[0] ? asPerson(rows[0]) : null;
  });

export const requestFriend = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => {
    const email = lookupEmail(input);
    if (!email) throw new Error("Нужен телефон или почта");
    return { email };
  })
  .handler(async ({ context, data }): Promise<{ note: string }> => {
    const sql = await sqlClient();
    const me = context.userId;
    const found = await sql<{ id: string }>`
      select id from "user" where lower(email) = ${data.email} limit 1
    `;
    const other = found[0]?.id;
    if (!other) return { note: "Нет такого аккаунта. Друг сначала регистрируется." };
    if (other === me) return { note: "Это вы." };
    const existing = await sql<{ id: string; status: string; requester_id: string }>`
      select id, status, requester_id from friendships
      where (requester_id = ${me} and addressee_id = ${other})
         or (requester_id = ${other} and addressee_id = ${me})
      limit 1
    `;
    const row = existing[0];
    if (row?.status === "accepted") return { note: "Вы уже друзья." };
    if (row?.status === "pending" && row.requester_id === me) return { note: "Заявка уже отправлена." };
    if (row?.status === "pending") {
      await sql`update friendships set status = 'accepted' where id = ${row.id}`;
      return { note: "Заявка была взаимной — вы теперь друзья." };
    }
    await sql`
      insert into friendships (id, requester_id, addressee_id, status)
      values (${crypto.randomUUID()}, ${me}, ${other}, 'pending')
    `;
    return { note: "Заявка отправлена." };
  });

export const answerFriend = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => {
    const record = input && typeof input === "object" ? (input as { friendshipId?: unknown; accept?: unknown }) : {};
    const friendshipId = cleanId(record.friendshipId);
    if (!friendshipId) throw new Error("Нет заявки");
    return { friendshipId, accept: record.accept === true };
  })
  .handler(async ({ context, data }): Promise<{ ok: boolean }> => {
    const sql = await sqlClient();
    const me = context.userId;
    if (data.accept) {
      const updated = await sql<{ id: string }>`
        update friendships set status = 'accepted'
        where id = ${data.friendshipId} and addressee_id = ${me} and status = 'pending'
        returning id
      `;
      return { ok: updated.length > 0 };
    }
    const removed = await sql<{ id: string }>`
      delete from friendships
      where id = ${data.friendshipId}
        and (requester_id = ${me} or addressee_id = ${me})
      returning id
    `;
    return { ok: removed.length > 0 };
  });

export const listMessages = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator((input: unknown) => {
    const friendId = cleanId(input && typeof input === "object" ? (input as { friendId?: unknown }).friendId : "");
    if (!friendId) throw new Error("Нет переписки");
    return { friendId };
  })
  .handler(async ({ context, data }): Promise<ChatMessage[]> => {
    const sql = await sqlClient();
    const me = context.userId;
    const allowed = await sql<{ id: string }>`
      select id from friendships
      where status = 'accepted'
        and (
          (requester_id = ${me} and addressee_id = ${data.friendId})
          or (requester_id = ${data.friendId} and addressee_id = ${me})
        )
      limit 1
    `;
    if (!allowed[0]) return [];
    const rows = await sql<{ id: string; sender_id: string; body: string; at: string }>`
      select id, sender_id, body, at from (
        select
          id,
          sender_id,
          body,
          to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as at
        from messages
        where (sender_id = ${me} and recipient_id = ${data.friendId})
           or (sender_id = ${data.friendId} and recipient_id = ${me})
        order by created_at desc
        limit 80
      ) recent
      order by at asc
    `;
    return rows.map((row) => ({
      id: row.id,
      mine: row.sender_id === me,
      body: row.body,
      at: row.at,
    }));
  });

export const sendMessage = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => {
    const record = input && typeof input === "object" ? (input as { friendId?: unknown; body?: unknown }) : {};
    const friendId = cleanId(record.friendId);
    const body = typeof record.body === "string" ? record.body.trim().slice(0, 500) : "";
    if (!friendId || !body) throw new Error("Пустое сообщение");
    return { friendId, body };
  })
  .handler(async ({ context, data }): Promise<ChatMessage> => {
    const sql = await sqlClient();
    const me = context.userId;
    const allowed = await sql<{ id: string }>`
      select id from friendships
      where status = 'accepted'
        and (
          (requester_id = ${me} and addressee_id = ${data.friendId})
          or (requester_id = ${data.friendId} and addressee_id = ${me})
        )
      limit 1
    `;
    if (!allowed[0]) throw new Error("Писать можно только другу");
    const id = crypto.randomUUID();
    const rows = await sql<{ at: string }>`
      insert into messages (id, sender_id, recipient_id, body)
      values (${id}, ${me}, ${data.friendId}, ${data.body})
      returning to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as at
    `;
    return { id, mine: true, body: data.body, at: rows[0]?.at ?? "" };
  });

export type SharedHabit = { id: string; label: string; mark: string };
export type SharedDay = { mood: 0 | 1 | 2 | 3 | 4; habits: string[] };
export type SharedJournal = {
  year: number;
  habits: SharedHabit[];
  days: Record<string, SharedDay>;
};

function isMood(value: unknown): value is SharedDay["mood"] {
  return value === 0 || value === 1 || value === 2 || value === 3 || value === 4;
}

function cleanJournal(input: unknown): SharedJournal {
  const record = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const year = typeof record.year === "number" ? Math.trunc(record.year) : new Date().getFullYear();
  if (year < 2000 || year > 2100) throw new Error("Неверный год");
  const habits: SharedHabit[] = [];
  if (Array.isArray(record.habits)) {
    for (const item of record.habits) {
      if (!item || typeof item !== "object") continue;
      const row = item as Record<string, unknown>;
      const id = typeof row.id === "string" ? row.id.trim() : "";
      if (!/^[a-zA-Z0-9_-]{1,24}$/.test(id)) continue;
      habits.push({
        id,
        label: typeof row.label === "string" && row.label.trim() ? row.label.trim().slice(0, 24) : "Привычка",
        mark: typeof row.mark === "string" && row.mark.trim() ? row.mark.trim().slice(0, 8) : "•",
      });
      if (habits.length >= 8) break;
    }
  }
  const days: Record<string, SharedDay> = {};
  let count = 0;
  if (record.days && typeof record.days === "object" && !Array.isArray(record.days)) {
    for (const [key, value] of Object.entries(record.days as Record<string, unknown>)) {
      if (count >= 800) break;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(key) || !value || typeof value !== "object") continue;
      const day = value as Record<string, unknown>;
      if (!isMood(day.mood)) continue;
      const habitIds: string[] = [];
      if (Array.isArray(day.habits)) {
        for (const id of day.habits) {
          if (typeof id === "string" && /^[a-zA-Z0-9_-]{1,24}$/.test(id)) habitIds.push(id);
        }
      }
      days[key] = { mood: day.mood, habits: habitIds };
      count += 1;
    }
  }
  const journal = { year, habits, days };
  if (JSON.stringify(journal).length > 100_000) throw new Error("Календарь слишком большой");
  return journal;
}

async function acceptedFriend(me: string, friendId: string) {
  const sql = await sqlClient();
  const rows = await sql<{ id: string }>`
    select id from friendships
    where status = 'accepted'
      and (
        (requester_id = ${me} and addressee_id = ${friendId})
        or (requester_id = ${friendId} and addressee_id = ${me})
      )
    limit 1
  `;
  return Boolean(rows[0]);
}

export const publishJournal = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => cleanJournal(input))
  .handler(async ({ context, data }) => {
    const sql = await sqlClient();
    const payload = JSON.stringify(data);
    await sql`
      insert into journals (user_id, payload, updated_at)
      values (${context.userId}, ${payload}, now())
      on conflict (user_id) do update
      set payload = excluded.payload, updated_at = now()
    `;
    return { ok: true };
  });

export const getFriendJournal = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => {
    const friendId = cleanId(input && typeof input === "object" ? (input as { friendId?: unknown }).friendId : "");
    if (!friendId) throw new Error("Нет такого друга");
    return { friendId };
  })
  .handler(async ({ context, data }): Promise<SharedJournal | null> => {
    const me = context.userId;
    if (!(await acceptedFriend(me, data.friendId))) throw new Error("Календарь виден только принятому другу");
    const sql = await sqlClient();
    const rows = await sql<{ payload: string }>`
      select payload from journals where user_id = ${data.friendId} limit 1
    `;
    if (!rows[0]?.payload) return null;
    try {
      return cleanJournal(JSON.parse(rows[0].payload) as unknown);
    } catch {
      return null;
    }
  });


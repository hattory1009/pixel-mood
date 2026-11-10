import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";

export type Profile = {
  displayName: string;
  avatar: string | null;
};

const AVATAR_PREFIX = "data:image/jpeg;base64,";
const AVATAR_MAX = 180_000;

type ProfileInput = {
  displayName: string;
  avatar: string | null;
};

function asProfileInput(input: unknown): ProfileInput {
  if (!input || typeof input !== "object") throw new Error("Некорректный профиль");
  const record = input as Record<string, unknown>;
  const displayName = typeof record.displayName === "string" ? record.displayName.trim().slice(0, 32) : "";
  if (record.avatar === null || record.avatar === "") return { displayName, avatar: null };
  if (typeof record.avatar !== "string" || !record.avatar.startsWith(AVATAR_PREFIX) || record.avatar.length > AVATAR_MAX) {
    throw new Error("Фото нужно уменьшить: только небольшой JPEG");
  }
  return { displayName, avatar: record.avatar };
}

export const getProfile = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }): Promise<Profile> => {
    const { getSql } = await import("@/lib/db");
    const sql = await getSql();
    const rows = await sql<{ display_name: string; avatar: string | null }>`
      select display_name, avatar from profiles where user_id = ${context.userId}
    `;
    const row = rows[0];
    return {
      displayName: row?.display_name ?? "",
      avatar: row?.avatar ?? null,
    };
  });

export const saveProfile = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => asProfileInput(input))
  .handler(async ({ context, data }): Promise<Profile> => {
    const { getSql } = await import("@/lib/db");
    const sql = await getSql();
    await sql`
      insert into profiles (user_id, display_name, avatar, updated_at)
      values (${context.userId}, ${data.displayName}, ${data.avatar}, now())
      on conflict (user_id) do update
      set display_name = excluded.display_name,
          avatar = excluded.avatar,
          updated_at = now()
    `;
    return data;
  });

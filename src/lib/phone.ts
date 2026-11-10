/** Служебный адрес, чтобы вход по телефону жил в существующей почтовой сессии. */
export const PHONE_EMAIL_DOMAIN = "phone.pixelmood.app";

/** Российский номер к виду +7 и 10 цифр. +7 и ведущая 8 — один и тот же номер. */
export function normalizeRuPhone(raw: string): string | null {
  let digits = raw.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("8")) digits = `7${digits.slice(1)}`;
  else if (digits.length === 10) digits = `7${digits}`;
  if (!/^7\d{10}$/.test(digits)) return null;
  return `+${digits}`;
}

export function formatRuPhone(e164: string): string {
  const digits = e164.replace(/\D/g, "");
  if (!/^7\d{10}$/.test(digits)) return e164;
  return `+7 ${digits.slice(1, 4)} ${digits.slice(4, 7)}-${digits.slice(7, 9)}-${digits.slice(9)}`;
}

export function phoneToAuthEmail(e164: string): string {
  return `${e164.replace(/\D/g, "")}@${PHONE_EMAIL_DOMAIN}`;
}

export function phoneFromAuthEmail(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at < 0) return null;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1).toLowerCase();
  if (domain !== PHONE_EMAIL_DOMAIN || !/^7\d{10}$/.test(local)) return null;
  return `+${local}`;
}

/** Почта для входа: телефон сворачивается в служебный адрес, обычная почта остаётся почтой. */
export function identityEmail(raw: string): string | null {
  const phone = normalizeRuPhone(raw);
  if (phone) return phoneToAuthEmail(phone);
  const email = raw.trim().toLowerCase();
  if (!email.includes("@") || email.includes(" ") || email.length > 120) return null;
  return email;
}

export function contactLabel(email: string | null | undefined): string | null {
  if (!email || email.endsWith("@viewer.grok.invalid")) return null;
  const phone = phoneFromAuthEmail(email);
  return phone ? formatRuPhone(phone) : email;
}

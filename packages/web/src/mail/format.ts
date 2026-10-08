import type { MailAddress } from "@argelanderspace/contracts";

/** "Name <addr>" pieces for display; an address with no name shows just the address. */
export function addressName(a: MailAddress | null): string {
  if (!a) return "";
  return a.name.trim() || a.address;
}

export function addressList(list: MailAddress[]): string {
  return list.map((a) => (a.name.trim() ? `${a.name.trim()} <${a.address}>` : a.address)).join(", ");
}

/** Time of day for today, otherwise a short date in the interface language. */
export function shortDate(iso: string | null, language: string, now = new Date()): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  if (d.toDateString() === now.toDateString())
    return d.toLocaleTimeString(language, { hour: "2-digit", minute: "2-digit", hour12: false });
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString(language === "en" ? "en-US" : language, {
    ...(sameYear ? {} : { year: "numeric" }),
    month: language === "en" ? "short" : "long",
    day: "numeric",
  });
}

export function longDate(iso: string | null, language: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(language === "en" ? "en-US" : language, { dateStyle: "medium", timeStyle: "short", hour12: false });
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

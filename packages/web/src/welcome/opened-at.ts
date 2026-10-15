/**
 * When a recent project was last opened, as the welcome page says it: today with the time ("today 09:12"), otherwise
 * the distance in days, weeks, months or years in the page's language ("yesterday", "3 weeks ago", "last year").
 */
export function openedAtText(iso: string, language: string, now: Date = new Date()): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const relative = new Intl.RelativeTimeFormat(language, { numeric: "auto" });
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(at)) / 86_400_000);
  if (days <= 0) {
    const time = new Intl.DateTimeFormat(language, { hour: "2-digit", minute: "2-digit", hour12: false }).format(at);
    return `${relative.format(0, "day")} ${time}`;
  }
  if (days < 7) return relative.format(-days, "day");
  if (days < 30) return relative.format(-Math.floor(days / 7), "week");
  const months = (now.getFullYear() - at.getFullYear()) * 12 + now.getMonth() - at.getMonth();
  if (months < 12) return relative.format(-Math.max(1, months), "month");
  return relative.format(-(now.getFullYear() - at.getFullYear()), "year");
}

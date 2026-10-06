// Human-friendly times and names.

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const yearFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const fullFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** "just now", "4 min ago", "2:14 PM", "Yesterday", "Oct 3", "Oct 3, 2025". */
export function relTime(ms: number, now = Date.now()): string {
  const s = Math.round((now - ms) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  const d = new Date(ms), n = new Date(now);
  if (sameDay(d, n)) return timeFmt.format(d);
  const y = new Date(now - 86400_000);
  if (sameDay(d, y)) return `Yesterday`;
  return d.getFullYear() === n.getFullYear() ? dayFmt.format(d) : yearFmt.format(d);
}

export function fullTime(ms: number): string {
  return fullFmt.format(new Date(ms));
}

export function clockTime(ms: number): string {
  return timeFmt.format(new Date(ms));
}

export function dayLabel(ms: number, now = Date.now()): string {
  const d = new Date(ms), n = new Date(now);
  if (sameDay(d, n)) return 'Today';
  if (sameDay(d, new Date(now - 86400_000))) return 'Yesterday';
  return d.getFullYear() === n.getFullYear() ? dayFmt.format(d) : yearFmt.format(d);
}

export function initials(name: string): string {
  const parts = name.trim().split(/[\s_.-]+/).filter(Boolean);
  if (!parts.length) return '?';
  const first = [...parts[0]][0] ?? '';
  const second = parts.length > 1 ? [...parts[parts.length - 1]][0] ?? '' : [...parts[0]][1] ?? '';
  return (first + (parts.length > 1 ? second : '')).toUpperCase() || '?';
}

/** "Alice ✓other.tld" → { name: "Alice", issuer: "other.tld" } */
export function splitLabel(label: string): { name: string; issuer: string | null } {
  const i = label.lastIndexOf(' ✓');
  return i < 0 ? { name: label, issuer: null } : { name: label.slice(0, i), issuer: label.slice(i + 2) };
}

export function plural(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

export function kindLabel(kind: string | undefined): string {
  return kind === 'agent' ? 'Agent' : kind === 'service' ? 'Service' : kind === 'guest' ? 'Guest' : 'Human';
}

const GUEST_SUFFIX = ' (guest)';
/** "Anonymous Heron (guest)" → "Anonymous Heron": for places that show a Guest chip instead. */
export function guestBase(name: string): string {
  return name.endsWith(GUEST_SUFFIX) ? name.slice(0, -GUEST_SUFFIX.length) : name;
}

/** "in 40 min", "in 5 hours", "Oct 13": a time ahead (reads after "Expires"). */
export function untilTime(ms: number, now = Date.now()): string {
  const s = Math.round((ms - now) / 1000);
  if (s < 3600) return `in ${Math.max(1, Math.round(s / 60))} min`;
  if (s < 36 * 3600) return `in ${Math.round(s / 3600)} hours`;
  const d = new Date(ms);
  return d.getFullYear() === new Date(now).getFullYear() ? dayFmt.format(d) : yearFmt.format(d);
}

/**
 * A person's initials in a soft tone — no photos, no external avatar service.
 *
 * Initials: the first letter of the first and last word ("Mona Adel" → "MA"); Arabic letters
 * are separated by a zero-width non-joiner so they stay two letters instead of joining into a
 * word ("أحمد علي" → "أ‌ع"). The tone is picked from the stable id (or the name), so one person
 * keeps one colour everywhere. Every tone pairs a light fill with dark text above 7:1.
 */
const TONES = [
  "bg-[#E3EFE6] text-[#1F3D24]",
  "bg-[#E4ECF7] text-[#1D3F66]",
  "bg-[#F6EADB] text-[#6B3A0B]",
  "bg-[#EDE7F6] text-[#3E2A6B]",
  "bg-[#E2F0F0] text-[#164B4B]",
  "bg-[#F5E4E8] text-[#6B1F33]",
] as const;

const SIZE = { sm: "h-7 w-7 text-[11px]", md: "h-9 w-9 text-xs", lg: "h-16 w-16 text-xl" } as const;

export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  const first = [...words[0]][0] ?? "";
  const last = words.length > 1 ? [...words[words.length - 1]][0] ?? "" : "";
  const arabic = /[؀-ۿ]/.test(first + last);
  return arabic ? (last ? `${first}‌${last}` : first) : (first + last).toUpperCase();
}

function toneOf(seed: string) {
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return TONES[h % TONES.length];
}

/** Decorative by default (the name is written next to it); pass `label` when it stands alone. */
export function Avatar({ name, seed, size = "md", label, className = "" }: { name: string; seed?: string; size?: keyof typeof SIZE; label?: string; className?: string }) {
  return (
    <span
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
      className={`inline-grid shrink-0 select-none place-items-center rounded-full font-semibold leading-none ${SIZE[size]} ${toneOf(seed ?? name)} ${className}`}
    >
      {initialsOf(name)}
    </span>
  );
}

/**
 * A compact switch between two-to-four views of the same list ("Awaiting decision / All",
 * "Open / All"). Visually subordinate to the page's Tabs, so a page never shows two rows of
 * identical underlined tabs. Buttons with aria-pressed — each is a toggle, not a tab panel.
 */
export function Segmented<T extends string>({
  value,
  onChange,
  items,
  label,
}: {
  value: T;
  onChange: (v: T) => void;
  items: { key: T; label: string; count?: number; badge?: number }[];
  label?: string;
}) {
  return (
    <div role="group" aria-label={label} className="inline-flex w-fit max-w-full overflow-x-auto rounded-lg border border-united-border bg-united-subtle p-0.5 no-scrollbar">
      {items.map((it) => {
        const on = it.key === value;
        return (
          <button
            key={it.key}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(it.key)}
            className={`inline-flex min-h-[36px] coarse:min-h-[44px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-3 text-sm transition-colors ${
              on ? "bg-white font-semibold text-united-dark shadow-card" : "font-medium text-united-muted hover:text-united-dark"
            }`}
          >
            {it.label}
            {it.count !== undefined && <span className={`rounded-full px-1.5 text-xs ${on ? "bg-united-subtle" : "bg-white/70"}`}>{it.count}</span>}
            {!!it.badge && <span className="rounded-full bg-united-danger px-1.5 text-xs font-semibold text-white">{it.badge}</span>}
          </button>
        );
      })}
    </div>
  );
}

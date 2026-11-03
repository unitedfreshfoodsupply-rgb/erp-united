import type { ReactNode } from "react";

/**
 * A form control with its label always visible above it (never a placeholder as the only
 * label: the placeholder disappears as soon as the user types). Wrapping the control in
 * the <label> gives it its accessible name without ids. `error` is shown under the
 * control and announced; pass `aria-invalid` on the control itself to mark its border.
 */
export function Field({ label, children, required, hint, error, className }: { label: string; children: ReactNode; required?: boolean; hint?: string; error?: string | null; className?: string }) {
  return (
    <label className={`flex min-w-0 flex-col gap-1 ${className ?? ""}`}>
      <span className="field-label">
        {label}
        {required && <span aria-hidden className="ms-0.5 text-united-danger">*</span>}
      </span>
      {children}
      {hint && !error && <span className="text-xs text-united-muted">{hint}</span>}
      {error && <span role="alert" className="text-xs font-semibold text-united-danger">{error}</span>}
    </label>
  );
}

/**
 * A refusal (Nov 2026): a 4xx answer other than 408 (timeout) and 429 (rate limit) — no
 * permission, a missing record, a refused filter. The same request gets the same answer, so it
 * is not retried (app/providers.tsx) and no Retry button is offered for it
 * (components/reports/ReportViewer.tsx). A network failure, a server fault, a timeout or a rate
 * limit may pass on a second try.
 */
export function isRefusal(error: unknown): boolean {
  const status = (error as { status?: number } | null)?.status;
  return typeof status === "number" && status >= 400 && status < 500 && status !== 408 && status !== 429;
}

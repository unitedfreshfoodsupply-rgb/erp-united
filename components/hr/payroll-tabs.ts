/** The payroll tab to show: the one the user chose while it is still permitted, else the first
 * permitted one. Worked out on every render, because the permissions arrive after the first one
 * (when nothing is permitted yet), so the tab is never fixed at mount. */
export function payrollTab<T extends string>(chosen: T | null, permitted: readonly T[], fallback: T): T {
  return chosen && permitted.includes(chosen) ? chosen : permitted[0] ?? fallback;
}

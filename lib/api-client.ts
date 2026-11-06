import { readLocaleCookie } from "@/lib/locale/cookie";

export class ApiClientError extends Error {
  /** Machine-readable code and structured detail the server attached, when any. `ref` is the
   * server's error reference (lib/rbac.ts handleApiError) — the key to its log line. */
  constructor(message: string, public code?: string, public details?: unknown, public status?: number, public ref?: string) {
    super(message);
  }
}

/**
 * The ApiClientError for a failed response body. A server fault (5xx) carries a reference
 * that ties the user's report to the server log line; it is shown with the message, so every
 * toast and ErrorState gives it without per-screen code.
 */
export function apiErrorFrom(status: number, data: unknown): ApiClientError {
  const body = (data ?? {}) as { error?: unknown; code?: unknown; details?: unknown; ref?: unknown };
  const loc = storedLocale();
  // A non-JSON body (proxy error page) or a non-string `error` must still read as
  // text — never "[object Object]" or an empty message.
  const serverMessage = typeof body.error === "string" && body.error.trim() ? body.error : null;
  const ref = typeof body.ref === "string" && body.ref.trim() ? body.ref.trim() : undefined;
  let message = serverMessage ?? (loc === "en" ? `Error (${status})` : `خطأ (${status})`);
  if (ref && status >= 500) message += loc === "en" ? ` (reference: ${ref})` : ` (رقم المرجع: ${ref})`;
  return new ApiClientError(message, typeof body.code === "string" ? body.code : undefined, body.details, status, ref);
}

/**
 * The locale the user picked (lib/locale/context.tsx); null when unset. The u_locale cookie
 * answers when storage is blocked, and before LocaleProvider has copied it into storage.
 */
function storedLocale(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const stored = window.localStorage.getItem("united_locale");
    if (stored) return stored;
  } catch {
    // storage blocked: the cookie below
  }
  return readLocaleCookie(document.cookie);
}

/**
 * Response type when a call site does not name one. Kept as `any` deliberately: the
 * server is the source of truth for response shapes and most screens read them through
 * React Query without a local type. Call sites that need checking pass `T` explicitly.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Untyped = any;

/**
 * One request with the client's shared contract: the tab's token and language, "no internet"
 * for a network failure, the sign-in redirect on 401 and the two-step-enrolment redirect.
 * Returns the response (ok or not) and its JSON body when it has one.
 */
async function send(path: string, init: RequestInit | undefined, accept: "json" | "file"): Promise<{ res: Response; data: unknown }> {
  let res: Response;
  try {
    const headers = new Headers(init?.headers);
    const isFormData = typeof FormData !== "undefined" && init?.body instanceof FormData;
    if (accept === "json" && !isFormData && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    // Attach the tab-scoped Bearer token from sessionStorage, if the client
    // has one. This enables independent sessions across browser tabs without
    // relying on the shared httpOnly cookie.
    if (typeof window !== "undefined") {
      const token = window.sessionStorage.getItem("united_token");
      if (token) headers.set("Authorization", `Bearer ${token}`);
      // Forward the selected locale so the server returns messages in the
      // right language.  Falls back to "ar" (existing default).
      const locale = storedLocale();
      if (locale) headers.set("Accept-Language", locale);
    }
    res = await fetch(path, {
      ...init,
      headers,
      credentials: "include",
    });
  } catch {
    const loc = storedLocale();
    // The browser says when it is offline; otherwise the network is up and the server is what
    // could not be reached (down, restarting, blocked), so do not blame the user's internet.
    const offline = typeof navigator !== "undefined" && navigator.onLine === false;
    throw new ApiClientError(
      offline
        ? loc === "en" ? "No internet connection, please try again" : "مفيش اتصال بالإنترنت، حاول تاني"
        : loc === "en" ? "Could not reach the server, please try again" : "مقدرناش نوصل للسيرفر، حاول تاني",
    );
  }

  if (res.status === 401 && typeof window !== "undefined" && !path.includes("/auth/")) {
    const loc = storedLocale();
    window.location.href = "/login";
    throw new ApiClientError(loc === "en" ? "Please sign in again" : "لازم تسجل دخول تاني");
  }

  // A file answer's body is the file: read JSON only from a JSON answer or a failure.
  const data = accept === "json" || !res.ok ? await res.json().catch(() => ({})) : null;
  // WS6: the session is held until two-step sign-in is set up — go there, not to /login.
  if (res.status === 403 && (data as { code?: unknown } | null)?.code === "auth.mfa-enroll-required" && typeof window !== "undefined" && !window.location.pathname.startsWith("/mfa/")) {
    window.location.href = "/mfa/setup";
  }
  if (!res.ok) throw apiErrorFrom(res.status, data);
  return { res, data };
}

export async function apiFetch<T = Untyped>(path: string, init?: RequestInit): Promise<T> {
  const { data } = await send(path, init, "json");
  return data as T;
}

/**
 * Downloads a file (a report export, a CSV) and hands it to the browser to save, under the
 * name the server gave (Content-Disposition) or `fallbackName`. A refusal or a server fault
 * throws the same ApiClientError as apiFetch — the server's own message, and its reference
 * for a 5xx — so the screen shows why, not a generic "download failed".
 */
export async function apiDownload(path: string, fallbackName: string, init?: RequestInit): Promise<void> {
  const { res } = await send(path, init, "file");
  const blob = await res.blob();
  const disposition = res.headers.get("Content-Disposition") ?? "";
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
  let name = /filename="([^"]+)"/.exec(disposition)?.[1] ?? fallbackName;
  if (encoded) {
    try {
      name = decodeURIComponent(encoded);
    } catch {
      // a malformed encoded name: keep the plain one
    }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoked after the click has been handled: some browsers read the URL asynchronously.
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export const apiPost = <T = Untyped>(path: string, body?: unknown) =>
  apiFetch<T>(path, { method: "POST", body: body ? JSON.stringify(body) : undefined });

export const apiPostForm = <T = Untyped>(path: string, body: FormData) =>
  apiFetch<T>(path, { method: "POST", body });

export const apiPatch = <T = Untyped>(path: string, body?: unknown) =>
  apiFetch<T>(path, { method: "PATCH", body: body ? JSON.stringify(body) : undefined });

export const apiPut = <T = Untyped>(path: string, body?: unknown) =>
  apiFetch<T>(path, { method: "PUT", body: body ? JSON.stringify(body) : undefined });

/**
 * The server's own message for a failed query, when there is one — e.g. the actual
 * "مالكش صلاحية..." (forbidden) text for a 403, instead of `ErrorState`'s generic
 * "connection error" default. A permission revoked mid-shift then reads as what it
 * is, not as a network blip, without every polling board re-deriving this itself.
 */
export function errorMessage(error: unknown): string | undefined {
  return error instanceof ApiClientError ? error.message : undefined;
}
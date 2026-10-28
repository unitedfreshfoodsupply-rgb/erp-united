export class ApiClientError extends Error {}

/** The locale the user picked (lib/locale/context.tsx); null when unset or storage is blocked. */
function storedLocale(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem("united_locale");
  } catch {
    return null;
  }
}

/**
 * Response type when a call site does not name one. Kept as `any` deliberately: the
 * server is the source of truth for response shapes and most screens read them through
 * React Query without a local type. Call sites that need checking pass `T` explicitly.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Untyped = any;

export async function apiFetch<T = Untyped>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    const headers = new Headers(init?.headers);
    const isFormData = typeof FormData !== "undefined" && init?.body instanceof FormData;
    if (!isFormData && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
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
    throw new ApiClientError(loc === "en" ? "No internet connection, please try again" : "مفيش اتصال بالإنترنت، حاول تاني");
  }

  if (res.status === 401 && typeof window !== "undefined" && !path.includes("/auth/")) {
    const loc = storedLocale();
    window.location.href = "/login";
    throw new ApiClientError(loc === "en" ? "Please sign in again" : "لازم تسجل دخول تاني");
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const loc = storedLocale();
    // A non-JSON body (proxy error page) or a non-string `error` must still read as
    // text — never "[object Object]" or an empty message.
    const serverMessage = typeof data?.error === "string" && data.error.trim() ? data.error : null;
    throw new ApiClientError(serverMessage ?? (loc === "en" ? `Error (${res.status})` : `خطأ (${res.status})`));
  }
  return data as T;
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
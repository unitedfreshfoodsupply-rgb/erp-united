import { LocalStorageProvider } from "./local";
import { SupabaseStorageProvider } from "./supabase";
import { StorageUnavailableError, type StorageProvider } from "./types";

export { StorageUnavailableError, type StorageProvider };

let cached: StorageProvider | null = null;

/**
 * STORAGE_PROVIDER=supabase (production default) or local (development default).
 * Production never falls back to local disk: a server whose disk is wiped on every
 * deploy would silently lose documents. Missing configuration fails closed — the
 * attachment endpoints answer 503 — rather than storing files somewhere unsafe. The
 * error's message names the missing setting: it goes to the server log, never to the user.
 */
export function storageProvider(): StorageProvider {
  if (cached) return cached;
  const isProd = process.env.NODE_ENV === "production" && process.env.NEXT_PHASE !== "phase-production-build";
  const choice = process.env.STORAGE_PROVIDER ?? (isProd ? "supabase" : "local");
  if (choice === "local") {
    cached = new LocalStorageProvider(process.env.LOCAL_STORAGE_DIR || "./storage");
  } else if (choice === "supabase") {
    const url = process.env.SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !serviceKey) {
      throw new StorageUnavailableError("تخزين الملفات مش متظبط (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)");
    }
    cached = new SupabaseStorageProvider({ url, serviceKey, bucket: process.env.SUPABASE_STORAGE_BUCKET || "erp-attachments" });
  } else {
    throw new StorageUnavailableError(`STORAGE_PROVIDER غير معروف: ${choice}`);
  }
  return cached;
}

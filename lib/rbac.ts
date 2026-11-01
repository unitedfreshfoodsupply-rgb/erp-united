import { randomUUID } from "crypto";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { localizeServerMessage } from "@/lib/locale/server-messages";

export class ApiError extends Error {
  status: number;
  /** Optional error code for known message patterns that need bilingual support. */
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const ERRORS_AR: Record<string, string> = {
  validation: "بيانات الطلب غير صالحة: نوع حقل غير متوقع",
  duplicate: "السجل ده موجود بالفعل (تكرار) — حدّث الصفحة وراجع",
  nul_char: "النص فيه حرف غير مسموح (NUL)",
  stale: "السجل اتغيّر من واحد تاني في نفس اللحظة — حدّث الشاشة وجرّب تاني",
  too_large: "رقم أكبر من المسموح",
  check_ref: "مرجع غير موجود (صنف/مكان/طرف غير معروف)",
  check_default: "البيانات مخالفة لقاعدة:",
  server: "خطأ في السيرفر",
  "auth.required": "لازم تسجل دخول الأول",
  "auth.change-password": "لازم تغيّر كلمة السر الأول",
  "auth.invalid-login": "بيانات الدخول غلط",
  "auth.enter-credentials": "دخّل اسم المستخدم وكلمة السر",
};

const ERRORS_EN: Record<string, string> = {
  validation: "Invalid request data: unexpected field type",
  duplicate: "This record already exists (duplicate) — refresh and review",
  nul_char: "Text contains an unsupported character (NUL)",
  stale: "The record was changed by someone else at the same moment — refresh and try again",
  too_large: "Number too large",
  check_ref: "Reference not found (product/location/party unknown)",
  check_default: "Data violates rule:",
  server: "Server error",
  "auth.required": "You must sign in first",
  "auth.change-password": "You must change your password first",
  "auth.invalid-login": "Invalid login credentials",
  "auth.enter-credentials": "Enter username and password",
};

function localeFromReq(req?: NextRequest): "ar" | "en" {
  if (!req) return "ar";
  const h = req.headers.get("accept-language");
  return h === "en" ? "en" : "ar";
}

function msg(locale: "ar" | "en", key: string, fallbackAr: string): string {
  if (locale === "en") return ERRORS_EN[key] ?? fallbackAr;
  return ERRORS_AR[key] ?? fallbackAr;
}

export function handleApiError(err: unknown, req?: NextRequest) {
  const loc = localeFromReq(req);
  if (err instanceof ApiError) {
    // A known code has a fixed translation; any other message is translated from the
    // catalog with its specific details intact (unknown text stays as written).
    if (err.code && loc === "en") {
      const translated = ERRORS_EN[err.code];
      if (translated) {
        return NextResponse.json({ error: translated }, { status: err.status });
      }
    }
    return NextResponse.json({ error: localizeServerMessage(err.message, loc) }, { status: err.status });
  }
  // A short reference ties what the user reports to the server log line.
  const ref = randomUUID().slice(0, 8);
  const mapped = clientFault(err, loc);
  if (mapped) {
    (mapped.loud ? console.error : console.warn)(`[api-${mapped.status} ${ref}]`, (err as Error)?.message?.split("\n").filter(Boolean).slice(-1)[0]);
    return NextResponse.json({ error: mapped.message, ref }, { status: mapped.status });
  }
  console.error(`[api-error ${ref}]`, err);
  return NextResponse.json({ error: msg(loc, "server", "خطأ في السيرفر"), ref }, { status: 500 });
}

/**
 * Database errors that can only come from the request itself — never a server fault:
 * - a Prisma validation error: a field of the wrong shape (an object where an id goes)
 *   reached a query unvalidated;
 * - a unique-key race: two requests created the same code at the same moment;
 * - a lost optimistic-lock race (P2025 on an update guarded by its version);
 * - PostgreSQL refusing a NUL character in text.
 * Everything else stays a 500.
 */
function clientFault(err: unknown, loc: "ar" | "en"): { status: number; message: string; loud?: boolean } | null {
  const e = err as { name?: string; code?: string; message?: string } | null;
  if (!e || typeof e !== "object") return null;
  if (e.name === "PrismaClientValidationError") return { status: 400, message: msg(loc, "validation", "بيانات الطلب غير صالحة: نوع حقل غير متوقع") };
  if (e.name === "PrismaClientKnownRequestError" && e.code === "P2002") return { status: 409, message: msg(loc, "duplicate", "السجل ده موجود بالفعل (تكرار) — حدّث الصفحة وراجع") };
  // An update guarded by `version` found no row: a concurrent writer got there first (the
  // transaction rolled back; nothing was written).
  if (e.name === "PrismaClientKnownRequestError" && e.code === "P2025") return { status: 409, message: msg(loc, "stale", "السجل اتغيّر من واحد تاني في نفس اللحظة — حدّث الشاشة وجرّب تاني") };
  // A number too large for its column (numeric overflow): the request's value, not a fault.
  if (typeof e.message === "string" && /numeric field overflow|"22003"|code: "22003"/.test(e.message)) return { status: 400, message: msg(loc, "too_large", "رقم أكبر من المسموح") };
  if (typeof e.message === "string" && /invalid byte sequence for encoding \\"?UTF8\\"?": 0x00|unsupported Unicode escape sequence/.test(e.message)) return { status: 400, message: msg(loc, "nul_char", "النص فيه حرف غير مسموح (NUL)") };
  // A database rule refused the row (CHECK / foreign key). The transaction rolled back,
  // nothing was written; the request cannot succeed as sent.
  const check = typeof e.message === "string" ? /violates check constraint \\"?([A-Za-z0-9_]+)\\?"/.exec(e.message) : null;
  if (check) return { status: 422, message: loc === "en" ? `Data violates rule: ${check[1]} — check dates and quantities` : `البيانات مخالفة لقاعدة: ${check[1]} — راجع التواريخ والكميات`, loud: true };
  if ((e.name === "PrismaClientKnownRequestError" && e.code === "P2003") || (typeof e.message === "string" && /violates foreign key constraint/.test(e.message)))
    return { status: 400, message: msg(loc, "check_ref", "مرجع غير موجود (صنف/مكان/طرف غير معروف)"), loud: true };
  return null;
}
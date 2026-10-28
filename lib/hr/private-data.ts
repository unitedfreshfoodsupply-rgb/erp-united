import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/rbac";
import { writeAudit } from "@/lib/audit";
import { assertPermission } from "@/lib/authz-core";
import { advisoryXactLock } from "@/lib/dbLock";
import { inTx, type Tx } from "@/lib/tx";
import { isValidCalendarDate } from "@/lib/dates";
import { optText, parse, text } from "@/lib/core/validation";
import type { ServiceActor } from "@/lib/core/actor";

/**
 * An employee's confidential data (docs/erp/HR_PAYROLL_GAP_AUDIT.md §3.3, §6.3): identity
 * and insurance numbers, bank accounts, and the document register.
 *
 *  - Read needs hr.private.view, write hr.private.manage — checked here, not only at the door.
 *  - Every read is itself audited (who looked at whose file, when). The audit rows carry
 *    the names of the fields that changed, never their values: the audit log is readable by
 *    more people than this data is (see lib/security/audit-visibility.ts).
 *  - Bank accounts are never edited: a new account replaces the old one, which stays as history.
 *    Numbers are masked in every list; the full number is a separate, audited reveal.
 */

type Actorish = { id: string | null; name: string; role: string; deviceId?: string };
const optDay = z.string().refine(isValidCalendarDate, "التاريخ لازم يكون YYYY-MM-DD").nullable().optional();

const audit = (tx: Tx | typeof prisma, actor: Actorish, entityType: "employee_private" | "employee_bank_account" | "employee_document", entityId: string, action: string, detail: string | null, reason?: string) =>
  writeAudit({ userId: actor.id, userName: actor.name, role: actor.role, action, entityType, entityId, newValue: detail, reason, source: "user", deviceId: actor.deviceId }, tx as Tx);

export const maskAccount = (n: string) => (n.length <= 4 ? "••••" : `•••• ${n.slice(-4)}`);

async function employeeOr404(db: Tx | typeof prisma, id: string) {
  const e = await db.employee.findUnique({ where: { id }, select: { id: true, code: true, name: true } });
  if (!e) throw new ApiError(404, "الموظف مش موجود");
  return e;
}

// ---------------------------------------------------------------------------
// Personal and statutory identifiers
// ---------------------------------------------------------------------------

const PRIVATE_FIELDS = ["nationalId", "birthDate", "nationality", "insuranceNumber", "insuranceStartDate", "taxRegistrationNo", "address", "emergencyContactName", "emergencyContactPhone"] as const;

const privateInput = z.object({
  national_id: optText("الرقم القومي", 30).optional(),
  birth_date: optDay,
  nationality: optText("الجنسية", 60).optional(),
  insurance_number: optText("الرقم التأميني", 40).optional(),
  insurance_start_date: optDay,
  tax_registration_no: optText("رقم التسجيل الضريبي", 40).optional(),
  address: optText("العنوان", 300).optional(),
  emergency_contact_name: optText("اسم جهة الطوارئ", 100).optional(),
  emergency_contact_phone: optText("تليفون الطوارئ", 30).optional(),
  expected_version: z.number().int().positive().optional(),
});

export async function getPrivateFile(employeeId: string, actor: ServiceActor) {
  assertPermission(actor, "hr.private.view");
  const employee = await employeeOr404(prisma, employeeId);
  const [info, accounts, documents] = await Promise.all([
    prisma.employeePrivateInfo.findUnique({ where: { employeeId } }),
    prisma.employeeBankAccount.findMany({ where: { employeeId }, orderBy: [{ active: "desc" }, { createdAt: "desc" }] }),
    prisma.employeeDocument.findMany({
      where: { employeeId, attachment: { deletedAt: null } },
      orderBy: { createdAt: "desc" },
      include: { attachment: { select: { id: true, fileName: true, contentType: true, sizeBytes: true, category: true, createdAt: true } } },
    }),
  ]);
  await audit(prisma, actor, "employee_private", employeeId, "employee_private_viewed", `${employee.code}`);
  return {
    employee,
    info: info ?? null,
    bankAccounts: accounts.map(({ accountNumber, iban, ...a }) => ({ ...a, accountNumberMasked: maskAccount(accountNumber), ibanMasked: iban ? maskAccount(iban) : null })),
    documents: documents.map((d) => ({ ...d, documentNumber: d.documentNumber ? maskAccount(d.documentNumber) : null })),
  };
}

export async function savePrivateInfo(employeeId: string, input: unknown, actor: ServiceActor) {
  assertPermission(actor, "hr.private.manage");
  const v = parse(privateInput, input);
  const data = {
    ...(v.national_id !== undefined ? { nationalId: v.national_id } : {}),
    ...(v.birth_date !== undefined ? { birthDate: v.birth_date } : {}),
    ...(v.nationality !== undefined ? { nationality: v.nationality } : {}),
    ...(v.insurance_number !== undefined ? { insuranceNumber: v.insurance_number } : {}),
    ...(v.insurance_start_date !== undefined ? { insuranceStartDate: v.insurance_start_date } : {}),
    ...(v.tax_registration_no !== undefined ? { taxRegistrationNo: v.tax_registration_no } : {}),
    ...(v.address !== undefined ? { address: v.address } : {}),
    ...(v.emergency_contact_name !== undefined ? { emergencyContactName: v.emergency_contact_name } : {}),
    ...(v.emergency_contact_phone !== undefined ? { emergencyContactPhone: v.emergency_contact_phone } : {}),
  };
  return inTx(async (tx) => {
    await employeeOr404(tx, employeeId);
    const before = await tx.employeePrivateInfo.findUnique({ where: { employeeId } });
    if (before && v.expected_version !== undefined && before.version !== v.expected_version) throw new ApiError(409, "حد تاني عدّل البيانات دي — حدّث الصفحة وحاول تاني");
    let row;
    try {
      row = before
        ? await tx.employeePrivateInfo.update({ where: { employeeId, version: before.version }, data: { ...data, version: { increment: 1 }, updatedById: actor.id, updatedBy: actor.name } })
        : await tx.employeePrivateInfo.create({ data: { employeeId, ...data, updatedById: actor.id, updatedBy: actor.name } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") throw new ApiError(409, "الرقم القومي ده مسجل لموظف تاني");
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") throw new ApiError(409, "حد تاني عدّل البيانات دي — حدّث الصفحة وحاول تاني");
      throw err;
    }
    const changed = PRIVATE_FIELDS.filter((f) => (before?.[f] ?? null) !== (row[f] ?? null));
    await audit(tx, actor, "employee_private", employeeId, before ? "employee_private_updated" : "employee_private_created", changed.join(", ") || null);
    return row;
  });
}

// ---------------------------------------------------------------------------
// Bank accounts
// ---------------------------------------------------------------------------

const bankInput = z.object({
  bank_name: text("اسم البنك", 100),
  account_number: text("رقم الحساب", 40),
  iban: optText("IBAN", 40).optional(),
  holder_name: text("اسم صاحب الحساب", 100),
  reason: text("سبب التغيير", 300),
});

/** Adds the new salary account; the previous primary account is deactivated in the same transaction. */
export async function addBankAccount(employeeId: string, input: unknown, actor: ServiceActor) {
  assertPermission(actor, "hr.private.manage");
  const v = parse(bankInput, input);
  return inTx(async (tx) => {
    await advisoryXactLock(tx, `hr-bank:${employeeId}`);
    const employee = await employeeOr404(tx, employeeId);
    const previous = await tx.employeeBankAccount.findFirst({ where: { employeeId, isPrimary: true, active: true } });
    if (previous) await tx.employeeBankAccount.update({ where: { id: previous.id }, data: { active: false, deactivatedAt: new Date() } });
    const row = await tx.employeeBankAccount.create({
      data: { employeeId, bankName: v.bank_name, accountNumber: v.account_number.replace(/\s+/g, ""), iban: v.iban?.replace(/\s+/g, "") ?? null, holderName: v.holder_name, isPrimary: true, createdById: actor.id, createdBy: actor.name },
    });
    await audit(tx, actor, "employee_bank_account", row.id, "employee_bank_account_added", `${employee.code} · ${v.bank_name} · ${maskAccount(row.accountNumber)}${previous ? ` (replaces ${maskAccount(previous.accountNumber)})` : ""}`, v.reason);
    return { id: row.id, bankName: row.bankName, accountNumberMasked: maskAccount(row.accountNumber), active: row.active };
  });
}

export async function deactivateBankAccount(employeeId: string, accountId: string, input: unknown, actor: ServiceActor) {
  assertPermission(actor, "hr.private.manage");
  const v = parse(z.object({ reason: text("السبب", 300) }), input);
  return inTx(async (tx) => {
    const a = await tx.employeeBankAccount.findFirst({ where: { id: accountId, employeeId } });
    if (!a) throw new ApiError(404, "الحساب مش موجود");
    if (!a.active) throw new ApiError(409, "الحساب موقوف بالفعل");
    await tx.employeeBankAccount.update({ where: { id: a.id }, data: { active: false, deactivatedAt: new Date() } });
    await audit(tx, actor, "employee_bank_account", a.id, "employee_bank_account_deactivated", maskAccount(a.accountNumber), v.reason);
    return { id: a.id, active: false };
  });
}

/** The full number, for the one person who needs it now — audited every time. */
export async function revealBankAccount(employeeId: string, accountId: string, actor: ServiceActor) {
  assertPermission(actor, "hr.private.view");
  const a = await prisma.employeeBankAccount.findFirst({ where: { id: accountId, employeeId } });
  if (!a) throw new ApiError(404, "الحساب مش موجود");
  await audit(prisma, actor, "employee_bank_account", a.id, "employee_bank_account_revealed", maskAccount(a.accountNumber));
  return { id: a.id, accountNumber: a.accountNumber, iban: a.iban };
}

// ---------------------------------------------------------------------------
// Document register (the bytes are an Attachment on entity "employee")
// ---------------------------------------------------------------------------

const DOC_TYPES = ["id_document", "employment_contract", "insurance_form", "certificate", "medical", "other"] as const;
const documentInput = z.object({
  attachment_id: text("المرفق"),
  doc_type: z.enum(DOC_TYPES, { errorMap: () => ({ message: "نوع المستند غير معروف" }) }),
  document_number: optText("رقم المستند", 60).optional(),
  issue_date: optDay,
  expiry_date: optDay,
});

export async function registerDocument(employeeId: string, input: unknown, actor: ServiceActor) {
  assertPermission(actor, "hr.private.manage");
  const v = parse(documentInput, input);
  if (v.issue_date && v.expiry_date && v.expiry_date < v.issue_date) throw new ApiError(400, "تاريخ الانتهاء قبل تاريخ الإصدار");
  return inTx(async (tx) => {
    const employee = await employeeOr404(tx, employeeId);
    const att = await tx.attachment.findUnique({ where: { id: v.attachment_id }, select: { id: true, entityType: true, entityId: true, deletedAt: true } });
    if (!att || att.deletedAt || att.entityType !== "employee" || att.entityId !== employeeId) throw new ApiError(400, "المرفق مش من ملف الموظف ده");
    let row;
    try {
      row = await tx.employeeDocument.create({
        data: { attachmentId: att.id, employeeId, docType: v.doc_type, documentNumber: v.document_number ?? null, issueDate: v.issue_date ?? null, expiryDate: v.expiry_date ?? null, createdById: actor.id, createdBy: actor.name },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") throw new ApiError(409, "المرفق ده متسجل بالفعل");
      throw err;
    }
    await audit(tx, actor, "employee_document", row.id, "employee_document_registered", `${employee.code} · ${v.doc_type}${v.expiry_date ? ` · ${v.expiry_date}` : ""}`);
    return row;
  });
}

/** Documents expiring within `days` (or already expired), for the HR reminder list. */
export async function expiringDocuments(actor: ServiceActor, days = 60) {
  assertPermission(actor, "hr.private.view");
  const limit = new Date(Date.now() + days * 86400_000).toISOString().slice(0, 10);
  return prisma.employeeDocument.findMany({
    where: { expiryDate: { not: null, lte: limit }, attachment: { deletedAt: null }, employee: { active: true } },
    orderBy: { expiryDate: "asc" },
    select: { id: true, docType: true, expiryDate: true, employee: { select: { id: true, code: true, name: true } } },
  });
}

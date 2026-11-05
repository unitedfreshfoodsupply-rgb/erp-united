import type { Prisma } from "@prisma/client";
import type { Tx } from "@/lib/tx";

/**
 * What an issued commercial document keeps of the parties (Nov 2026). Master data is the
 * current truth; a draft shows it live. At issue (sales invoice) or posting (supplier bill) the
 * relevant fields are copied into the document's snapshot, in the same UPDATE that freezes the
 * row, so a later change to the company, customer or supplier never rewrites what was issued.
 *
 * Only what the master record holds is copied — nothing is invented. A field the master record
 * does not have stays null and is not printed.
 */

export type CompanySnapshot = {
  code: string;
  legalName: string;
  tradeName: string | null;
  nameAr: string | null;
  legalForm: string | null;
  issuedCapital: string | null;
  taxRegistrationNumber: string | null;
  commercialRegistration: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  bank: { name: string; accountName: string | null; accountNumber: string | null; iban: string | null } | null;
  invoiceTerms: string | null;
};

export type PartySnapshot = {
  id: string;
  code: string;
  name: string;
  nameAr: string | null;
  legalName: string | null;
  taxRegistrationNo: string | null;
  commercialRegNo: string | null;
  address: string | null;
  city: string | null;
  phone: string | null;
  email: string | null;
  paymentTermsDays: number;
};

type CompanyRow = {
  code: string; legalName: string; tradeName: string | null; nameAr: string | null; legalForm?: string | null; issuedCapital?: string | null; taxRegistrationNumber: string | null; commercialRegistration: string | null;
  address: string | null; phone: string | null; email: string | null; bankName: string | null; bankAccountName: string | null; bankAccountNumber: string | null; iban: string | null; invoiceTerms: string | null;
};

const clean = (v: string | null | undefined) => (v && v.trim() ? v.trim() : null);

export function companySnapshot(c: CompanyRow): CompanySnapshot {
  const bankName = clean(c.bankName);
  const accountNumber = clean(c.bankAccountNumber);
  const iban = clean(c.iban);
  return {
    code: c.code,
    legalName: c.legalName,
    tradeName: clean(c.tradeName),
    nameAr: clean(c.nameAr),
    legalForm: clean(c.legalForm),
    issuedCapital: clean(c.issuedCapital),
    taxRegistrationNumber: clean(c.taxRegistrationNumber),
    commercialRegistration: clean(c.commercialRegistration),
    address: clean(c.address),
    phone: clean(c.phone),
    email: clean(c.email),
    // Bank details print only as a whole: a bank and an account to pay into.
    bank: bankName && (accountNumber || iban) ? { name: bankName, accountName: clean(c.bankAccountName), accountNumber, iban } : null,
    invoiceTerms: clean(c.invoiceTerms),
  };
}

/** The company whose details documents print: the first active one (UNITED runs one company). */
export async function documentCompany(db: Pick<Tx, "company">) {
  return db.company.findFirst({ where: { active: true }, orderBy: { createdAt: "asc" } });
}

/**
 * Company fields a commercial document needs and the master record does not have. Each is a
 * configuration gap for an administrator (Admin → Company, Stores & Units), never filled in
 * by the document.
 */
export const COMPANY_DOCUMENT_FIELDS = ["legal_name", "tax_registration_number", "commercial_registration", "address", "legal_form_and_capital", "phone_or_email"] as const;
export type CompanyDocumentGap = (typeof COMPANY_DOCUMENT_FIELDS)[number];

export function companyDocumentGaps(c: CompanySnapshot | null): CompanyDocumentGap[] {
  if (!c) return [...COMPANY_DOCUMENT_FIELDS];
  const gaps: CompanyDocumentGap[] = [];
  if (!clean(c.legalName)) gaps.push("legal_name");
  if (!c.taxRegistrationNumber) gaps.push("tax_registration_number");
  if (!c.commercialRegistration) gaps.push("commercial_registration");
  if (!c.address) gaps.push("address");
  if (!c.legalForm || !c.issuedCapital) gaps.push("legal_form_and_capital");
  if (!c.phone && !c.email) gaps.push("phone_or_email");
  return gaps;
}

type PartyRow = {
  id: string; code: string; name: string; nameAr: string | null; legalName?: string | null; taxRegistrationNo: string | null; commercialRegNo: string | null;
  address: string | null; city: string | null; phone: string | null; email: string | null; paymentTermsDays: number;
};

export function partySnapshot(p: PartyRow): PartySnapshot {
  return {
    id: p.id,
    code: p.code,
    name: p.name,
    nameAr: clean(p.nameAr),
    legalName: clean(p.legalName),
    taxRegistrationNo: clean(p.taxRegistrationNo),
    commercialRegNo: clean(p.commercialRegNo),
    address: clean(p.address),
    city: clean(p.city),
    phone: clean(p.phone),
    email: clean(p.email),
    paymentTermsDays: p.paymentTermsDays,
  };
}

/** Product codes (SKU) by product id, for the lines' snapshot. */
export async function productCodes(db: Pick<Tx, "stockProduct">, ids: (string | null)[]) {
  const wanted = [...new Set(ids.filter((x): x is string => !!x))];
  if (!wanted.length) return new Map<string, string | null>();
  const rows = await db.stockProduct.findMany({ where: { id: { in: wanted } }, select: { id: true, sku: true } });
  return new Map(rows.map((r) => [r.id, clean(r.sku)]));
}

export const asJson = (v: unknown) => v as Prisma.InputJsonValue;

/** The gaps in each print language (the print pages follow `?lang=`, not the app's locale). */
export const COMPANY_GAP_LABELS: Record<"ar" | "en", Record<CompanyDocumentGap, string>> = {
  ar: { legal_name: "الاسم القانوني", tax_registration_number: "رقم التسجيل الضريبي", commercial_registration: "رقم السجل التجاري", address: "العنوان", legal_form_and_capital: "الشكل القانوني ورأس المال المصدر", phone_or_email: "التليفون أو الإيميل" },
  en: { legal_name: "legal name", tax_registration_number: "tax registration number", commercial_registration: "commercial registry number", address: "address", legal_form_and_capital: "legal form and issued capital", phone_or_email: "phone or email" },
};

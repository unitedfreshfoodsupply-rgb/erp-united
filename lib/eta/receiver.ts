import type { AddressSource } from "./types";

/**
 * The e-invoice receiver of a customer, from its canonical master record (Nov 2026).
 *
 * One rule for every reader — the ETA payload, the ETA setup screen and the customer page:
 *  - the customer's ACTIVE linked legal entity owns the receiver type, personal id and the
 *    structured address (it is edited with the customer, under sales.customers.manage);
 *  - the retired per-customer EtaReceiverProfile is read only as a fallback for a customer
 *    with no active legal entity, so data typed there before is not lost; it takes no new edits;
 *  - the name and tax number are not here: they are frozen on the invoice at issue.
 * Pure: no database, no I/O.
 */

export type ReceiverType = "B" | "P" | "F";
export type ReceiverOrigin = "legal_entity" | "eta_profile_legacy" | "none";

/** The address parts ETA requires for a business receiver (and the issuer). */
export const ETA_REQUIRED_ADDRESS = ["country", "governate", "regionCity", "street", "buildingNumber"] as const;
const ADDRESS_KEYS = ["country", "governate", "regionCity", "street", "buildingNumber", "postalCode", "floor", "room", "landmark", "additionalInformation"] as const;

type AddressRow = Partial<Record<keyof AddressSource, string | null>>;
type ReceiverRow = AddressRow & { receiverType?: string | null; receiverId?: string | null };

export type ReceiverInputs = {
  customer: { taxRegistrationNo: string | null };
  legalEntity: (ReceiverRow & { id?: string; active: boolean; taxRegistrationNo?: string | null }) | null;
  legacyProfile: ReceiverRow | null;
};

export type ResolvedReceiver = {
  /** Type as recorded; null = derived from the tax number (B with one, P without). */
  type: ReceiverType | null;
  personalId: string | null;
  address: AddressSource;
  origin: ReceiverOrigin;
};

const clean = (v: string | null | undefined) => {
  const s = typeof v === "string" ? v.trim() : "";
  return s === "" ? null : s;
};
const asType = (v: string | null | undefined): ReceiverType | null => (v === "B" || v === "P" || v === "F" ? v : null);
const addressOf = (row: AddressRow | null): AddressSource =>
  Object.fromEntries(ADDRESS_KEYS.map((k) => [k, clean(row?.[k])])) as AddressSource;

export function resolveEtaReceiver(i: ReceiverInputs): ResolvedReceiver {
  const le = i.legalEntity && i.legalEntity.active ? i.legalEntity : null;
  if (le) return { type: asType(le.receiverType), personalId: clean(le.receiverId), address: addressOf(le), origin: "legal_entity" };
  if (i.legacyProfile) return { type: asType(i.legacyProfile.receiverType), personalId: clean(i.legacyProfile.receiverId), address: addressOf(i.legacyProfile), origin: "eta_profile_legacy" };
  return { type: null, personalId: null, address: addressOf(null), origin: "none" };
}

/** The tax number an invoice of this customer would freeze: the card's, else the active legal entity's. */
export function customerTaxId(i: ReceiverInputs): string | null {
  return clean(i.customer.taxRegistrationNo) ?? (i.legalEntity?.active ? clean(i.legalEntity.taxRegistrationNo) : null);
}

export type ReceiverGap = "tax_registration_no" | "receiver_id" | (typeof ETA_REQUIRED_ADDRESS)[number] | "legal_entity";

/**
 * What the customer record still lacks for an ETA document, field by field. Never fills
 * anything in. `receiver_id` for a person is needed only from the person-id threshold, so it
 * is reported as `personIdOnlyAbove`, not as a gap. A business receiver with no active legal
 * entity cannot hold a structured address in the master record: that is the `legal_entity` gap.
 */
export function receiverGaps(i: ReceiverInputs, r = resolveEtaReceiver(i)) {
  const taxId = customerTaxId(i);
  const effectiveType: ReceiverType = r.type ?? (taxId ? "B" : "P");
  const gaps: ReceiverGap[] = [];
  if (effectiveType === "B") {
    if (!taxId) gaps.push("tax_registration_no");
    if (r.origin !== "legal_entity") gaps.push("legal_entity");
    for (const k of ETA_REQUIRED_ADDRESS) if (!r.address[k]) gaps.push(k);
  } else if (effectiveType === "F") {
    if (r.origin !== "legal_entity") gaps.push("legal_entity");
    if (!r.personalId) gaps.push("receiver_id");
    if (!r.address.country) gaps.push("country");
  }
  return { effectiveType, taxId, gaps, personIdOnlyAbove: effectiveType === "P" && !r.personalId };
}

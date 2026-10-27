import { Prisma } from "@prisma/client";
import type { AddressSource, EtaAddress, EtaDocumentV1, EtaInvoiceLine, EtaParty, EtaSource } from "./types";

/**
 * UNITED invoice → ETA Invoice v1.0 document. Pure: no database, no clock, no network.
 *
 * It sends UNITED's figures exactly as invoiced (the issued invoice is the legal
 * document and is immutable); it never recomputes or "fixes" an amount. Whatever UNITED
 * does not hold is sent as an empty string, and `validateEtaSource` refuses the
 * submission before that can happen — nothing here is invented.
 */

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
/** ETA accepts up to 5 decimals. */
const n5 = (v: Prisma.Decimal.Value) => D(v).toDecimalPlaces(5, Prisma.Decimal.ROUND_HALF_UP).toNumber();

export const ETA_DOCUMENT_VERSION = "1.0" as const;

/** B with a registration number, P without — unless a profile says otherwise. */
export function receiverType(src: EtaSource): "B" | "P" | "F" {
  return src.receiver.type ?? (src.invoice.buyerTaxId ? "B" : "P");
}

function address(a: AddressSource, branchID?: string | null): EtaAddress {
  const out: EtaAddress = {
    ...(branchID !== undefined ? { branchID: branchID ?? "" } : {}),
    country: a.country ?? "",
    governate: a.governate ?? "",
    regionCity: a.regionCity ?? "",
    street: a.street ?? "",
    buildingNumber: a.buildingNumber ?? "",
  };
  for (const k of ["postalCode", "floor", "room", "landmark", "additionalInformation"] as const) if (a[k]) out[k] = a[k]!;
  return out;
}

/** "2026-10-08T09:30:00Z" — UTC, no milliseconds. */
export function etaDateTime(iso: string) {
  return new Date(iso).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function mapInvoiceToEta(src: EtaSource): EtaDocumentV1 {
  const type = receiverType(src);
  const receiver: EtaParty = {
    type,
    id: type === "B" ? src.invoice.buyerTaxId ?? "" : src.receiver.personalId ?? "",
    name: src.invoice.buyerName ?? "",
    address: address(src.receiver.address),
  };
  const issuer: EtaParty = {
    type: "B",
    id: src.issuer.registrationNumber ?? "",
    name: src.issuer.name ?? "",
    address: address(src.issuer.address, src.issuer.etaBranchId),
  };

  const lines: EtaInvoiceLine[] = src.lines.map((l) => ({
    description: l.description,
    itemType: (l.itemType ?? "") as EtaInvoiceLine["itemType"],
    itemCode: l.itemCode ?? "",
    unitType: l.etaUnitType ?? "",
    quantity: n5(l.quantity),
    internalCode: l.internalCode ?? "",
    salesTotal: n5(l.gross),
    total: n5(l.total),
    valueDifference: 0,
    totalTaxableFees: 0,
    netTotal: n5(l.net),
    itemsDiscount: 0,
    unitValue: { currencySold: src.invoice.currencyCode, amountEGP: n5(l.unitPrice) },
    discount: { rate: n5(l.discountPct), amount: n5(l.discount) },
    // An exempt or zero-rated line still carries its classification, at amount 0.
    taxableItems: [{ taxType: l.etaTaxType ?? "", amount: n5(l.tax), subType: l.etaTaxSubtype ?? "", rate: n5(l.taxRate) }],
  }));

  const taxTotals = new Map<string, Prisma.Decimal>();
  for (const l of src.lines) {
    const t = l.etaTaxType ?? "";
    taxTotals.set(t, (taxTotals.get(t) ?? D(0)).plus(l.tax));
  }

  return {
    issuer,
    receiver,
    documentType: src.kind === "credit_note" ? "c" : "i",
    documentTypeVersion: ETA_DOCUMENT_VERSION,
    dateTimeIssued: src.invoice.issuedAt ? etaDateTime(src.invoice.issuedAt) : "",
    taxpayerActivityCode: src.issuer.activityCode ?? "",
    internalID: src.invoice.number ?? "",
    ...(src.invoice.orderNumber ? { salesOrderReference: src.invoice.orderNumber } : {}),
    invoiceLines: lines,
    totalDiscountAmount: n5(src.invoice.discountTotal),
    totalSalesAmount: n5(src.invoice.gross),
    netAmount: n5(src.invoice.net),
    taxTotals: [...taxTotals].map(([taxType, amount]) => ({ taxType, amount: n5(amount) })),
    totalAmount: n5(src.invoice.total),
    extraDiscountAmount: 0,
    totalItemsDiscountAmount: 0,
    ...(src.kind === "credit_note" ? { references: src.references ?? [] } : {}),
  };
}
